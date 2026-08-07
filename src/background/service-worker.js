/*
 * Tvarin background service worker (Manifest V3).
 *
 * Jobs:
 *   - open Options on first install
 *   - Google sign-in / sign-out (PKCE via chrome.identity → Supabase)
 *   - forward AI draft + match requests to Supabase Edge Functions
 *     using the signed-in user's token. Provider keys stay server-side.
 */

importScripts(chrome.runtime.getURL("src/lib/supabase-config.js"));
importScripts(chrome.runtime.getURL("src/lib/vault-crypto.js"));

const KEYS = {
  profile: "tvarin.profile",
  ai: "tvarin.ai", // { resumeText }
  session: "tvarin.session", // { access_token, refresh_token, expires_at, email }
  applications: "tvarin.applications",
  // IDs we've successfully pushed at least once. Needed so "missing from
  // server" means "deleted on the dashboard" — not "never uploaded yet".
  syncedIds: "tvarin.syncedAppIds",
  // Saved logins. Each entry: { id, origin, label, username, iv, ct,
  // createdAt, updatedAt, lastUsedAt }. `iv`/`ct` are the device-key-encrypted
  // password (see src/lib/vault-crypto.js) — never the plaintext.
  credentials: "tvarin.credentials",
};

const DRAFT_ENDPOINT = `${SUPABASE_URL}/functions/v1/draft`;
const MATCH_ENDPOINT = `${SUPABASE_URL}/functions/v1/match`;
const TOKEN_ENDPOINT = `${SUPABASE_URL}/auth/v1/token`;
const AUTHORIZE_ENDPOINT = `${SUPABASE_URL}/auth/v1/authorize`;
const APPLICATIONS_ENDPOINT = `${SUPABASE_URL}/rest/v1/applications`;

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});

/* ----- Google sign-in (PKCE) ----- */

function base64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return base64url(arr.buffer);
}

async function sha256Base64Url(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return base64url(digest);
}

async function getSession() {
  const res = await get(KEYS.session);
  const session = res[KEYS.session] || null;
  if (!session || !session.access_token) return null;
  return {
    email: session.email || "",
    expires_at: session.expires_at || null,
    signedIn: true,
  };
}

async function signInWithGoogle() {
  const redirectTo = chrome.identity.getRedirectURL();
  const verifier = randomVerifier();
  const codeChallenge = await sha256Base64Url(verifier);
  const authUrl =
    `${AUTHORIZE_ENDPOINT}?provider=google` +
    `&redirect_to=${encodeURIComponent(redirectTo)}` +
    `&code_challenge=${codeChallenge}&code_challenge_method=s256`;

  const redirect = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });

  const u = new URL(redirect);
  const err = u.searchParams.get("error_description") || u.searchParams.get("error");
  if (err) throw new Error(err);
  const code = u.searchParams.get("code");
  if (!code) throw new Error("No authorization code returned.");

  const res = await fetch(`${TOKEN_ENDPOINT}?grant_type=pkce`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  if (!res.ok) {
    let m = String(res.status);
    try {
      const j = await res.json();
      m = j.error_description || j.msg || j.error || m;
    } catch (_) {}
    throw new Error("Sign-in failed: " + m);
  }
  const s = await res.json();
  const session = {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: s.expires_at || Date.now() / 1000 + (s.expires_in || 3600),
    email: (s.user && s.user.email) || "",
  };
  await set({ [KEYS.session]: session });
  return { email: session.email, signedIn: true };
}

async function signOut() {
  await new Promise((resolve) => chrome.storage.local.remove(KEYS.session, resolve));
  return { signedIn: false };
}

// Toolbar icon toggles the in-page sidebar (no default_popup).
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  if (tab.url && /^(chrome|chrome-extension|devtools|edge|about):/i.test(tab.url)) {
    return;
  }

  const ping = async () => {
    try {
      return await chrome.tabs.sendMessage(tab.id, { type: "TVARIN_PING" });
    } catch (_) {
      return null;
    }
  };

  const toggle = async () => {
    return chrome.tabs.sendMessage(tab.id, { type: "TVARIN_TOGGLE_SIDEBAR" });
  };

  const inject = async () => {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [
        "src/content/content.js",
        "src/sidebar/sidebar.js",
        "src/sidebar/profile-modal.js",
      ],
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["src/content/content.css"],
    });
  };

  try {
    let alive = await ping();
    if (!alive || !alive.ok) {
      await inject();
      alive = await ping();
    }
    if (!alive || !alive.ok) return;
    await toggle();
  } catch (_) {
    try {
      await inject();
      await toggle();
    } catch (__) {
      /* ignore — restricted page or missing permission */
    }
  }
});

function get(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function set(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

// Return a valid access token, refreshing it if it's expired/near expiry.
async function validAccessToken(session) {
  if (!session || !session.refresh_token) return null;
  const now = Date.now() / 1000;
  if (session.access_token && session.expires_at && session.expires_at - now > 60) {
    return session.access_token;
  }
  // Refresh.
  let res;
  try {
    res = await fetch(`${TOKEN_ENDPOINT}?grant_type=refresh_token`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
  } catch (_) {
    return null;
  }
  if (!res.ok) return null;
  const s = await res.json();
  const updated = {
    access_token: s.access_token,
    refresh_token: s.refresh_token || session.refresh_token,
    expires_at: s.expires_at || now + (s.expires_in || 3600),
    email: (s.user && s.user.email) || session.email || "",
  };
  await set({ [KEYS.session]: updated });
  return updated.access_token;
}

async function draftAnswer({ question, jobContext }) {
  const data = await get([KEYS.session, KEYS.ai, KEYS.profile]);
  const session = data[KEYS.session];
  const ai = data[KEYS.ai] || {};
  const profile = data[KEYS.profile] || {};

  if (!session || !session.access_token) {
    return {
      error: "Sign in first — open the sidebar → Profile → AI answers.",
      needsAuth: true,
    };
  }
  const token = await validAccessToken(session);
  if (!token) {
    return { error: "Your session expired — sign in again in Options.", needsAuth: true };
  }

  // Package a richer applicant dossier for the model.
  const applicant = {
    personal: {
      firstName: profile.firstName || "",
      lastName: profile.lastName || "",
      email: profile.email || "",
      phone: [profile.phoneCountryCode, profile.phone].filter(Boolean).join(" "),
      location: [profile.city, profile.state, profile.country].filter(Boolean).join(", "),
      address: profile.addressLine1 || "",
    },
    links: {
      linkedin: profile.linkedin || "",
      github: profile.github || "",
      portfolio: profile.portfolio || "",
    },
    about: profile.about || "",
    experience: profile.experience || "",
    projects: profile.projects || "",
    skills: profile.skills || "",
    resumeText: ai.resumeText || "",
  };

  const hasSubstance =
    applicant.resumeText ||
    applicant.about ||
    applicant.experience ||
    applicant.projects ||
    applicant.skills ||
    applicant.links.github ||
    applicant.links.portfolio ||
    applicant.links.linkedin;

  if (!hasSubstance) {
    return {
      error:
        "Add resume text, work experience, or projects in Profile so drafts can be specific.",
    };
  }

  let res;
  try {
    res = await fetch(DRAFT_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        question,
        jobContext: jobContext || {},
        profile,
        applicant,
        resumeText: applicant.resumeText,
      }),
    });
  } catch (_) {
    return { error: "Couldn't reach the Tvarin server. Check your connection." };
  }

  let json = {};
  try {
    json = await res.json();
  } catch (_) {}

  if (res.status === 402 || json.limitReached) {
    return { error: json.error || "You've used your free drafts this month.", limitReached: true };
  }
  if (res.status === 401) {
    return { error: "Sign in again in Options → AI answers.", needsAuth: true };
  }
  if (!res.ok) {
    return { error: json.error || `Server error (${res.status}).` };
  }
  return json.text
    ? { text: json.text, used: json.used, limit: json.limit }
    : { error: json.error || "No answer produced. Try again." };
}

// Resume ↔ job match analysis (see the "match" Edge Function).
async function matchJob({ jobTitle, jobDescription }) {
  const data = await get([KEYS.session, KEYS.ai, KEYS.profile]);
  const session = data[KEYS.session];
  const ai = data[KEYS.ai] || {};
  const profile = data[KEYS.profile] || {};

  if (!session || !session.access_token) {
    return { error: "Sign in first (sidebar → Profile → AI answers).", needsAuth: true };
  }
  const token = await validAccessToken(session);
  if (!token) return { error: "Your session expired — sign in again.", needsAuth: true };

  let res;
  try {
    res = await fetch(MATCH_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jobTitle, jobDescription, profile, resumeText: ai.resumeText }),
    });
  } catch (_) {
    return { error: "Couldn't reach the Tvarin server. Check your connection." };
  }

  let json = {};
  try {
    json = await res.json();
  } catch (_) {}
  if (res.status === 401) return { error: "Sign in again in Profile → AI answers.", needsAuth: true };
  if (!res.ok) return { error: json.error || `Server error (${res.status}).` };
  return json;
}

/* ----- Two-way sync: extension ↔ Supabase (hosted dashboard) -----
 *
 * Pull server rows, merge with local, push the result.
 * - Status edits: whichever side has the newer updatedAt wins.
 * - Deletes on the dashboard: if an id was previously synced and is now
 *   missing from the server, drop it locally (don't resurrect it).
 * - New local fills (never synced): keep and push.
 */

let syncTimer = null;
let syncInFlight = null;
let suppressSync = false; // set while WE write local storage, to avoid a sync loop

function scheduleSync(delay = 1500) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncApplications();
  }, delay);
}

function newAppId(seed) {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${seed || Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toMs(t) {
  if (typeof t === "number" && Number.isFinite(t)) return t;
  if (!t) return 0;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : 0;
}

function localUpdated(a) {
  return toMs(a.updatedAt || a.appliedAt || a.timestamp);
}

// Abandoned "started" fills (filled but never submitted) are cleaned up after
// this long so the tracker and dashboard don't accumulate half-finished rows.
// Anything promoted to "applied" (or beyond) is kept forever.
const STARTED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function isStaleStarted(a, now) {
  if (!a || (a.status || "started") !== "started") return false;
  const ts = localUpdated(a);
  // Guard rows with unknown age (ts === 0): never expire what we can't date.
  return ts > 0 && now - ts > STARTED_TTL_MS;
}

function isJunkApp(a) {
  const hay = `${a.hostname || ""} ${a.jobTitle || ""} ${a.url || ""}`;
  return /recaptcha|googleapis\.com|gstatic\.com/i.test(hay);
}

function localFromServer(row) {
  const updatedAt = toMs(row.updated_at) || toMs(row.created_at) || Date.now();
  const createdAt = toMs(row.created_at) || updatedAt;
  const status = row.status || "started";
  return {
    id: row.id,
    url: row.url || "",
    hostname: row.hostname || "",
    jobTitle: row.job_title || "",
    company: row.company || "",
    jobDescription: row.job_description || "",
    ats: row.ats || "",
    status,
    filled: typeof row.filled === "number" ? row.filled : undefined,
    resumeAttached:
      typeof row.resume_attached === "boolean" ? row.resume_attached : undefined,
    timestamp: createdAt,
    appliedAt: status !== "started" ? updatedAt : undefined,
    updatedAt,
  };
}

function serverFromLocal(a) {
  const iso = (t) => new Date(toMs(t) || Date.now()).toISOString();
  return {
    id: a.id,
    url: a.url || null,
    hostname: a.hostname || null,
    job_title: a.jobTitle || null,
    company: a.company || null,
    job_description: a.jobDescription || null,
    ats: a.ats || null,
    status: a.status || "started",
    filled: typeof a.filled === "number" ? a.filled : null,
    resume_attached: typeof a.resumeAttached === "boolean" ? a.resumeAttached : null,
    created_at: iso(a.timestamp),
    updated_at: iso(a.updatedAt || a.appliedAt || a.timestamp),
  };
}

async function syncApplications() {
  // Coalesce overlapping syncs into one in-flight run.
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const data = await get([KEYS.session, KEYS.applications, KEYS.syncedIds]);
    const session = data[KEYS.session];
    if (!session || !session.access_token) return;
    const token = await validAccessToken(session);
    if (!token) return;

    const headers = {
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${token}`,
    };

    // 1. Pull current server state.
    let serverRows = [];
    try {
      const pull = await fetch(
        `${APPLICATIONS_ENDPOINT}?select=*&order=updated_at.desc`,
        { headers }
      );
      if (!pull.ok) {
        const detail = await pull.text().catch(() => "");
        console.warn(`[Tvarin] applications pull failed: ${pull.status} — ${detail}`);
        return;
      }
      const body = await pull.json();
      serverRows = Array.isArray(body) ? body : [];
    } catch (e) {
      console.warn("[Tvarin] applications pull network error:", e && e.message);
      return;
    }

    // 2. Prepare local: assign stable ids, drop iframe junk.
    let localApps = (data[KEYS.applications] || [])
      .filter((a) => a && !isJunkApp(a))
      .map((a) => (a.id ? a : { ...a, id: newAppId(a.timestamp) }));

    // 2b. Expire abandoned "started" rows (never promoted to "applied") past the
    //     TTL — delete them server-side and drop them locally BEFORE the merge,
    //     otherwise a still-present server row would be merged straight back.
    const now = Date.now();
    const staleServerIds = serverRows
      .filter((r) => isStaleStarted(localFromServer(r), now))
      .map((r) => r.id);
    if (staleServerIds.length) {
      try {
        // status=eq.started guards against deleting a row a dashboard edit
        // promoted between our pull and this delete.
        await fetch(
          `${APPLICATIONS_ENDPOINT}?id=in.(${staleServerIds.join(",")})&status=eq.started`,
          { method: "DELETE", headers }
        );
      } catch (e) {
        console.warn("[Tvarin] expire delete network error:", e && e.message);
      }
      const stale = new Set(staleServerIds);
      serverRows = serverRows.filter((r) => !stale.has(r.id));
    }
    localApps = localApps.filter((a) => !isStaleStarted(a, now));

    const syncedIds = new Set(data[KEYS.syncedIds] || []);
    const serverById = new Map(serverRows.map((r) => [r.id, r]));
    const localById = new Map(localApps.map((a) => [a.id, a]));

    // 3. Merge.
    //    - Server row exists → keep newer of (server, local) by updatedAt.
    //    - Local id previously synced but gone from server → deleted on dashboard.
    //    - Local id never synced → keep and push.
    const merged = [];
    const seen = new Set();

    for (const row of serverRows) {
      if (isJunkApp(localFromServer(row))) continue;
      const local = localById.get(row.id);
      const fromServer = localFromServer(row);
      if (local && localUpdated(local) > localUpdated(fromServer)) {
        merged.push(local);
      } else {
        merged.push(fromServer);
      }
      seen.add(row.id);
    }

    let droppedDeleted = 0;
    for (const a of localApps) {
      if (seen.has(a.id)) continue;
      if (syncedIds.has(a.id) && !serverById.has(a.id)) {
        droppedDeleted++;
        continue; // deleted on the dashboard — don't resurrect
      }
      merged.push(a); // new local fill, not yet on server
      seen.add(a.id);
    }

    // Cap and write local (suppress the onChanged → sync loop).
    const nextLocal = merged.slice(0, 500);
    const keptIds = new Set(nextLocal.map((a) => a.id).filter(Boolean));
    // Immediately drop deleted ids from the synced set. Don't mark brand-new
    // local fills as synced until the push below succeeds.
    const prunedSynced = [...syncedIds].filter((id) => keptIds.has(id));

    suppressSync = true;
    await set({
      [KEYS.applications]: nextLocal,
      [KEYS.syncedIds]: prunedSynced,
    });
    suppressSync = false;

    // 4. Push the merged set (upsert). Skip if nothing to push.
    if (!nextLocal.length) {
      if (droppedDeleted) {
        console.log(`[Tvarin] sync: dropped ${droppedDeleted} dashboard-deleted app(s).`);
      }
      return;
    }

    try {
      const res = await fetch(`${APPLICATIONS_ENDPOINT}?on_conflict=id`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(nextLocal.map(serverFromLocal)),
      });
      if (res.ok) {
        suppressSync = true;
        await set({ [KEYS.syncedIds]: [...keptIds] });
        suppressSync = false;
        console.log(
          `[Tvarin] two-way sync ok: ${nextLocal.length} app(s)` +
            (droppedDeleted ? `, dropped ${droppedDeleted} deleted` : "") +
            "."
        );
      } else {
        const detail = await res.text().catch(() => "");
        console.warn(`[Tvarin] applications push failed: ${res.status} — ${detail}`);
      }
    } catch (e) {
      console.warn("[Tvarin] applications push network error:", e && e.message);
    }
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

// Sync whenever the local applications list changes (debounced).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || suppressSync) return;
  if (changes[KEYS.applications]) scheduleSync();
});

/* ----- Saved logins (device-key-encrypted password vault) -----
 *
 * The service worker is the single extension-context owner of the vault:
 * the device key lives in the extension's IndexedDB, and passwords are only
 * ever decrypted here, in response to a message, and handed to the content
 * script for the one field it's about to fill.
 */

function credId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `cred-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Normalise a hostname to a stable match key (drop leading www.).
function credHost(hostname) {
  return String(hostname || "").replace(/^www\./i, "").toLowerCase();
}

// Registrable-ish base domain (last two labels). Good enough to let a saved
// login for careers.acme.com fill on jobs.acme.com; multi-part TLDs
// (foo.co.uk) fall back to exact-host matching, which is still correct.
function baseDomain(host) {
  const parts = credHost(host).split(".");
  return parts.length <= 2 ? credHost(host) : parts.slice(-2).join(".");
}

function credMatches(entry, host) {
  const a = credHost(entry.origin);
  const b = credHost(host);
  return a === b || baseDomain(a) === baseDomain(b);
}

async function getCredentials() {
  const data = await get(KEYS.credentials);
  const list = data[KEYS.credentials];
  return Array.isArray(list) ? list : [];
}

// Public list: metadata only, never the password. For the Options manager.
async function listCredentials() {
  const list = await getCredentials();
  return list
    .map(({ id, origin, label, username, createdAt, updatedAt, lastUsedAt }) => ({
      id,
      origin,
      label,
      username,
      createdAt,
      updatedAt,
      lastUsedAt,
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// Logins that match a page host, WITH decrypted passwords, for autofill.
// Most-recently-used first so the caller can pick the best default.
async function matchCredentials(host) {
  if (!host) return [];
  const list = await getCredentials();
  const hits = list
    .filter((e) => credMatches(e, host))
    .sort((x, y) => (y.lastUsedAt || y.updatedAt || 0) - (x.lastUsedAt || x.updatedAt || 0));
  const out = [];
  for (const e of hits) {
    let password;
    try {
      password = await TvarinVault.decrypt({ iv: e.iv, ct: e.ct });
    } catch (_) {
      continue; // key rotated / corrupt entry — skip rather than fail the batch
    }
    out.push({ id: e.id, origin: e.origin, label: e.label, username: e.username, password });
  }
  return out;
}

// Reveal one password (Options "show"/copy). Kept separate from listing so
// the plaintext is only produced on explicit, per-item request.
async function revealCredential(id) {
  const list = await getCredentials();
  const e = list.find((x) => x.id === id);
  if (!e) return { error: "Not found." };
  try {
    return { password: await TvarinVault.decrypt({ iv: e.iv, ct: e.ct }) };
  } catch (_) {
    return { error: "Couldn't decrypt on this device." };
  }
}

// Save or update a login. Matches an existing entry by (host, username) so
// re-saving after a password change updates in place instead of duplicating.
async function saveCredential({ origin, label, username, password }) {
  origin = credHost(origin);
  username = String(username || "").trim();
  if (!origin || !password) return { error: "Nothing to save." };

  const enc = await TvarinVault.encrypt(password);
  const list = await getCredentials();
  const now = Date.now();
  const idx = list.findIndex(
    (e) => credHost(e.origin) === origin && (e.username || "") === username
  );

  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      label: label || list[idx].label || origin,
      username,
      iv: enc.iv,
      ct: enc.ct,
      updatedAt: now,
    };
    await set({ [KEYS.credentials]: list });
    return { ok: true, id: list[idx].id, updated: true };
  }

  const entry = {
    id: credId(),
    origin,
    label: label || origin,
    username,
    iv: enc.iv,
    ct: enc.ct,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: 0,
  };
  list.push(entry);
  await set({ [KEYS.credentials]: list });
  return { ok: true, id: entry.id, updated: false };
}

async function deleteCredential(id) {
  const list = await getCredentials();
  const next = list.filter((e) => e.id !== id);
  await set({ [KEYS.credentials]: next });
  return { ok: true };
}

// Note that an entry was just used for autofill (drives most-recent ordering).
async function touchCredential(id) {
  const list = await getCredentials();
  const e = list.find((x) => x.id === id);
  if (!e) return { ok: false };
  e.lastUsedAt = Date.now();
  await set({ [KEYS.credentials]: list });
  return { ok: true };
}

/* ----- Pending save (survives the login page's navigation) -----
 *
 * When the user submits a login/signup we stash the candidate in
 * chrome.storage.session — in-memory, never written to disk, cleared when the
 * browser closes — so the "save this login?" prompt can appear on the page we
 * land on next. The plaintext password stays in the background: the content
 * script is told only the host/username and asks us to commit the save.
 */

const PENDING_KEY = "tvarin.pendingSave";

function sessionGet(key) {
  return new Promise((resolve) => chrome.storage.session.get(key, resolve));
}
function sessionSet(obj) {
  return new Promise((resolve) => chrome.storage.session.set(obj, resolve));
}
function sessionRemove(key) {
  return new Promise((resolve) => chrome.storage.session.remove(key, resolve));
}

async function stashPendingSave({ origin, username, password, kind }) {
  if (!password) return { ok: false };
  await sessionSet({
    [PENDING_KEY]: {
      origin: credHost(origin),
      username: String(username || "").trim(),
      password,
      kind: kind || "login",
      ts: Date.now(),
    },
  });
  return { ok: true };
}

// Report a pending save for this host WITHOUT returning the password, and only
// if an identical login isn't already saved.
async function getPendingSave(host) {
  const res = await sessionGet(PENDING_KEY);
  const p = res[PENDING_KEY];
  if (!p) return { pending: null };
  if (host && !credMatches({ origin: p.origin }, host)) return { pending: null };

  const list = await getCredentials();
  for (const e of list) {
    if (credHost(e.origin) === credHost(p.origin) && (e.username || "") === p.username) {
      try {
        if ((await TvarinVault.decrypt({ iv: e.iv, ct: e.ct })) === p.password) {
          await sessionRemove(PENDING_KEY); // already saved, nothing to offer
          return { pending: null };
        }
      } catch (_) {}
    }
  }
  return { pending: { origin: p.origin, username: p.username, kind: p.kind } };
}

async function commitPendingSave() {
  const res = await sessionGet(PENDING_KEY);
  const p = res[PENDING_KEY];
  if (!p) return { error: "Nothing to save." };
  const out = await saveCredential({
    origin: p.origin,
    label: p.origin,
    username: p.username,
    password: p.password,
  });
  await sessionRemove(PENDING_KEY);
  return out;
}

// Strong random password for signups. Ambiguous-looking chars left out.
function generatePassword(length = 20) {
  const sets = {
    lower: "abcdefghijkmnpqrstuvwxyz",
    upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
    digit: "23456789",
    sym: "!@#$%^&*-_=+?",
  };
  const all = sets.lower + sets.upper + sets.digit + sets.sym;
  const pick = (chars) => chars[crypto.getRandomValues(new Uint32Array(1))[0] % chars.length];
  const n = Math.max(12, Math.min(64, length));
  // Guarantee one of each class, then fill the rest, then shuffle.
  const out = [pick(sets.lower), pick(sets.upper), pick(sets.digit), pick(sets.sym)];
  while (out.length < n) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "TVARIN_OPEN_DASHBOARD") {
    scheduleSync(0); // flush latest before the dashboard loads
    chrome.tabs.create({ url: DASHBOARD_URL });
    sendResponse({ ok: true });
    return;
  }
  if (msg && msg.type === "TVARIN_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return;
  }
  if (msg && msg.type === "TVARIN_GET_SESSION") {
    getSession()
      .then((session) => sendResponse({ ok: true, session }))
      .catch((e) => sendResponse({ ok: false, error: e && e.message }));
    return true;
  }
  if (msg && msg.type === "TVARIN_SIGN_IN") {
    signInWithGoogle()
      .then((session) => {
        scheduleSync(500); // push any local applications now that we're signed in
        sendResponse({ ok: true, session });
      })
      .catch((e) =>
        sendResponse({
          ok: false,
          error: (e && e.message) || "Sign-in was cancelled.",
        })
      );
    return true;
  }
  if (msg && msg.type === "TVARIN_SIGN_OUT") {
    signOut()
      .then((session) => sendResponse({ ok: true, session }))
      .catch((e) => sendResponse({ ok: false, error: e && e.message }));
    return true;
  }
  if (msg && msg.type === "TVARIN_OPEN_RESUME") {
    chrome.storage.local.get("tvarin.resume", (res) => {
      const resume = res["tvarin.resume"];
      if (resume && resume.dataUrl) {
        chrome.tabs.create({
          url: chrome.runtime.getURL("src/resume-viewer/viewer.html"),
        });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "No resume saved." });
      }
    });
    return true;
  }
  if (msg && msg.type === "TVARIN_AI_DRAFT") {
    draftAnswer(msg).then(sendResponse);
    return true; // async response
  }
  if (msg && msg.type === "TVARIN_MATCH") {
    matchJob(msg).then(sendResponse);
    return true; // async response
  }

  /* ----- Saved logins ----- */
  if (msg && msg.type === "TVARIN_CRED_MATCH") {
    matchCredentials(msg.host)
      .then((credentials) => sendResponse({ ok: true, credentials }))
      .catch((e) => sendResponse({ ok: false, error: e && e.message }));
    return true;
  }
  if (msg && msg.type === "TVARIN_CRED_SAVE") {
    saveCredential(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: (e && e.message) || "Save failed." }));
    return true;
  }
  if (msg && msg.type === "TVARIN_CRED_LIST") {
    listCredentials()
      .then((credentials) => sendResponse({ ok: true, credentials }))
      .catch((e) => sendResponse({ ok: false, error: e && e.message }));
    return true;
  }
  if (msg && msg.type === "TVARIN_CRED_REVEAL") {
    revealCredential(msg.id).then(sendResponse);
    return true;
  }
  if (msg && msg.type === "TVARIN_CRED_DELETE") {
    deleteCredential(msg.id).then(sendResponse);
    return true;
  }
  if (msg && msg.type === "TVARIN_CRED_TOUCH") {
    touchCredential(msg.id).then(sendResponse);
    return true;
  }
  if (msg && msg.type === "TVARIN_CRED_GENERATE") {
    sendResponse({ ok: true, password: generatePassword(msg.length) });
    return; // sync
  }
  if (msg && msg.type === "TVARIN_CRED_STASH") {
    stashPendingSave(msg).then(sendResponse);
    return true;
  }
  if (msg && msg.type === "TVARIN_CRED_PENDING") {
    getPendingSave(msg.host).then(sendResponse);
    return true;
  }
  if (msg && msg.type === "TVARIN_CRED_COMMIT_PENDING") {
    commitPendingSave().then(sendResponse);
    return true;
  }
  if (msg && msg.type === "TVARIN_CRED_PENDING_CLEAR") {
    sessionRemove(PENDING_KEY).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// Signed-out hygiene: with no server to sync against, expire abandoned "started"
// rows locally. Signed-in users get this inside syncApplications (which also
// deletes them server-side), so skip it there to avoid fighting the merge.
async function pruneStaleStartedLocal() {
  const data = await get([KEYS.session, KEYS.applications]);
  const session = data[KEYS.session];
  if (session && session.access_token) return; // signed in → sync owns expiry
  const list = data[KEYS.applications] || [];
  const now = Date.now();
  const kept = list.filter((a) => !isStaleStarted(a, now));
  if (kept.length !== list.length) {
    await set({ [KEYS.applications]: kept });
    console.log(`[Tvarin] expired ${list.length - kept.length} stale 'started' app(s) locally.`);
  }
}

// Catch-up sync shortly after the worker wakes (covers apps logged while offline).
pruneStaleStartedLocal();
scheduleSync(4000);

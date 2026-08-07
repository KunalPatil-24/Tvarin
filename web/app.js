/*
 * Tvarin dashboard — reads the applications the extension synced to Supabase.
 * Plain static app: Supabase Google auth + read/update/delete of own rows (RLS).
 * The anon key is public; RLS scopes every query to the signed-in user.
 */
const SUPABASE_URL = "https://ftoadktwfffrqmktusgl.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ0b2Fka3R3ZmZmcnFta3R1c2dsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3NDU3MTIsImV4cCI6MjEwMTMyMTcxMn0.s8kDaSg7jQjqlAY4ErgmaNqkivaXhwFU2eD9B-Xu2Bg";

const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const STAGES = [
  ["started", "Saved"],
  ["applied", "Applied"],
  ["interviewing", "Interviewing"],
  ["offer", "Offer"],
  ["rejected", "Rejected"],
];
const STAGE_LABEL = Object.fromEntries(STAGES);

const $ = (sel) => document.querySelector(sel);
const el = (name) => document.querySelector(`[data-el="${name}"]`);

let apps = [];
let filter = "all";

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}
function fmtDate(iso) {
  const t = new Date(iso).getTime();
  if (!t) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Deterministic flat color for a company avatar based on its name.
const AVATAR_COLORS = [
  "#2f6fed", "#0ea5e9", "#059669", "#b45309",
  "#dc2626", "#7c3aed", "#0891b2", "#db2777",
];
function avatarFor(name) {
  const s = String(name || "?").trim();
  const initial = s ? s[0].toUpperCase() : "?";
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  const color = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  return { initial, style: `background:${color}` };
}

// Chevron shown inside the status pill; color follows the pill text color.
function statusBg(color) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='${color}' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9l6 6 6-6'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
const STATUS_COLORS = {
  started: "#64748b",
  applied: "#2f6fed",
  interviewing: "#b45309",
  offer: "#059669",
  rejected: "#dc2626",
};

async function init() {
  const { data } = await client.auth.getSession();
  render(data && data.session);
  client.auth.onAuthStateChange((_e, session) => render(session));

  el("signin").addEventListener("click", async () => {
    await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href.split("#")[0].split("?")[0] },
    });
  });

  el("overlay").addEventListener("click", closeDetail);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
  });
}

async function render(session) {
  el("loading").hidden = true;
  const userBox = el("user");

  if (!session) {
    el("signed-out").hidden = false;
    el("signed-in").hidden = true;
    userBox.innerHTML = "";
    return;
  }

  el("signed-out").hidden = true;
  el("signed-in").hidden = false;
  const email = session.user && session.user.email ? session.user.email : "";
  const av = avatarFor(email || "?");
  userBox.innerHTML =
    `<span class="user__id"><span class="avatar" style="${av.style}">${esc(av.initial)}</span>` +
    `<span class="user__email">${esc(email)}</span></span>` +
    `<button class="btn" id="signout">Sign out</button>`;
  $("#signout").addEventListener("click", async () => {
    await client.auth.signOut();
  });

  await loadApps();
}

async function loadApps() {
  const { data, error } = await client
    .from("applications")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) {
    el("rows").innerHTML = "";
    el("empty").hidden = false;
    el("empty").textContent = "Couldn't load your applications. Try refreshing.";
    return;
  }
  apps = data || [];
  renderStats();
  renderFilters();
  renderRows();
}

function renderStats() {
  const submitted = apps.filter((a) => (a.status || "started") !== "started");
  const responses = apps.filter((a) => a.status === "interviewing" || a.status === "offer");
  const offers = apps.filter((a) => a.status === "offer");
  const rate = submitted.length ? Math.round((100 * responses.length) / submitted.length) : 0;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const thisWeek = submitted.filter((a) => new Date(a.updated_at).getTime() >= weekAgo).length;

  const ICONS = {
    track: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v16"/></svg>`,
    applied: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>`,
    rate: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/></svg>`,
    offer: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15a7 7 0 1 0 0-14 7 7 0 0 0 0 14z"/><path d="M8.2 13.8 7 22l5-3 5 3-1.2-8.2"/></svg>`,
  };
  const tile = (key, cls, num, label) =>
    `<div class="stat"><div class="stat__ico ${cls}">${ICONS[key]}</div>` +
    `<div class="stat__num">${num}</div><div class="stat__label">${label}</div></div>`;
  el("stats").innerHTML =
    tile("track", "i-track", apps.length, "Tracked") +
    tile("applied", "i-applied", submitted.length, "Applied") +
    tile("rate", "i-rate", `${rate}%`, "Response rate") +
    tile("offer", "i-offer", offers.length, "Offers");

  // Stage distribution bar + legend.
  const bar = el("bar");
  if (!apps.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const counts = STAGES.map(([k]) => [k, apps.filter((a) => (a.status || "started") === k).length]);
  const segs = counts
    .map(([k, n]) => {
      const pct = (100 * n) / apps.length;
      return pct ? `<span class="seg--${k}" style="width:${pct}%" title="${STAGE_LABEL[k]}: ${n}"></span>` : "";
    })
    .join("");
  const legend = counts
    .filter(([, n]) => n)
    .map(([k, n]) => `<span><i class="seg--${k}"></i>${STAGE_LABEL[k]} · ${n}</span>`)
    .join("");
  bar.innerHTML = `<div class="bar">${segs}</div><div class="legend">${legend}</div>`;
}

function renderFilters() {
  const count = (k) => apps.filter((a) => (a.status || "started") === k).length;
  const chips = [["all", `All ${apps.length}`]].concat(
    STAGES.map(([k, label]) => [k, `${label} ${count(k)}`])
  );
  el("filters").innerHTML = chips
    .map(([k, label]) => `<button class="chip${filter === k ? " is-active" : ""}" data-filter="${k}">${esc(label)}</button>`)
    .join("");
  el("filters").querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      filter = btn.getAttribute("data-filter");
      renderFilters();
      renderRows();
    });
  });
}

function renderRows() {
  const rows = el("rows");
  const list = filter === "all" ? apps : apps.filter((a) => (a.status || "started") === filter);

  if (!apps.length) {
    rows.innerHTML = "";
    el("empty").hidden = false;
    return;
  }
  el("empty").hidden = true;

  rows.innerHTML = list
    .map((a) => {
      const status = a.status || "started";
      const company = a.company || a.hostname || "";
      // Plain title: clicking the row opens the detail drawer (which holds the
      // saved JD and a link to the original posting), so the title isn't a
      // competing link.
      const title = esc(a.job_title || a.hostname || "Application");
      const av = avatarFor(company || title);
      const sub = a.hostname && a.hostname !== company ? `<div class="job__sub">${esc(a.hostname)}</div>` : "";
      const src = a.ats ? `<span class="src">${esc(a.ats)}</span>` : `<span class="muted">—</span>`;
      const chevron = statusBg(STATUS_COLORS[status] || "#64748b");
      const opts = STAGES.map(
        ([k, label]) => `<option value="${k}"${k === status ? " selected" : ""}>${label}</option>`
      ).join("");
      return `
        <tr data-id="${esc(a.id)}">
          <td>
            <div class="cell-role">
              <span class="logo" style="${av.style}">${esc(av.initial)}</span>
              <div><div class="job__title">${title}</div>${sub}</div>
            </div>
          </td>
          <td class="muted">${esc(company)}</td>
          <td>${src}</td>
          <td><select class="status status--${status}" data-id="${esc(a.id)}" style="background-image:${chevron}">${opts}</select></td>
          <td class="muted">${timeAgo(a.updated_at)}</td>
          <td><button class="del" data-id="${esc(a.id)}" title="Remove">×</button></td>
        </tr>`;
    })
    .join("");

  rows.querySelectorAll("select.status").forEach((sel) => {
    sel.addEventListener("change", () => updateStatus(sel.getAttribute("data-id"), sel.value));
  });
  rows.querySelectorAll("button.del").forEach((btn) => {
    btn.addEventListener("click", () => removeRow(btn.getAttribute("data-id")));
  });
  // Click anywhere on a row (except the status/delete/link controls) to open
  // the detail drawer.
  rows.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("select, button, a")) return;
      openDetail(tr.getAttribute("data-id"));
    });
  });
}

async function updateStatus(id, status) {
  const { error } = await client
    .from("applications")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return;
  const a = apps.find((x) => x.id === id);
  if (a) {
    a.status = status;
    a.updated_at = new Date().toISOString();
  }
  renderStats();
  renderFilters();
  renderRows();
}

async function removeRow(id) {
  if (!confirm("Remove this application?")) return;
  const { error } = await client.from("applications").delete().eq("id", id);
  if (error) return;
  apps = apps.filter((a) => a.id !== id);
  renderStats();
  renderFilters();
  renderRows();
}

// ---------- Detail drawer ----------
const EXT_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>`;

function openDetail(id) {
  const a = apps.find((x) => x.id === id);
  if (!a) return;
  const status = a.status || "started";
  const company = a.company || a.hostname || "";
  const title = a.job_title || a.hostname || "Application";
  const av = avatarFor(company || title);
  const jd = (a.job_description || "").trim();
  const meta = (k, v) => `<div><div class="meta__k">${k}</div><div class="meta__v">${v}</div></div>`;
  const sub =
    a.hostname && a.hostname !== company ? ` · ${esc(a.hostname)}` : "";
  const link = a.url
    ? `<a class="drawer__link" href="${esc(a.url)}" target="_blank" rel="noopener">Open original posting ${EXT_ICON}</a>`
    : "";

  const drawer = el("drawer");
  drawer.innerHTML =
    `<div class="drawer__head">
       <span class="drawer__logo" style="${av.style}">${esc(av.initial)}</span>
       <div class="drawer__titlewrap">
         <div class="drawer__title">${esc(title)}</div>
         <div class="drawer__company">${esc(company)}${sub}</div>
       </div>
       <button class="drawer__close" data-close aria-label="Close">×</button>
     </div>
     <div class="drawer__body">
       <div class="drawer__meta">
         ${meta("Status", `<span class="pill status--${status}">${esc(STAGE_LABEL[status] || status)}</span>`)}
         ${meta("Source", a.ats ? esc(a.ats) : "—")}
         ${meta("Added", fmtDate(a.created_at))}
         ${meta("Updated", fmtDate(a.updated_at))}
       </div>
       ${link}
       <div class="jd__label">Job description</div>
       ${
         jd
           ? `<div class="jd">${esc(jd)}</div>`
           : `<div class="jd jd--empty">No job description was captured for this application.</div>`
       }
     </div>`;
  drawer.hidden = false;
  el("overlay").hidden = false;
  drawer.querySelector("[data-close]").addEventListener("click", closeDetail);
}

function closeDetail() {
  el("drawer").hidden = true;
  el("overlay").hidden = true;
}

init();

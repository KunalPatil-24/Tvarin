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
  userBox.innerHTML = `<span>${esc(email)}</span> <button class="btn" id="signout">Sign out</button>`;
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

  const tile = (num, label) => `<div class="stat"><div class="stat__num">${num}</div><div class="stat__label">${label}</div></div>`;
  el("stats").innerHTML =
    tile(apps.length, "Tracked") +
    tile(submitted.length, "Applied") +
    tile(`${rate}%`, "Response rate") +
    tile(offers.length, "Offers");

  // Stage distribution bar.
  const bar = el("bar");
  if (!apps.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.innerHTML = STAGES.map(([k]) => {
    const n = apps.filter((a) => (a.status || "started") === k).length;
    const pct = (100 * n) / apps.length;
    return pct ? `<span class="seg--${k}" style="width:${pct}%" title="${STAGE_LABEL[k]}: ${n}"></span>` : "";
  }).join("");
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
      const title = esc(a.job_title || a.hostname || "Application");
      const titleCell = a.url
        ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${title}</a>`
        : title;
      const opts = STAGES.map(
        ([k, label]) => `<option value="${k}"${k === status ? " selected" : ""}>${label}</option>`
      ).join("");
      return `
        <tr data-id="${esc(a.id)}">
          <td class="job__title">${titleCell}</td>
          <td class="muted">${esc(a.company || a.hostname || "")}</td>
          <td class="muted">${esc(a.ats || "")}</td>
          <td><select class="status status--${status}" data-id="${esc(a.id)}">${opts}</select></td>
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

init();

/* Tvarin options: profile + settings + resume + Google sign-in for AI. */

const PROFILE_KEY = "tvarin.profile";
const SETTINGS_KEY = "tvarin.settings";
const RESUME_KEY = "tvarin.resume";
const AI_KEY = "tvarin.ai"; // { resumeText }
const MAX_RESUME_BYTES = 2 * 1024 * 1024;

const form = document.getElementById("profile-form");
const savedNote = document.getElementById("saved");
const resumeInput = document.getElementById("resume-input");
const resumeStatus = document.getElementById("resume-status");
const resumeRemove = document.getElementById("resume-remove");
const signinBtn = document.getElementById("ai-signin");
const signoutBtn = document.getElementById("ai-signout");
const aiStatus = document.getElementById("ai-status");

const FIELDS = [
  "firstName",
  "lastName",
  "middleName",
  "preferredName",
  "pronouns",
  "email",
  "phoneCountryCode",
  "phone",
  "dateOfBirth",
  "addressLine1",
  "city",
  "state",
  "postalCode",
  "country",
  "currentLocation",
  "linkedin",
  "github",
  "portfolio",
  "about",
  "projects",
  "skills",
  "willingToRelocate",
  "hasNonCompete",
  "workAuthorized",
  "needsSponsorship",
  "isOfLegalWorkingAge",
  "isGovernmentEmployee",
  "relatedToCompany",
  "hasCriminalRecord",
  "noticePeriod",
  "currentCTC",
  "gender",
  "ethnicity",
  "veteranStatus",
  "sexualOrientation",
  "disabilityStatus",
];

// chrome.storage only exists when this page runs as part of the loaded
// extension. If it's missing, the page was opened as a plain file.
function storageAvailable() {
  return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
}

function showNote(text, ok = true) {
  savedNote.textContent = text;
  savedNote.style.color = ok ? "" : "#dc2626";
}

function load() {
  if (!storageAvailable()) {
    showNote(
      "Open this page via the Tvarin sidebar → Profile (not as a file) to load & save.",
      false
    );
    return;
  }
  chrome.storage.local.get([PROFILE_KEY, SETTINGS_KEY, AI_KEY], (res) => {
    const profile = res[PROFILE_KEY] || {};
    FIELDS.forEach((name) => {
      if (form.elements[name]) form.elements[name].value = profile[name] || "";
    });
    const settings = res[SETTINGS_KEY] || {};
    if (form.elements.autoDeclineEEO) {
      form.elements.autoDeclineEEO.checked = !!settings.autoDeclineEEO;
    }
    const ai = res[AI_KEY] || {};
    if (form.elements.aiResumeText) form.elements.aiResumeText.value = ai.resumeText || "";
  });
  loadResumeStatus();
  renderAuth();
  renderLogins();
}

/* ----- Saved logins (device-key-encrypted vault, managed via background) ----- */

const loginsList = document.getElementById("logins-list");
const loginsEmpty = document.getElementById("logins-empty");

function fmtWhen(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch (_) {
    return "";
  }
}

function renderLogins() {
  if (!storageAvailable() || !loginsList) return;
  chrome.runtime.sendMessage({ type: "TVARIN_CRED_LIST" }, (resp) => {
    const creds = (resp && resp.credentials) || [];
    loginsList.innerHTML = "";
    if (!creds.length) {
      if (loginsEmpty) loginsEmpty.hidden = false;
      return;
    }
    if (loginsEmpty) loginsEmpty.hidden = true;

    creds.forEach((cred) => {
      const li = document.createElement("li");
      li.className = "login-item";

      const info = document.createElement("div");
      info.className = "login-item__info";
      const host = document.createElement("span");
      host.className = "login-item__host";
      host.textContent = cred.origin;
      const user = document.createElement("span");
      user.className = "login-item__user";
      user.textContent = cred.username || "(no username)";
      const meta = document.createElement("span");
      meta.className = "login-item__meta";
      meta.textContent = cred.updatedAt ? `Updated ${fmtWhen(cred.updatedAt)}` : "";
      info.append(host, user, meta);

      const pw = document.createElement("code");
      pw.className = "login-item__pw";
      pw.textContent = "••••••••";

      const actions = document.createElement("div");
      actions.className = "login-item__actions";

      const showBtn = document.createElement("button");
      showBtn.type = "button";
      showBtn.className = "btn btn--ghost btn--sm";
      showBtn.textContent = "Show";
      let shown = false;
      showBtn.addEventListener("click", () => {
        if (shown) {
          pw.textContent = "••••••••";
          showBtn.textContent = "Show";
          shown = false;
          return;
        }
        chrome.runtime.sendMessage({ type: "TVARIN_CRED_REVEAL", id: cred.id }, (r) => {
          if (r && typeof r.password === "string") {
            pw.textContent = r.password;
            showBtn.textContent = "Hide";
            shown = true;
          } else {
            pw.textContent = (r && r.error) || "Couldn't decrypt.";
          }
        });
      });

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn btn--ghost btn--sm";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "TVARIN_CRED_REVEAL", id: cred.id }, async (r) => {
          if (r && typeof r.password === "string") {
            try {
              await navigator.clipboard.writeText(r.password);
              copyBtn.textContent = "Copied";
              setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
            } catch (_) {
              copyBtn.textContent = "Failed";
            }
          }
        });
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn--ghost btn--sm btn--danger";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => {
        if (!confirm(`Delete the saved login for ${cred.origin}?`)) return;
        chrome.runtime.sendMessage({ type: "TVARIN_CRED_DELETE", id: cred.id }, () => {
          renderLogins();
        });
      });

      actions.append(showBtn, copyBtn, delBtn);
      li.append(info, pw, actions);
      loginsList.appendChild(li);
    });
  });
}

/* ----- Google sign-in (via background service worker) ----- */

function setAuthStatus(text) {
  if (aiStatus) aiStatus.textContent = text;
}

function renderAuth() {
  if (!storageAvailable()) return;
  chrome.runtime.sendMessage({ type: "TVARIN_GET_SESSION" }, (resp) => {
    const session = resp && resp.session;
    if (session && session.signedIn) {
      if (signinBtn) signinBtn.hidden = true;
      if (signoutBtn) signoutBtn.hidden = false;
      setAuthStatus(session.email ? `Signed in as ${session.email}` : "Signed in.");
    } else {
      if (signinBtn) signinBtn.hidden = false;
      if (signoutBtn) signoutBtn.hidden = true;
      setAuthStatus("Not signed in.");
    }
  });
}

async function signIn() {
  if (!storageAvailable()) {
    setAuthStatus("Open this page via the extension to sign in.");
    return;
  }
  setAuthStatus("Opening Google sign-in…");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "TVARIN_SIGN_IN" });
    if (!resp || !resp.ok) {
      setAuthStatus((resp && resp.error) || "Sign-in was cancelled.");
      return;
    }
    renderAuth();
  } catch (e) {
    setAuthStatus(e && e.message ? e.message : "Sign-in was cancelled.");
  }
}

async function signOut() {
  if (!storageAvailable()) return;
  try {
    await chrome.runtime.sendMessage({ type: "TVARIN_SIGN_OUT" });
  } catch (_) {}
  renderAuth();
}

if (signinBtn) signinBtn.addEventListener("click", signIn);
if (signoutBtn) signoutBtn.addEventListener("click", signOut);

/* ----- Resume file (stored separately, attached at fill time) ----- */

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function loadResumeStatus() {
  if (!storageAvailable()) return;
  chrome.storage.local.get(RESUME_KEY, (res) => {
    const resume = res[RESUME_KEY];
    if (resume && resume.name) {
      resumeStatus.textContent = `Saved: ${resume.name} (${formatSize(resume.size)})`;
      resumeStatus.style.color = "#059669";
      resumeRemove.hidden = false;
    } else {
      resumeStatus.textContent = "No resume uploaded yet.";
      resumeStatus.style.color = "";
      resumeRemove.hidden = true;
    }
  });
}

if (resumeInput) {
  resumeInput.addEventListener("change", () => {
    const file = resumeInput.files && resumeInput.files[0];
    if (!file) return;
    if (!storageAvailable()) {
      resumeStatus.textContent = "Open via the extension to save a resume.";
      resumeStatus.style.color = "#dc2626";
      return;
    }
    if (file.size > MAX_RESUME_BYTES) {
      resumeStatus.textContent = `Too large (${formatSize(file.size)}). Max 2 MB.`;
      resumeStatus.style.color = "#dc2626";
      resumeInput.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const resume = {
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        dataUrl: reader.result,
        addedAt: Date.now(),
      };
      chrome.storage.local.set({ [RESUME_KEY]: resume }, () => {
        resumeInput.value = "";
        loadResumeStatus();
      });
    };
    reader.readAsDataURL(file);
  });
}

if (resumeRemove) {
  resumeRemove.addEventListener("click", () => {
    if (!storageAvailable()) return;
    chrome.storage.local.remove(RESUME_KEY, loadResumeStatus);
  });
}

/* ----- Save profile + settings + resume text ----- */

form.addEventListener("submit", (e) => {
  e.preventDefault();

  if (!storageAvailable()) {
    showNote(
      "Can't save here — open this page from the loaded extension (sidebar → Profile).",
      false
    );
    return;
  }

  const profile = {};
  FIELDS.forEach((name) => {
    const el = form.elements[name];
    if (el && el.value.trim()) profile[name] = el.value.trim();
  });

  const settings = {
    autoDeclineEEO: !!(form.elements.autoDeclineEEO && form.elements.autoDeclineEEO.checked),
  };

  const ai = {
    resumeText: form.elements.aiResumeText ? form.elements.aiResumeText.value.trim() : "",
  };

  chrome.storage.local.get([PROFILE_KEY, SETTINGS_KEY], (res) => {
    const prev = res[PROFILE_KEY] || {};
    // Keep structured Education / Work Experience from the sidebar modal.
    if (Array.isArray(prev.educations) && prev.educations.length) {
      profile.educations = prev.educations;
    }
    if (prev.education) profile.education = prev.education;
    if (Array.isArray(prev.experiences) && prev.experiences.length) {
      profile.experiences = prev.experiences;
    }
    if (prev.experience) profile.experience = prev.experience;

    chrome.storage.local.set(
      {
        [PROFILE_KEY]: profile,
        // Merge, don't replace — keep switches the Settings view owns
        // (autoOpen, attachResume) that this legacy page doesn't know about.
        [SETTINGS_KEY]: { ...(res[SETTINGS_KEY] || {}), ...settings },
        [AI_KEY]: ai,
      },
      () => {
        if (chrome.runtime.lastError) {
          showNote("Save failed: " + chrome.runtime.lastError.message, false);
          return;
        }
        showNote("Saved ✓", true);
        setTimeout(() => (savedNote.textContent = ""), 2000);
      }
    );
  });
});

load();

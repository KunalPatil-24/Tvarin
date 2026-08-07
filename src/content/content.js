/*
 * Tvarin content script.
 *
 * Runs on every page. Stays dormant until the popup sends a "fill" message,
 * then: picks the right ATS adapter for the page, fills the form from the
 * saved profile, and logs that the application was started.
 *
 * Organised in sections:
 *   1. Storage helpers          - read profile / write application log
 *   2. Field context + matcher  - understand a form field, map it to a profile key
 *   3. Filler                    - set a value in a way React-controlled forms accept
 *   4. Adapters                  - Generic + Greenhouse + Lever + Workday (wizard) + iCIMS
 *   5. Router                    - detect the ATS, pick the adapter
 *   6. Orchestration + messaging - the fill() entry point, toast, message listener
 */
(() => {
  "use strict";

  if (globalThis.__tvarinContentLoaded) return;
  globalThis.__tvarinContentLoaded = true;

  const STORAGE_KEYS = {
    profile: "tvarin.profile",
    applications: "tvarin.applications",
    settings: "tvarin.settings",
    resume: "tvarin.resume",
    // Per-ATS remembered school picks: { [hostKey]: [{ from, to }, ...] }
    schoolMaps: "tvarin.schoolMaps",
  };

  /* ------------------------------------------------------------------ *
   * 1. Storage helpers
   * ------------------------------------------------------------------ */

  function getProfile() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEYS.profile, (res) => {
        resolve(res[STORAGE_KEYS.profile] || null);
      });
    });
  }

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEYS.settings, (res) => {
        resolve(res[STORAGE_KEYS.settings] || {});
      });
    });
  }

  function getResume() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEYS.resume, (res) => {
        resolve(res[STORAGE_KEYS.resume] || null);
      });
    });
  }

  function getSchoolMaps() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEYS.schoolMaps, (res) => {
        resolve(res[STORAGE_KEYS.schoolMaps] || {});
      });
    });
  }

  function setSchoolMaps(maps) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEYS.schoolMaps]: maps }, resolve);
    });
  }

  // Coarse host so Greenhouse boards share one school catalog memory.
  function schoolMapHost() {
    const h = location.hostname.replace(/^www\./, "");
    if (/greenhouse\.io$/i.test(h)) return "greenhouse.io";
    if (/lever\.co$/i.test(h)) return "lever.co";
    if (/myworkdayjobs\.com$/i.test(h) || /\.workday\.com$/i.test(h)) return "workday";
    if (/icims\.com$/i.test(h)) return "icims.com";
    return h;
  }

  // Stable id, generated at row creation so the *same* row is what later syncs
  // to the server and gets updated — one row per job on both sides.
  function newAppId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // Normalise a job URL for identity comparison: drop the #hash, the ?query, the
  // "/apply..." step suffix, and any trailing slash.
  function normJobUrl(u) {
    return String(u || "")
      .split("#")[0]
      .split("?")[0]
      .replace(/\/apply\/?.*$/i, "")
      .replace(/\/$/, "");
  }

  // Two rows are the same job when they share a host and either the same title
  // or the same normalised URL. Single source of truth for "same job" — both the
  // fill and the submit path key on this, so they can never drift apart.
  function sameJob(a, job) {
    if (!a || !job) return false;
    if ((a.hostname || "") !== (job.hostname || "")) return false;
    if (a.jobTitle && job.jobTitle && a.jobTitle === job.jobTitle) return true;
    return normJobUrl(a.url) === normJobUrl(job.url);
  }

  // Within this window a repeat fill/submit updates the existing row; past it
  // (e.g. a job reposted months later) a fresh row is created.
  const ACTIVE_APP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  // Pipeline order. Automated writes (fill→started, submit→applied) and manual
  // tracker edits (interviewing/offer/rejected) all flow through the upsert, so
  // it must never move a row *backward* — a re-fill can't undo "interviewing".
  const STATUS_RANK = { started: 0, applied: 1, interviewing: 2, offer: 3, rejected: 3 };
  const rank = (s) => STATUS_RANK[s] ?? 0;
  // Cap the stored JD: we only hold the `storage` permission (no unlimitedStorage),
  // and the row list is capped at 500, so keep each description bounded.
  const JD_STORE_MAX = 6000;

  // Insert-or-update an application row, keyed on job identity. Replaces the old
  // logApplication (fill) + markApplicationApplied (submit) pair: the fill path
  // had no dedup, so filling one job N times left N rows. Now both funnel through
  // here — one row per job, promoted on submit and never downgraded on re-fill.
  function upsertApplication(entry) {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEYS.applications, (res) => {
        const list = res[STORAGE_KEYS.applications] || [];
        const now = Date.now();

        const idx = list.findIndex(
          (a) => sameJob(a, entry) && now - (a.timestamp || 0) < ACTIVE_APP_WINDOW_MS
        );

        if (idx >= 0) {
          const prev = list[idx];
          // Keep whichever status is furthest along — never move backward.
          const incoming = entry.status || prev.status;
          const status = rank(prev.status) >= rank(incoming) ? prev.status : incoming;
          const merged = {
            ...prev,
            ...entry,
            id: prev.id || newAppId(),
            status,
            // A confirmation page scrapes a worse JD than the apply page did, so
            // keep the first non-empty description instead of clobbering it.
            jobDescription: (prev.jobDescription || entry.jobDescription || "").slice(0, JD_STORE_MAX),
            timestamp: prev.timestamp || now, // created: stable, never bumped
            // Stamp appliedAt the first time the row reaches "applied" or beyond.
            appliedAt: rank(status) >= rank("applied") ? prev.appliedAt || now : prev.appliedAt,
            updatedAt: now, // modified: bumps "last worked on" without moving created
          };
          // Move the touched row to the top so recent work shows first.
          list.splice(idx, 1);
          list.unshift(merged);
        } else {
          list.unshift({
            ...entry,
            id: newAppId(),
            jobDescription: (entry.jobDescription || "").slice(0, JD_STORE_MAX),
            timestamp: now,
            appliedAt: rank(entry.status) >= rank("applied") ? now : undefined,
            updatedAt: now,
          });
        }

        chrome.storage.local.set(
          { [STORAGE_KEYS.applications]: list.slice(0, 500) },
          resolve
        );
      });
    });
  }

  // Record "applied" on a real Submit click. Thin wrapper: builds the row from
  // adapter/page metadata, then upserts so it merges into the fill's "started"
  // row for the same job rather than creating a duplicate.
  function markApplicationApplied(meta = {}) {
    return upsertApplication({
      url: (meta.url || location.href).split("#")[0],
      hostname: meta.hostname || location.hostname,
      jobTitle: (meta.jobTitle || bestEffortJobTitle()).slice(0, 200),
      company: (meta.company || bestEffortCompany()).slice(0, 200),
      ats: meta.ats || (pickAdapter() && pickAdapter().name) || "generic",
      jobDescription: meta.jobDescription || bestEffortJobDescription(),
      status: "applied",
    });
  }

  function isSubmitControl(el) {
    if (!el || el.nodeType !== 1) return false;
    const btn = el.closest(
      'button, input[type="submit"], a[role="button"], div[role="button"]'
    );
    if (!btn) return false;
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
    const t = (btn.textContent || btn.value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!t) return false;
    // Never treat wizard navigation as submit.
    if (
      /save and continue|save & continue|save for later|continue|next|back|previous|cancel|delete|add another|^add$/.test(
        t
      )
    ) {
      return false;
    }
    if (/^submit$|^submit application$|^submit your application$/.test(t)) return true;
    if (/\bsubmit (application|your application)\b/.test(t)) return true;
    const auto = btn.getAttribute("data-automation-id") || "";
    if (
      (auto === "pageFooterNextButton" ||
        auto === "bottom-navigation-next-button") &&
      /submit/.test(t)
    ) {
      return true;
    }
    if (btn.type === "submit" && /submit|apply/.test(t)) return true;
    return false;
  }

  // Record "applied" only when the user actually clicks Submit (never on Fill).
  let lastAppliedAt = 0;
  document.addEventListener(
    "click",
    (e) => {
      if (!isSubmitControl(e.target)) return;
      const now = Date.now();
      if (now - lastAppliedAt < 4000) return; // debounce double-clicks / re-renders
      lastAppliedAt = now;
      if (window === window.top) {
        markApplicationApplied().then(() => {
          toast("Tvarin: recorded as applied.");
        });
      } else {
        // Submit lives in an embedded form (e.g. a Greenhouse iframe): tell the
        // top frame to record the apply against the real job page.
        try {
          window.top.postMessage({ source: "tvarin", type: "TVARIN_SUBMITTED" }, "*");
        } catch (_) {}
      }
    },
    true
  );

  /* ------------------------------------------------------------------ *
   * 2. Field context + matcher
   * ------------------------------------------------------------------ */

  // Build a lowercase "haystack" describing a field: its label, name, id,
  // placeholder and aria-label. This is what we match profile keys against.
  function getFieldContext(el) {
    const parts = [];

    // <label for="id">
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) parts.push(lbl.textContent);
    }
    // Wrapping <label>
    const wrapping = el.closest("label");
    if (wrapping) parts.push(wrapping.textContent);

    // aria-labelledby
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      labelledby.split(/\s+/).forEach((id) => {
        const n = document.getElementById(id);
        if (n) parts.push(n.textContent);
      });
    }

    parts.push(
      el.getAttribute("aria-label") || "",
      el.getAttribute("placeholder") || "",
      el.getAttribute("name") || "",
      el.id || "",
      el.getAttribute("autocomplete") || ""
    );

    return parts.join(" ").toLowerCase().replace(/\s+/g, " ").trim();
  }

  // Profile keys in priority order. More specific keys come first so that,
  // e.g., "First Name" matches firstName before the generic "name" -> fullName.
  const MATCH_RULES = [
    ["firstName", [/first name/, /\bgiven name\b/, /\bforename\b/, /\bfname\b/, /\bfirst\b/]],
    ["lastName", [/last name/, /\bsurname\b/, /family name/, /\blname\b/, /\blast\b/]],
    // Preferred/middle name before the generic "name" -> fullName at the end.
    ["middleName", [/middle name/, /middle initial/]],
    [
      "preferredName",
      [
        /preferred name/,
        /nick ?name/,
        /what should we call you/,
        /what (?:do|should) (?:we|i) call you/,
        /name you (?:go|prefer to go) by/,
        /\bgoes? by\b/,
      ],
    ],
    ["pronouns", [/pronoun/]],
    ["email", [/e-?mail/]],
    ["phoneCountryCode", [/country code/, /calling code/, /dial(ing)? code/, /phone code/, /\bisd\b/, /tel-country-code/]],
    ["phone", [/phone/, /mobile/, /telephone/, /\btel\b/, /\bcell\b/, /contact number/]],
    [
      "dateOfBirth",
      [
        /date of birth/,
        /\bdob\b/,
        /birth\s*date/,
        /birthday/,
        /born on/,
        /date you were born/,
        /bday/,
      ],
    ],
    ["linkedin", [/linkedin/]],
    ["github", [/github/]],
    ["portfolio", [/portfolio/, /personal (site|website)/, /\bwebsite\b/, /\bweb site\b/]],
    // Education dates before generic school/degree (Greenhouse: "Start date month").
    ["eduStartMonth", [/start date month/, /start(?:ing)? month/, /from month/]],
    ["eduStartYear", [/start date year/, /start(?:ing)? year/, /from year/]],
    ["eduEndMonth", [/end date month/, /end(?:ing)? month/, /to month/, /graduation month/]],
    ["eduEndYear", [/end date year/, /end(?:ing)? year/, /to year/, /graduation year/, /grad year/]],
    ["school", [/school name/, /\bschool--/, /\buniversity\b/, /\bcollege\b/, /\binstitution\b/, /(?:^|\s)school(?:\s*\*|\s*$)/]],
    ["discipline", [/\bdiscipline\b/, /\bmajor\b/, /field of study/, /concentration/]],
    ["degree", [/accreditation/, /\bdegree\b/]],
    ["gpa", [/\bgpa\b/, /grade point/, /cumulative average/]],
    ["company", [/\bcompany\b/, /\bemployer\b/, /organization name/]],
    ["jobTitle", [/job title/, /position title/, /role title/, /current (job )?title/, /\bposition\b/]],
    ["noticePeriod", [/notice period/, /period of notice/, /notice time/, /how (?:long|much) is your notice/]],
    // Current pay only — never "expected"/"desired" (that changes per application).
    [
      "currentCTC",
      [
        /current ctc/,
        /present ctc/,
        /current (?:annual )?(?:salary|compensation|package|remunerat\w*)/,
        /current fixed/,
        /current in-?hand/,
        /present (?:salary|compensation)/,
      ],
    ],
    // Candidate's current location as one line ("Bengaluru, India"). Specific
    // phrasings only — never a bare "location" (that may be the job's location
    // or a relocation preference).
    [
      "currentLocation",
      [
        /current location/,
        /present location/,
        /current residence/,
        /where are you (?:currently )?(?:based|located)/,
        /where do you (?:currently )?(?:live|reside)/,
        /location you are based/,
      ],
    ],
    // City/state/postal before address — Workday ids are often "address--city",
    // and a bare /\baddress\b/ would otherwise steal those fields.
    ["city", [/\bcity\b/, /\btown\b/]],
    ["state", [/\bstate\b/, /province/, /\bregion\b/]],
    ["postalCode", [/postal/, /post ?code/, /\bzip\b/, /pin ?code/]],
    // Only line 1 / street — never Address Line 2/3 or a generic "Address" section.
    [
      "addressLine1",
      [
        /address\s*line\s*1/,
        /addressline\s*1/,
        /street\s*address/,
        /\bstreet-address\b/,
        /(?:^|[\s_-])street(?:[\s_-]|$)/,
      ],
    ],
    ["country", [/\bcountry\b/]],
    ["fullName", [/full name/, /\bname\b/]],
  ];

  // Given a field's context string, return the profile key it maps to (or null).
  function matchProfileKey(context) {
    for (const [key, patterns] of MATCH_RULES) {
      // Avoid mapping custom Qs like "grading scale … current school" → school.
      if (
        key === "school" &&
        /grading scale|overall gpa|current school/.test(context)
      ) {
        continue;
      }
      // Don't put street into Address Line 2 / 3 (or apt/suite-only fields).
      if (
        key === "addressLine1" &&
        /address\s*line\s*[23]|addressline\s*[23]|\bapt\.?\b|\bsuite\b|\bunit\b/.test(
          context
        )
      ) {
        continue;
      }
      // Phone Extension / Ext are office PBX digits — leave blank (not the mobile number).
      if (
        key === "phone" &&
        /phone\s*extension|phone.?ext(?:ension)?|\bextension\b|\bext\.?\b/.test(
          context
        )
      ) {
        continue;
      }
      if (patterns.some((re) => re.test(context))) return key;
    }
    return null;
  }

  function primaryEducation(profile) {
    return Array.isArray(profile.educations) && profile.educations.length
      ? profile.educations[0]
      : null;
  }

  function listEducations(profile) {
    if (Array.isArray(profile.educations) && profile.educations.length) {
      return profile.educations.filter(
        (e) =>
          e &&
          (e.school ||
            e.accreditation ||
            e.discipline ||
            e.major ||
            e.startDate ||
            e.endDate ||
            e.gpa)
      );
    }
    // Legacy flat profile fields → one synthetic row.
    if (profile.school || profile.degree || profile.discipline) {
      return [
        {
          school: profile.school || "",
          accreditation: profile.degree || "",
          discipline: profile.discipline || "",
          gpa: profile.gpa || "",
          startDate: "",
          endDate: "",
          current: false,
        },
      ];
    }
    return [];
  }

  function educationFieldValue(edu, key) {
    if (!edu) return "";
    if (key === "school") return edu.school || "";
    if (key === "degree") return edu.accreditation || edu.degree || "";
    if (key === "discipline") return edu.discipline || edu.major || "";
    if (key === "gpa") return edu.gpa || "";
    if (key === "eduStartMonth" || key === "eduStartYear") {
      const parts = parseMonthYear(edu.startDate);
      if (!parts) return "";
      return key === "eduStartMonth" ? parts.monthName : parts.yyyy;
    }
    if (key === "eduEndMonth" || key === "eduEndYear") {
      if (edu.current) return "";
      const parts = parseMonthYear(edu.endDate);
      if (!parts) return "";
      return key === "eduEndMonth" ? parts.monthName : parts.yyyy;
    }
    return "";
  }

  function primaryExperience(profile) {
    return Array.isArray(profile.experiences) && profile.experiences.length
      ? profile.experiences[0]
      : null;
  }

  function listExperiences(profile) {
    if (Array.isArray(profile.experiences) && profile.experiences.length) {
      return profile.experiences.filter(
        (e) =>
          e &&
          (e.company ||
            e.title ||
            e.location ||
            e.startDate ||
            e.endDate ||
            e.summary ||
            (Array.isArray(e.bullets) && e.bullets.some(Boolean)))
      );
    }
    if (profile.company || profile.jobTitle || profile.experience) {
      return [
        {
          company: profile.company || "",
          title: profile.jobTitle || "",
          location: "",
          startDate: "",
          endDate: "",
          current: false,
          summary: profile.experience || "",
          bullets: [""],
        },
      ];
    }
    return [];
  }

  function experienceRoleText(exp) {
    if (!exp) return "";
    const bullets = Array.isArray(exp.bullets)
      ? exp.bullets.filter(Boolean).map((b) => `• ${b}`).join("\n")
      : "";
    return [exp.summary, bullets].filter(Boolean).join("\n").trim();
  }

  // Parse profile <input type="month"> values (YYYY-MM) into parts.
  function parseMonthYear(raw) {
    const s = String(raw || "").trim();
    const m = s.match(/^(\d{4})-(\d{1,2})$/);
    if (!m) return null;
    const year = +m[1];
    const month = +m[2];
    if (year < 1950 || year > 2100 || month < 1 || month > 12) return null;
    return {
      year,
      month,
      yyyy: String(year),
      mm: String(month).padStart(2, "0"),
      monthName: MONTH_NAMES[month - 1],
      monthAbbr: MONTH_ABBR[month - 1],
    };
  }

  // Resolve the actual string value for a profile key, composing where needed.
  function valueForKey(profile, key) {
    if (key === "fullName") {
      const composed = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
      return profile.fullName || composed || "";
    }
    const edu = primaryEducation(profile);
    const exp = primaryExperience(profile);
    if (key === "school") return (edu && edu.school) || profile.school || "";
    if (key === "degree") {
      return (edu && edu.accreditation) || profile.degree || "";
    }
    if (key === "discipline") {
      return (edu && (edu.discipline || edu.major)) || profile.discipline || "";
    }
    if (key === "gpa") return (edu && edu.gpa) || profile.gpa || "";
    if (key === "eduStartMonth" || key === "eduStartYear") {
      const parts = parseMonthYear(edu && edu.startDate);
      if (!parts) return "";
      return key === "eduStartMonth" ? parts.monthName : parts.yyyy;
    }
    if (key === "eduEndMonth" || key === "eduEndYear") {
      if (edu && edu.current) return "";
      const parts = parseMonthYear(edu && edu.endDate);
      if (!parts) return "";
      return key === "eduEndMonth" ? parts.monthName : parts.yyyy;
    }
    if (key === "company") return (exp && exp.company) || profile.company || "";
    if (key === "jobTitle") return (exp && exp.title) || profile.jobTitle || "";
    return profile[key] || "";
  }

  /* ------------------------------------------------------------------ *
   * 3. Filler
   * ------------------------------------------------------------------ */

  function isVisible(el) {
    if (el.disabled || el.readOnly) return false;
    if (el.type === "hidden") return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Set a value so that React/Vue-controlled inputs actually register the change.
  // (Assigning el.value alone is ignored by React; we call the native setter and
  //  dispatch the input/change events the framework listens for.)
  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillField(el, value) {
    if (!value || !isVisible(el)) return false;
    if (el.tagName === "SELECT") {
      const wanted = value.toLowerCase();
      const opt = Array.from(el.options).find(
        (o) =>
          o.value.toLowerCase() === wanted ||
          o.textContent.trim().toLowerCase() === wanted
      );
      if (!opt) return false;
      setNativeValue(el, opt.value);
      return true;
    }
    if (el.value && el.value.trim()) return false; // don't overwrite user input
    setNativeValue(el, value);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 4. Adapters
   * ------------------------------------------------------------------ *
   * An adapter knows how to fill one kind of page. Each exposes:
   *   name  - stable id
   *   label - human-readable name (shown in the toast)
   *   fill(profile) -> { filled: number }
   */

  const FILLABLE_SELECTOR =
    'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select';

  // Scan the page once: list every fillable field with the profile key it maps to.
  function classifyFields() {
    const items = [];
    document.querySelectorAll(FILLABLE_SELECTOR).forEach((el) => {
      const key = matchProfileKey(getFieldContext(el));
      if (key) items.push({ el, key });
    });
    return items;
  }

  // Does the phone field sit next to a country / dial-code control?
  // Many forms (incl. Greenhouse) use an "international phone" widget: a country
  // dropdown/flag beside the number box. That control is often labelled just
  // "Country" (or nothing), so we detect it structurally — by looking for a
  // select / combobox / flag control near the phone input — rather than by label.
  function phoneHasCountryControl(phoneEl) {
    let node = phoneEl;
    for (let up = 0; up < 3 && node.parentElement; up++) {
      node = node.parentElement;
      const ctrl = node.querySelector(
        'select, [role="combobox"], [role="listbox"], button[aria-haspopup], [class*="country"], [class*="flag"], [class*="dial"], [class*="intl-tel"]'
      );
      if (ctrl && ctrl !== phoneEl && !ctrl.contains(phoneEl)) return true;
    }
    return false;
  }

  // Build whole-form context that individual field fills need to know about.
  function buildContext(items) {
    const phoneItem = items.find((i) => i.key === "phone" && isVisible(i.el));
    const dedicatedCodeField = items.some(
      (i) => i.key === "phoneCountryCode" && isVisible(i.el)
    );
    const hasCountryCodeField =
      dedicatedCodeField ||
      (!!phoneItem && phoneHasCountryControl(phoneItem.el));
    return { hasCountryCodeField };
  }

  // Resolve the value to fill, aware of the whole form's context.
  // Phone handling:
  //   - If the form has a country-code field OR an international-phone widget
  //     (separate country control), the phone box gets the national number only.
  //   - Only for a truly lone phone field do we prepend the country code so the
  //     number is complete (e.g. "+91 9405824003").
  function resolveValue(profile, key, ctx) {
    if (key === "phone") {
      const national = profile.phone || "";
      if (!ctx.hasCountryCodeField && profile.phoneCountryCode && national) {
        return `${profile.phoneCountryCode} ${national}`.trim();
      }
      return national;
    }
    return valueForKey(profile, key);
  }

  // Fill a list of {el, key} items; returns how many were filled.
  // Comboboxes (react-select etc.) are skipped here — they need the async
  // open-menu-and-click flow in fillComboboxes(), not a plain value set.
  function fillItems(items, profile, ctx, skip) {
    let filled = 0;
    const dob = parseDateOfBirth(profile.dateOfBirth);
    for (const { el, key } of items) {
      if (skip && skip.has(el)) continue;
      if (isCombobox(el)) continue;
      if (key === "dateOfBirth") {
        if (dob && fillDobSingleControl(el, dob)) filled++;
        continue;
      }
      if (fillField(el, resolveValue(profile, key, ctx))) filled++;
    }
    return filled;
  }

  /* ------------------------------------------------------------------ *
   * 3a. Date of birth (text · split month/day/year · calendar later)
   * ------------------------------------------------------------------ *
   * Store once as YYYY-MM-DD. At fill time detect the widget and format.
   */

  const MONTH_NAMES = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const MONTH_ABBR = MONTH_NAMES.map((m) => m.slice(0, 3));

  function parseDateOfBirth(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (!m) return null;
    let year;
    let month;
    let day;
    if (m[1].length === 4) {
      year = +m[1];
      month = +m[2];
      day = +m[3];
    } else {
      // Ambiguous D/M/Y vs M/D/Y — prefer ISO-only from profile <input type=date>.
      // If pasted as slash form, assume MDY (US job boards) when month<=12.
      month = +m[1];
      day = +m[2];
      year = +m[3];
      if (month > 12 && day <= 12) {
        const tmp = month;
        month = day;
        day = tmp;
      }
    }
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    return {
      year,
      month,
      day,
      yyyy: String(year),
      mm: String(month).padStart(2, "0"),
      dd: String(day).padStart(2, "0"),
    };
  }

  function isDobContext(text) {
    const ctx = String(text || "").toLowerCase();
    if (
      !/date of birth|\bdob\b|birth\s*date|birthday|born on|date you were born|\bbday\b/.test(
        ctx
      )
    ) {
      return false;
    }
    // Avoid experience / cert date widgets.
    if (
      /work experience|start date|end date|issued|expir|graduation|certificate|employment/.test(
        ctx
      )
    ) {
      return false;
    }
    return true;
  }

  function inferDobTextFormat(el, profile) {
    if (!el) return "mdy";
    if (el.type === "date") return "iso";
    const hint = [
      el.getAttribute("placeholder") || "",
      el.getAttribute("pattern") || "",
      el.getAttribute("data-format") || "",
      el.getAttribute("aria-label") || "",
      el.name || "",
      el.id || "",
      getFieldContext(el),
    ]
      .join(" ")
      .toLowerCase();
    if (/yyyy-mm-dd|yy-mm-dd|iso/.test(hint)) return "iso";
    if (/dd\s*[\/\-.]\s*mm|d\/m\/y|ddmmyy|dd\/mm/.test(hint)) return "dmy";
    if (/mm\s*[\/\-.]\s*dd|m\/d\/y|mmddyy|mm\/dd/.test(hint)) return "mdy";
    if (/yyyy\s*[\/\-.]\s*mm|yyyymmdd/.test(hint)) return "ymd";
    const country = String((profile && profile.country) || "").toLowerCase();
    if (/\b(india|uk|united kingdom|australia|germany|france|singapore)\b/.test(country)) {
      return "dmy";
    }
    return "mdy";
  }

  function formatDobText(parts, style) {
    if (!parts) return "";
    const { yyyy, mm, dd } = parts;
    if (style === "iso") return `${yyyy}-${mm}-${dd}`;
    if (style === "dmy") return `${dd}/${mm}/${yyyy}`;
    if (style === "ymd") return `${yyyy}/${mm}/${dd}`;
    return `${mm}/${dd}/${yyyy}`; // mdy
  }

  function optionMatchesDatePart(optText, optValue, parts, kind) {
    const t = String(optText || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const v = String(optValue || "")
      .trim()
      .toLowerCase();
    if (!t && !v) return false;
    if (kind === "year") {
      return t === parts.yyyy || v === parts.yyyy || t.endsWith(parts.yyyy);
    }
    if (kind === "day") {
      const n = String(parts.day);
      const dd = parts.dd;
      return t === n || t === dd || v === n || v === dd || t === `${parts.day}.`;
    }
    // month: number or name
    const n = String(parts.month);
    const mm = parts.mm;
    const name = MONTH_NAMES[parts.month - 1];
    const abbr = MONTH_ABBR[parts.month - 1];
    return (
      t === n ||
      t === mm ||
      v === n ||
      v === mm ||
      t === name ||
      t === abbr ||
      t.startsWith(name) ||
      t.startsWith(abbr) ||
      v === name ||
      v === abbr
    );
  }

  function fillDobSelect(el, parts, kind) {
    if (!el || el.tagName !== "SELECT") return false;
    const opts = Array.from(el.options);
    const hit = opts.find((o) =>
      optionMatchesDatePart(o.textContent, o.value, parts, kind)
    );
    if (!hit) return false;
    if (el.value === hit.value && el.selectedIndex === hit.index) return true;
    el.value = hit.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function fillDobSingleControl(el, parts, profile) {
    if (!el || !parts || !isVisible(el)) return false;
    if (el.tagName === "SELECT") {
      const ctx = getFieldContext(el);
      if (/year|yyyy|yy\b/.test(ctx)) return fillDobSelect(el, parts, "year");
      if (/month|mm\b/.test(ctx)) return fillDobSelect(el, parts, "month");
      if (/\bday\b|dd\b|date\b/.test(ctx)) return fillDobSelect(el, parts, "day");
      // Single select with full dates — rare; try formatted strings.
      for (const style of ["mdy", "dmy", "iso", "ymd"]) {
        const want = formatDobText(parts, style);
        const hit = Array.from(el.options).find((o) => {
          const t = (o.textContent || o.value || "").trim();
          return t === want || t.replace(/-/g, "/") === want.replace(/-/g, "/");
        });
        if (hit) {
          el.value = hit.value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      return false;
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (el.value && String(el.value).trim()) return false;
      const style = inferDobTextFormat(el, profile);
      const text =
        el.type === "date" ? formatDobText(parts, "iso") : formatDobText(parts, style);
      return fillField(el, text);
    }
    return false;
  }

  function findDobSplitInRoot(root) {
    if (!root) return null;
    const month =
      root.querySelector(
        '[data-automation-id="dateSectionMonth-input"], input[data-automation-id*="Month" i], input[name*="month" i], input[id*="month" i], select[name*="month" i], select[id*="month" i], select[aria-label*="Month" i]'
      ) || null;
    const day =
      root.querySelector(
        '[data-automation-id="dateSectionDay-input"], input[data-automation-id*="Day" i], input[name*="day" i], input[id*="day" i], select[name*="day" i], select[id*="day" i], select[aria-label*="Day" i]'
      ) || null;
    const year =
      root.querySelector(
        '[data-automation-id="dateSectionYear-input"], input[data-automation-id*="Year" i], input[name*="year" i], input[id*="year" i], select[name*="year" i], select[id*="year" i], select[aria-label*="Year" i]'
      ) || null;
    if (month || day || year) return { month, day, year, root };
    return null;
  }

  async function fillDobSplitParts(split, parts) {
    if (!split || !parts) return 0;
    let n = 0;
    // Year → month → day is common on Workday; also fine if some parts missing.
    const order = [
      ["year", split.year],
      ["month", split.month],
      ["day", split.day],
    ];
    for (const [kind, el] of order) {
      if (!el || !isVisible(el)) continue;
      if (el.tagName === "SELECT") {
        if (fillDobSelect(el, parts, kind)) n++;
        continue;
      }
      const raw =
        kind === "year" ? parts.yyyy : kind === "month" ? parts.mm : parts.dd;
      if (el.value && String(el.value).trim()) {
        // Already set — count if it matches.
        if (String(el.value).replace(/^0+/, "") === String(raw).replace(/^0+/, "")) n++;
        continue;
      }
      if (fillField(el, raw)) n++;
      await sleep(80);
    }
    return n;
  }

  // Fill DOB anywhere on the page: split widgets first, then single fields.
  // Calendar popups are intentionally deferred (most brittle).
  async function fillDateOfBirthFields(profile) {
    const parts = parseDateOfBirth(profile && profile.dateOfBirth);
    if (!parts) return 0;
    let filled = 0;
    const handled = new Set();

    const roots = Array.from(
      document.querySelectorAll(
        '[data-automation-id^="formField-"], fieldset, [role="group"], [class*="date" i], [class*="birth" i]'
      )
    );

    for (const root of roots) {
      if (!isVisible(root) && root.getClientRects().length === 0) continue;
      const labelText =
        (typeof workdayFormFieldQuestionText === "function"
          ? workdayFormFieldQuestionText(root)
          : "") ||
        (root.innerText || "").slice(0, 400);
      if (!isDobContext(labelText) && !isDobContext(root.id || "")) continue;
      const split = findDobSplitInRoot(root);
      if (!split) continue;
      const n = await fillDobSplitParts(split, parts);
      if (n > 0) {
        filled += n;
        [split.month, split.day, split.year].forEach((el) => el && handled.add(el));
      }
    }

    // Global Workday dateSection* near a birth label (not inside formField-*).
    const wdMonth = document.querySelector(
      '[data-automation-id="dateSectionMonth-input"]'
    );
    if (wdMonth && !handled.has(wdMonth)) {
      const near =
        wdMonth.closest('[data-automation-id^="formField-"]') ||
        wdMonth.closest("fieldset") ||
        wdMonth.parentElement;
      const ctx = ((near && near.innerText) || getFieldContext(wdMonth) || "").slice(
        0,
        500
      );
      if (isDobContext(ctx)) {
        const split = findDobSplitInRoot(near || document);
        if (split) {
          const n = await fillDobSplitParts(split, parts);
          filled += n;
          [split.month, split.day, split.year].forEach((el) => el && handled.add(el));
        }
      }
    }

    const candidates = Array.from(
      document.querySelectorAll("input, select, textarea")
    ).filter((el) => isVisible(el) && !handled.has(el));

    for (const el of candidates) {
      const ctx = getFieldContext(el);
      const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
      if (!isDobContext(ctx) && auto !== "bday" && !/^bday/i.test(auto)) continue;
      // Part of a split group already counted.
      if (
        /dateSection(Month|Day|Year)/i.test(el.getAttribute("data-automation-id") || "")
      ) {
        continue;
      }
      if (fillDobSingleControl(el, parts, profile)) filled++;
    }

    return filled;
  }

  /* ------------------------------------------------------------------ *
   * 3b. Combobox filler (react-select / ARIA comboboxes)
   * ------------------------------------------------------------------ *
   * Greenhouse (and many ATSs) render dropdowns as a text input with
   * role=combobox / aria-haspopup that opens a listbox of role=option items.
   * Setting .value does nothing; we must open the menu and click an option.
   */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isCombobox(el) {
    return (
      el.matches &&
      el.matches(
        '[role="combobox"], [aria-haspopup="true"], [aria-autocomplete="list"], .select__input'
      )
    );
  }

  // Has this combobox already got a selection? (Don't overwrite the user's.)
  function comboboxHasValue(el) {
    const control =
      el.closest('[class*="select__control"]') ||
      el.closest('[class*="select"]') ||
      el.parentElement;
    return !!(control && control.querySelector('[class*="single-value"]'));
  }

  function closeCombobox(el) {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape", keyCode: 27 })
    );
    if (document.activeElement) document.activeElement.blur();
  }

  function isVisibleListbox(node) {
    if (!node) return false;
    // intl-tel-input keeps a huge hidden country listbox in the DOM.
    if (node.classList && node.classList.contains("iti__country-list")) return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findListbox(el) {
    if (el && el.id) {
      const byId = document.getElementById(`react-select-${el.id}-listbox`);
      if (byId && isVisibleListbox(byId)) return byId;
    }
    const controls = el && el.getAttribute("aria-controls");
    if (controls) {
      const n = document.getElementById(controls);
      if (n && isVisibleListbox(n)) return n;
    }
    // Prefer the open react-select menu tied to this control.
    const root =
      (el && (el.closest('[class*="select"]') || el.closest('[class*="Select"]'))) ||
      document;
    const local = root.querySelector(
      '.select__menu [role="listbox"], [class*="menu"] [role="listbox"]'
    );
    if (local && isVisibleListbox(local)) return local;
    const menus = Array.from(
      document.querySelectorAll('.select__menu [role="listbox"], [role="listbox"]')
    ).filter(isVisibleListbox);
    return menus[0] || null;
  }

  function openCombobox(el) {
    const control =
      (el && el.closest(".select__control")) ||
      (el && el.closest('[class*="select__control"]')) ||
      el;
    if (control) {
      control.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
      );
      control.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })
      );
    }
    if (el) {
      el.focus();
      el.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
      );
    }
  }

  // Open a combobox and click the first option that satisfies match(text).
  // `typeahead` (optional) types into the input first to filter long lists.
  async function pickComboboxOption(el, { typeahead, match }) {
    if (!el || comboboxHasValue(el)) return false;
    openCombobox(el);
    await sleep(180);
    if (typeahead) {
      setNativeValue(el, typeahead);
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: typeahead, inputType: "insertText" })
      );
      await sleep(420);
    } else {
      await sleep(220);
    }
    let listbox = findListbox(el);
    // Retry once — Greenhouse react-select can lag on first open.
    if (!listbox) {
      openCombobox(el);
      await sleep(280);
      listbox = findListbox(el);
    }
    if (!listbox) {
      closeCombobox(el);
      return false;
    }
    const options = Array.from(listbox.querySelectorAll('[role="option"]'));
    const target = options.find((o) => match(o.textContent.trim()));
    if (!target) {
      closeCombobox(el);
      return false;
    }
    await clickComboboxOption(target);
    return true;
  }

  async function clickComboboxOption(target) {
    if (!target) return false;
    target.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
    );
    target.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })
    );
    target.click();
    await sleep(140);
    return true;
  }

  function readComboboxLabel(el) {
    if (!el) return "";
    const root =
      el.closest('[class*="select__container"]') ||
      el.closest('[class*="select"]') ||
      el.parentElement;
    if (!root) return "";
    const single = root.querySelector('[class*="single-value"]');
    return single && single.textContent ? single.textContent.trim() : "";
  }

  // Map free-text degree (B.S., M.Tech…) onto Greenhouse's fixed options.
  function matchDegreeOption(optionText, wanted) {
    const o = String(optionText || "").toLowerCase();
    const w = String(wanted || "").toLowerCase().trim();
    if (!w) return false;
    if (o === w || o.includes(w) || w.includes(o)) return true;
    if (
      /bachelor|b\.?\s*s\.?\b|b\.?\s*tech|b\.?\s*e\.?\b|b\.?\s*a\.?\b|undergrad/.test(w) &&
      /bachelor/.test(o)
    ) {
      return true;
    }
    if (
      /master|m\.?\s*s\.?\b|m\.?\s*tech|m\.?\s*eng|m\.?\s*a\.?\b|\bmba\b|graduate/.test(w) &&
      /master/.test(o)
    ) {
      return true;
    }
    if (/ph\.?\s*d|doctorate|doctoral|dphil/.test(w) && /doctor|ph\.?\s*d/.test(o)) {
      return true;
    }
    if (/associate|a\.?\s*s\.?\b|a\.?\s*a\.?\b/.test(w) && /associate/.test(o)) {
      return true;
    }
    return false;
  }

  function fuzzyOptionMatch(optionText, wanted) {
    const o = String(optionText || "").toLowerCase().trim();
    const w = String(wanted || "").toLowerCase().trim();
    if (!w || !o) return false;
    if (o === w) return true;
    if (o.includes(w) || w.includes(o)) return true;
    // Token overlap (e.g. "Computer Science" vs "CS - Computer Science")
    const tokens = w.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    if (tokens.length && tokens.every((t) => o.includes(t))) return true;
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 3b-school. School combobox matching (no profile aliases)
   *   - Score live menu options (tokens, acronyms, city)
   *   - Soft-expand IIIT / IIT / NIT / ABV-style short forms
   *   - Remember per-ATS picks; toast + learn on miss
   * ------------------------------------------------------------------ */

  const SCHOOL_STOP = new Set([
    "of",
    "the",
    "and",
    "for",
    "in",
    "at",
    "a",
    "an",
    "to",
    "by",
    "on",
    "de",
  ]);
  const SCHOOL_WEAK = new Set([
    "institute",
    "institution",
    "university",
    "college",
    "school",
    "campus",
    "technology",
    "technologies",
    "management",
    "information",
    "science",
    "sciences",
    "engineering",
    "education",
    "indian",
    "national",
    "international",
    "state",
    "viswavidyalaya",
    "deemed",
  ]);
  const SCHOOL_ACRONYM_EXPAND = {
    iiitm: [
      "indian",
      "institute",
      "information",
      "technology",
      "management",
      "iiit",
    ],
    iiit: ["indian", "institute", "information", "technology"],
    iiitdm: [
      "indian",
      "institute",
      "information",
      "technology",
      "design",
      "manufacturing",
      "iiit",
    ],
    iit: ["indian", "institute", "technology"],
    nit: ["national", "institute", "technology"],
    nits: ["national", "institute", "technology"],
    bits: ["birla", "institute", "technology", "science"],
    abv: ["atal", "bihari", "vajpayee", "behari"],
    nitk: ["national", "institute", "technology", "karnataka", "surathkal"],
    nitw: ["national", "institute", "technology", "warangal"],
    nitt: ["national", "institute", "technology", "trichy", "tiruchirappalli"],
  };

  // IIT-/NIT-/IIIT- campus codes: "IIT-B" / "IITB" / "(IITB)" → place tokens.
  const SCHOOL_CAMPUS_CODE = {
    b: ["bombay", "mumbai"],
    d: ["delhi"],
    g: ["guwahati"],
    k: ["kanpur"],
    kgp: ["kharagpur"],
    m: ["madras", "chennai"],
    r: ["roorkee"],
    h: ["hyderabad"],
    i: ["indore"],
    bhu: ["varanasi", "bhu", "banaras"],
    j: ["jodhpur"],
    p: ["patna"],
    pn: ["patna"],
    bh: ["bhilai"],
    goa: ["goa"],
    ism: ["dhanbad", "ism"],
    ism_dhanbad: ["dhanbad"],
  };

  const SCHOOL_MIN_SCORE = 0.58;
  const SCHOOL_HIGH_SCORE = 0.82;

  // "IIT-B" / "IIT B" / "I.I.T.B" → "iitb" for hyphen-insensitive compare.
  function schoolCompact(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function tokenizeSchool(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .split(/[^a-z0-9]+/)
      .filter((t) => t && t.length > 1 && !SCHOOL_STOP.has(t));
  }

  function embeddedAcronyms(text) {
    const raw = String(text || "");
    const hits = new Set();
    const add = (s) => {
      const t = String(s || "").toLowerCase();
      if (t.length >= 2 && t.length <= 12) hits.add(t);
    };

    // Parenthetical codes on ATS options: "(IITB)", "(IIT-B)"
    for (const m of raw.match(/\(([A-Za-z0-9][A-Za-z0-9-]{1,11})\)/g) || []) {
      const inner = m.slice(1, -1);
      add(inner);
      add(schoolCompact(inner));
    }

    // Hyphenated / dotted codes: ABV-IIITM, IIT-B, IIT-KGP
    for (const m of raw.match(/\b[A-Za-z]{2,}(?:[.-][A-Za-z0-9]{1,8})+\b/g) || []) {
      add(schoolCompact(m)); // IIT-B → iitb
      for (const part of m.split(/[.-]/)) {
        if (
          /^[A-Za-z]{2,8}$/.test(part) ||
          SCHOOL_ACRONYM_EXPAND[part.toLowerCase()] ||
          SCHOOL_CAMPUS_CODE[part.toLowerCase()]
        ) {
          add(part);
        }
      }
    }

    // All-caps blobs: IITB, IIITM
    for (const m of raw.match(/\b[A-Z]{2,8}\b/g) || []) {
      add(m);
    }

    // Short profile forms already compact: "iitb"
    const compact = schoolCompact(raw);
    if (/^(iit|nit|iiit|bits)[a-z]{0,4}$/.test(compact)) add(compact);

    return [...hits];
  }

  function campusTokensFromAcronym(compact) {
    const c = String(compact || "").toLowerCase();
    const m = c.match(/^(iit|nit|iiit)([a-z]{1,4})$/);
    if (!m) return [];
    const places = SCHOOL_CAMPUS_CODE[m[2]];
    return places ? places.slice() : [];
  }

  function initialsAcronym(tokens) {
    if (!tokens.length) return "";
    return tokens.map((t) => t[0]).join("");
  }

  function expandSchoolTokens(text) {
    const base = tokenizeSchool(text);
    const out = new Set(base);
    for (const a of embeddedAcronyms(text)) {
      out.add(a);
      for (const place of campusTokensFromAcronym(a)) out.add(place);
    }

    // De-hyphenate whole string as one token when it looks like a short code.
    const compact = schoolCompact(text);
    if (compact.length >= 3 && compact.length <= 12 && compact.length <= String(text).replace(/\s/g, "").length) {
      out.add(compact);
      for (const place of campusTokensFromAcronym(compact)) out.add(place);
    }

    const initials = initialsAcronym(base);
    if (initials.length >= 3 && initials.length <= 8) out.add(initials);
    // IIITM-style: drop weak words then initials of content + key weak (institute/info/tech/mgmt)
    const contentish = base.filter(
      (t) =>
        !SCHOOL_WEAK.has(t) ||
        /^(institute|information|technology|management|design|manufacturing|science)$/.test(
          t
        )
    );
    const alt = initialsAcronym(contentish);
    if (alt.length >= 3 && alt.length <= 8) out.add(alt);

    for (const t of [...out]) {
      const exp = SCHOOL_ACRONYM_EXPAND[t];
      if (exp) exp.forEach((x) => out.add(x));
    }
    // If long form present, add common short forms.
    const joined = [...out].join(" ");
    if (
      /indian/.test(joined) &&
      /institute/.test(joined) &&
      /information/.test(joined) &&
      /technology/.test(joined)
    ) {
      out.add("iiit");
      if (/management/.test(joined)) out.add("iiitm");
    }
    if (
      /indian/.test(joined) &&
      /institute/.test(joined) &&
      /technology/.test(joined) &&
      !/information/.test(joined)
    ) {
      out.add("iit");
    }
    if (/national/.test(joined) && /institute/.test(joined) && /technology/.test(joined)) {
      out.add("nit");
    }
    if (/atal/.test(joined) && (/vajpayee/.test(joined) || /behari/.test(joined))) {
      out.add("abv");
    }
    // Bombay ↔ Mumbai for IIT-B style matches.
    if (out.has("bombay")) out.add("mumbai");
    if (out.has("mumbai")) out.add("bombay");
    if (out.has("madras")) out.add("chennai");
    if (out.has("chennai")) out.add("madras");
    return [...out];
  }

  function schoolPlaceTokens(text) {
    const tokens = expandSchoolTokens(text);
    return tokens.filter(
      (t) =>
        !SCHOOL_WEAK.has(t) &&
        !SCHOOL_ACRONYM_EXPAND[t] &&
        !/^(iit|nit|iiit|bits|abv)/.test(t) &&
        t.length > 3
    );
  }

  function schoolTypeaheadQueries(profileSchool) {
    const raw = String(profileSchool || "").trim();
    if (!raw) return [];
    const tokens = tokenizeSchool(raw);
    const expanded = expandSchoolTokens(raw);
    const places = schoolPlaceTokens(raw);
    const queries = [];
    const push = (q) => {
      const s = String(q || "").trim();
      if (s.length < 2) return;
      if (queries.some((x) => x.toLowerCase() === s.toLowerCase())) return;
      queries.push(s);
    };

    // Prefer compact codes first: IIT-B → IITB (what Greenhouse lists as "(IITB)").
    const compact = schoolCompact(raw);
    if (/^(iit|nit|iiit|bits)[a-z]{0,4}$/.test(compact)) {
      push(compact.toUpperCase());
      for (const place of campusTokensFromAcronym(compact)) {
        push(place);
        push(`IIT ${place}`);
        push(`Indian Institute of Technology ${place}`);
      }
    }

    for (const a of embeddedAcronyms(raw)) {
      push(a.toUpperCase());
      for (const p of places) push(`${a.toUpperCase()} ${p}`);
    }
    for (const a of ["iiitm", "iiitdm", "iiit", "iit", "nit", "bits", "abv"]) {
      if (!expanded.includes(a)) continue;
      push(a.toUpperCase());
      for (const p of places) {
        push(`${a.toUpperCase()} ${p}`);
        if (a === "iiitm") push(`IIIT ${p}`);
        if (a === "iit") push(`IIT ${p}`);
      }
    }
    for (const p of places.slice(0, 2)) push(p);
    // Compact multi-token probe before the full legal name.
    const strong = tokens.filter((t) => !SCHOOL_WEAK.has(t));
    if (strong.length) push(strong.slice(0, 3).join(" "));
    if (tokens.length >= 2) push(tokens.slice(0, 4).join(" "));
    return queries.slice(0, 7);
  }

  function scoreSchoolOption(optionText, profileSchool) {
    const oRaw = String(optionText || "").trim();
    const wRaw = String(profileSchool || "").trim();
    if (!oRaw || !wRaw) return 0;
    const o = oRaw.toLowerCase();
    const w = wRaw.toLowerCase();
    if (o === w) return 1;
    if (o.includes(w) || w.includes(o)) return 0.94;

    // Hyphen/space-insensitive: "IIT-B" ↔ "(IITB)" / "...Bombay (IITB)"
    const wC = schoolCompact(wRaw);
    const oC = schoolCompact(oRaw);
    if (wC.length >= 3 && (oC === wC || oC.includes(wC) || wC.includes(oC))) {
      return wC.length >= 4 ? 0.97 : 0.9;
    }

    const wTok = expandSchoolTokens(wRaw);
    const oTok = expandSchoolTokens(oRaw);
    const oSet = new Set(oTok);
    const wSet = new Set(wTok);

    const wStrong = wTok.filter((t) => !SCHOOL_WEAK.has(t) && t.length > 2);
    const oStrong = oTok.filter((t) => !SCHOOL_WEAK.has(t) && t.length > 2);
    if (!wStrong.length) return 0;

    let wHits = 0;
    for (const t of wStrong) {
      if (oSet.has(t) || o.includes(t) || oC.includes(schoolCompact(t))) wHits++;
    }
    let oHits = 0;
    for (const t of oStrong) {
      if (wSet.has(t) || w.includes(t) || wC.includes(schoolCompact(t))) oHits++;
    }
    const precision = wHits / wStrong.length;
    const recall = oStrong.length ? oHits / oStrong.length : precision;
    let score = 0.55 * precision + 0.45 * recall;

    const wAc = new Set([
      ...embeddedAcronyms(wRaw),
      ...wTok.filter((t) => SCHOOL_ACRONYM_EXPAND[t] || /^(iit|nit|iiit)[a-z]{0,4}$/.test(t)),
    ]);
    const oAc = new Set([
      ...embeddedAcronyms(oRaw),
      ...oTok.filter((t) => SCHOOL_ACRONYM_EXPAND[t] || /^(iit|nit|iiit)[a-z]{0,4}$/.test(t)),
    ]);
    for (const a of wAc) {
      const aC = schoolCompact(a);
      if ([...oAc].some((x) => schoolCompact(x) === aC) || oC.includes(aC)) {
        score += 0.16;
        break;
      }
    }
    const places = schoolPlaceTokens(wRaw);
    if (places.some((p) => o.includes(p) || oSet.has(p))) score += 0.12;

    return Math.max(0, Math.min(1, score));
  }

  async function lookupSchoolMapping(profileSchool) {
    const maps = await getSchoolMaps();
    const list = maps[schoolMapHost()] || [];
    let best = null;
    for (const entry of list) {
      if (!entry || !entry.to) continue;
      const sFrom = scoreSchoolOption(entry.from || "", profileSchool);
      const sTo = scoreSchoolOption(entry.to, profileSchool);
      const s = Math.max(sFrom, sTo * 0.95);
      if (!best || s > best.score) best = { score: s, to: entry.to };
    }
    return best && best.score >= 0.62 ? best.to : null;
  }

  async function saveSchoolMapping(profileSchool, optionLabel) {
    const from = String(profileSchool || "").trim();
    const to = String(optionLabel || "").trim();
    if (!from || !to || to.length < 2) return;
    const maps = await getSchoolMaps();
    const host = schoolMapHost();
    const list = Array.isArray(maps[host]) ? maps[host].slice() : [];
    const normTo = to.toLowerCase();
    const filtered = list.filter(
      (e) =>
        e &&
        e.to &&
        e.to.toLowerCase() !== normTo &&
        scoreSchoolOption(e.from || "", from) < 0.85
    );
    filtered.unshift({ from, to, ts: Date.now() });
    maps[host] = filtered.slice(0, 80);
    await setSchoolMaps(maps);
  }

  function watchManualSchoolPick(el, profileSchool) {
    if (!el || !profileSchool) return;
    const root =
      el.closest('[class*="select__container"]') ||
      el.closest('[class*="select"]') ||
      el.parentElement;
    if (!root) return;
    const started = Date.now();
    let saved = false;
    const trySave = async () => {
      if (saved) return;
      const label = readComboboxLabel(el);
      if (!label || label.length < 2 || /^select/i.test(label)) return;
      saved = true;
      obs.disconnect();
      clearInterval(poll);
      await saveSchoolMapping(profileSchool, label);
      toast("Tvarin: remembered this school for next time on this ATS.", 4200);
    };
    const obs = new MutationObserver(() => {
      if (Date.now() - started > 8 * 60 * 1000) {
        obs.disconnect();
        clearInterval(poll);
        return;
      }
      trySave();
    });
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    const poll = setInterval(trySave, 1200);
    setTimeout(() => {
      obs.disconnect();
      clearInterval(poll);
    }, 8 * 60 * 1000);
  }

  async function listSchoolOptions(el, typeahead) {
    openCombobox(el);
    await sleep(160);
    if (typeahead) {
      setNativeValue(el, typeahead);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: typeahead,
          inputType: "insertText",
        })
      );
      await sleep(480);
    } else {
      await sleep(220);
    }
    let listbox = findListbox(el);
    if (!listbox) {
      openCombobox(el);
      await sleep(280);
      listbox = findListbox(el);
    }
    if (!listbox) return [];
    return Array.from(listbox.querySelectorAll('[role="option"]'))
      .map((node) => ({ node, text: (node.textContent || "").trim() }))
      .filter(
        (o) => o.text && !/^no options|loading|type to search/i.test(o.text)
      );
  }

  async function pickBestSchoolFromQueries(el, profileSchool, queries, minScore) {
    let best = { score: 0, text: "", query: "" };
    for (const q of queries) {
      const options = await listSchoolOptions(el, q);
      for (const { text } of options) {
        const score = scoreSchoolOption(text, profileSchool);
        if (score > best.score) best = { score, text, query: q };
      }
      if (best.score >= SCHOOL_HIGH_SCORE) break;
      closeCombobox(el);
      await sleep(80);
    }
    if (best.score < minScore || !best.text) {
      closeCombobox(el);
      return null;
    }
    // Re-open with the winning query and click the exact label.
    const options = await listSchoolOptions(el, best.query || best.text.slice(0, 32));
    let target =
      options.find((o) => o.text === best.text) ||
      options.find((o) => o.text.toLowerCase() === best.text.toLowerCase()) ||
      options.find((o) => scoreSchoolOption(o.text, profileSchool) >= best.score - 0.02);
    if (!target) {
      closeCombobox(el);
      return null;
    }
    await clickComboboxOption(target.node);
    return best.text;
  }

  async function fillSchoolCombobox(el, profileSchool) {
    const wanted = String(profileSchool || "").trim();
    if (!el || !wanted) return { ok: false };
    if (comboboxHasValue(el)) return { ok: true, already: true };

    const remembered = await lookupSchoolMapping(wanted);
    if (remembered) {
      const okExact = await pickComboboxOption(el, {
        typeahead: remembered.slice(0, 48),
        match: (t) => {
          const a = t.toLowerCase();
          const b = remembered.toLowerCase();
          return a === b || a.includes(b) || b.includes(a);
        },
      });
      if (okExact) return { ok: true, from: "memory" };
      if (!comboboxHasValue(el)) {
        const okScore = await pickBestSchoolFromQueries(
          el,
          wanted,
          [remembered, ...schoolTypeaheadQueries(remembered), ...schoolTypeaheadQueries(wanted)],
          0.72
        );
        if (okScore) return { ok: true, from: "memory-score" };
      }
    }

    const queries = schoolTypeaheadQueries(wanted);
    const picked = await pickBestSchoolFromQueries(
      el,
      wanted,
      queries,
      SCHOOL_MIN_SCORE
    );
    if (picked) {
      await saveSchoolMapping(wanted, picked);
      return { ok: true, from: "score", label: picked };
    }

    watchManualSchoolPick(el, wanted);
    return { ok: false, miss: true };
  }

  function matchMonthOption(optionText, monthName) {
    const o = String(optionText || "").toLowerCase().trim();
    const w = String(monthName || "").toLowerCase().trim();
    if (!w) return false;
    return o === w || o.startsWith(w.slice(0, 3));
  }

  // "I decline / don't wish / prefer not to answer" — wording varies per field.
  const DECLINE_RE = /decline|don'?t wish|do(es)? not (wish|want)|wish not|prefer not|not to (say|answer)|rather not/i;

  // Greenhouse EEO/demographic fields have stable ids.
  const EEO_IDS = ["gender", "hispanic_ethnicity", "veteran_status", "disability_status"];

  /* ------------------------------------------------------------------ *
   * 3c. Resume attach
   * ------------------------------------------------------------------ *
   * You can't set input.value on a file field (browser security), but you CAN
   * hand it a file via a DataTransfer and fire `change` — which is how resume
   * autofill works. The file comes from what the user saved in Options.
   */

  function dataUrlToFile(dataUrl, name, mime) {
    const [, base64] = dataUrl.split(",");
    const bytes = atob(base64);
    const buf = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    return new File([buf], name, { type: mime || "application/octet-stream" });
  }

  // Find a file input that is specifically for a resume/CV (not a photo, not a
  // cover letter). Greenhouse uses id="resume"; Workday uses file-upload-input-ref
  // under the Resume/CV section (not cert attachment uploads).
  // Resume file inputs. Prefer the Resume/CV block so we don't hit unrelated
  // uploads (e.g. certification / cover letter). Greenhouse uses id="resume";
  // Workday uses file-upload-input-ref and clears the input after each upload.
  let resumeAttachLock = false;

  function findResumeUploadScope() {
    const heading = document.getElementById("Resume/CV-section");
    if (heading) {
      return (
        heading.closest("section") ||
        heading.closest('[data-automation-id="panelSet"]') ||
        heading.parentElement ||
        heading
      );
    }
    const block = document.querySelector(
      '[data-automation-id="attachments-FileUpload"], [data-automation-id*="FileUpload"]'
    );
    if (block) {
      return block.closest("section") || block.parentElement || block;
    }
    return null;
  }

  function findResumeInput() {
    const resumeBlock = findResumeUploadScope();
    const scope = resumeBlock || document;
    const inputs = Array.from(scope.querySelectorAll('input[type="file"]'));
    const pick = (el) => {
      const auto = (el.getAttribute("data-automation-id") || "").toLowerCase();
      if (el.id === "resume") return true;
      const block = el.closest("div");
      const nearby = ((block && block.innerText) || "").slice(0, 500).toLowerCase();
      if (/certification|cover letter|photo|avatar/.test(nearby) && !/resume|\bcv\b/.test(nearby)) {
        return false;
      }
      if (auto.includes("file-upload")) return true;
      const ctx = getFieldContext(el);
      return /resume|\bcv\b|curriculum vitae/.test(ctx) && !/cover/.test(ctx);
    };
    return (
      inputs.find(pick) ||
      (resumeBlock
        ? null
        : Array.from(document.querySelectorAll('input[type="file"]')).find(pick)) ||
      null
    );
  }

  function resumeAlreadyOnPage(resume) {
    const name = resume && resume.name;
    // Workday keeps a fresh empty <input type=file> after every upload, so
    // input.files is useless. Look for the filename in the Resume/CV section.
    const scope = findResumeUploadScope();
    const hay = scope
      ? scope.innerText || ""
      : (document.body && document.body.innerText) || "";
    if (name && hay.includes(name)) {
      return true;
    }
    // Named attachment rows elsewhere on the page (some tenants nest oddly).
    if (name) {
      const nodes = document.querySelectorAll(
        '[data-automation-id*="attachment"], [data-automation-id*="Attachment"], [data-automation-id*="FileUpload"]'
      );
      for (const n of nodes) {
        const t = n.textContent || "";
        if (t.includes(name) && /successfully uploaded|uploaded!|\d+(\.\d+)?\s*[km]b/i.test(t)) {
          return true;
        }
      }
    }
    const input = findResumeInput();
    return !!(input && input.files && input.files.length > 0);
  }

  function attachResume(resume) {
    if (!resume) return false;
    // One attempt per Fill click — Workday upload is async; without this lock
    // the wizard re-enters and stacks identical PDFs.
    if (resumeAttachLock) return false;
    if (resumeAlreadyOnPage(resume)) {
      resumeAttachLock = true;
      return false;
    }
    const input = findResumeInput();
    if (!input || (input.files && input.files.length > 0)) return false;
    resumeAttachLock = true;
    try {
      const file = dataUrlToFile(resume.dataUrl, resume.name, resume.type);
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      resumeAttachLock = false;
      return false;
    }
  }

  // Async pass: fill the comboboxes we can. Returns { filled, warnings }.
  async function fillComboboxes(items, profile, settings) {
    let filled = 0;
    const warnings = [];
    const handled = new Set();

    async function fillKey(key, { typeahead, match } = {}) {
      const value = valueForKey(profile, key);
      if (!value) return;
      const item = items.find(
        (i) => i.key === key && isCombobox(i.el) && !handled.has(i.el) && isVisible(i.el)
      );
      if (!item) return;
      const ok = await pickComboboxOption(item.el, {
        typeahead: typeahead === false ? undefined : typeahead || value,
        match: match || ((t) => fuzzyOptionMatch(t, value)),
      });
      if (ok) {
        filled++;
        handled.add(item.el);
      }
    }

    // Country selector (e.g. Greenhouse phone country) from the saved country.
    if (profile.country) {
      const want = profile.country.toLowerCase();
      const countryItem = items.find(
        (i) => i.key === "country" && isCombobox(i.el) && !handled.has(i.el)
      );
      if (countryItem) {
        const ok = await pickComboboxOption(countryItem.el, {
          typeahead: profile.country,
          match: (t) => {
            const s = t.toLowerCase();
            return s === want || s.startsWith(want);
          },
        });
        if (ok) {
          filled++;
          handled.add(countryItem.el);
        }
      }
    }

    // State / province — Workday-style ISO labels ("IN-MH") via alias match.
    if (profile.state) {
      const stateItem = items.find(
        (i) => i.key === "state" && isCombobox(i.el) && !handled.has(i.el) && isVisible(i.el)
      );
      if (stateItem) {
        const match = matchStateOption(profile.state, profile.country);
        const typeaheads = stateTypeaheadCandidates(profile.state, profile.country);
        let ok = false;
        for (const ta of typeaheads) {
          ok = await pickComboboxOption(stateItem.el, { typeahead: ta, match });
          if (ok) break;
        }
        if (!ok) ok = await pickComboboxOption(stateItem.el, { typeahead: false, match });
        if (ok) {
          filled++;
          handled.add(stateItem.el);
        }
      }
    }

    // School / degree / discipline / edu months: Greenhouse multi-row filler owns these.
    const greenhouseEdu =
      !!document.getElementById("school--0") || !!document.getElementById("degree--0");
    if (!greenhouseEdu) {
      const schoolWanted = valueForKey(profile, "school");
      const schoolItem = items.find(
        (i) =>
          i.key === "school" && isCombobox(i.el) && !handled.has(i.el) && isVisible(i.el)
      );
      if (schoolItem && schoolWanted) {
        const schoolResult = await fillSchoolCombobox(schoolItem.el, schoolWanted);
        handled.add(schoolItem.el);
        if (schoolResult.ok && !schoolResult.already) filled++;
        if (schoolResult.miss) {
          warnings.push("School not in this list — pick once, we'll remember");
        }
      }

      await fillKey("degree", {
        typeahead: false,
        match: (t) => matchDegreeOption(t, valueForKey(profile, "degree")),
      });
      await fillKey("discipline", {
        typeahead: valueForKey(profile, "discipline"),
        match: (t) => fuzzyOptionMatch(t, valueForKey(profile, "discipline")),
      });
      await fillKey("eduStartMonth", {
        typeahead: false,
        match: (t) => matchMonthOption(t, valueForKey(profile, "eduStartMonth")),
      });
      await fillKey("eduEndMonth", {
        typeahead: false,
        match: (t) => matchMonthOption(t, valueForKey(profile, "eduEndMonth")),
      });
    }
    // Optional, consent-gated: answer EEO/demographic questions as "decline".
    if (settings && settings.autoDeclineEEO) {
      for (const id of EEO_IDS) {
        const el = document.getElementById(id);
        if (el && isCombobox(el) && !handled.has(el)) {
          const ok = await pickComboboxOption(el, { match: (t) => DECLINE_RE.test(t) });
          if (ok) {
            filled++;
            handled.add(el);
          }
        }
      }
    }

    return { filled, warnings };
  }

  // Some ATSs put their stable id/attribute on a wrapper, not the input itself.
  function resolveInput(el) {
    if (!el) return null;
    if (el.matches && el.matches("input, textarea, select")) return el;
    return (el.querySelector && el.querySelector("input, textarea, select")) || null;
  }

  // Turn [selector, key] pairs into {el, key} items (resolving inner inputs).
  function collectKnown(pairs) {
    const items = [];
    for (const [selector, key] of pairs) {
      const el = resolveInput(document.querySelector(selector));
      if (el) items.push({ el, key });
    }
    return items;
  }

  // Shared adapter runner: fill an ATS's known fields first, then a generic
  // label pass for the rest, then the async combobox pass (country + EEO + education).
  async function runAdapter(knownItems, profile, settings, opts = {}) {
    const items = classifyFields();
    // Merge known ids into classify list so combobox pass sees Greenhouse education fields
    // even when label heuristics miss them.
    const seen = new Set(items.map((i) => i.el));
    for (const item of knownItems) {
      if (item.el && !seen.has(item.el)) {
        items.push(item);
        seen.add(item.el);
      }
    }
    const ctx = buildContext(items);
    if (opts.forceCountryCode) ctx.hasCountryCodeField = true;

    let filled = 0;
    const warnings = [];
    const handled = new Set();
    for (const { el, key } of knownItems) {
      // Comboboxes need the open-menu-and-click flow — skip here.
      if (isCombobox(el)) continue;
      if (fillField(el, resolveValue(profile, key, ctx))) {
        filled++;
        handled.add(el);
      }
    }
    filled += fillItems(items, profile, ctx, handled);
    const combo = await fillComboboxes(items, profile, settings);
    filled += combo.filled || 0;
    if (combo.warnings && combo.warnings.length) warnings.push(...combo.warnings);
    filled += await fillDateOfBirthFields(profile);
    return { filled, warnings };
  }

  // Generic heuristic adapter — the fallback that works best-effort anywhere.
  const genericAdapter = {
    name: "generic",
    label: "Generic",
    fill(profile, settings) {
      return runAdapter([], profile, settings);
    },
  };

  // Google Forms — Phase 1: short-answer and paragraph questions are native
  // <input>/<textarea> whose aria-labelledby points at the question text, so the
  // generic pass already maps and fills them. We add job-aware logging metadata.
  // (Choice/checkbox/dropdown widgets are role-divs — handled in a later phase.)
  const googleFormsAdapter = {
    name: "googleForms",
    label: "Google Forms",
    async fill(profile, settings) {
      const meta = scrapeGoogleFormMeta();
      const result = await runAdapter([], profile, settings);
      // Phase 2 — role-div choice widgets the generic text pass can't reach.
      const choiceFilled = fillGoogleFormChoice(profile, settings);
      const dropdownFilled = await fillGoogleFormDropdowns(profile, settings);
      const warnings = Array.isArray(result.warnings) ? [...result.warnings] : [];
      // Make an unmatched, unusually-worded question visible instead of silent.
      const unmapped = countUnmappedGoogleFormQuestions();
      if (unmapped > 0) {
        warnings.push(
          `couldn't place ${unmapped} question${unmapped === 1 ? "" : "s"} — review before you submit`
        );
      }
      return {
        filled: (result.filled || 0) + choiceFilled + dropdownFilled,
        warnings,
        meta,
        unmapped,
      };
    },
  };

  // Greenhouse — stable ids; phone is always paired with a country selector,
  // so the phone box holds the national number only.
  // Education: multi-row (#school--0, #school--1, …) via "Add another".
  const greenhouseAdapter = {
    name: "greenhouse",
    label: "Greenhouse",
    async fill(profile, settings) {
      const eduResult = await fillGreenhouseEducations(profile);
      const known = collectKnown([
        ["#first_name", "firstName"],
        ["#last_name", "lastName"],
        ["#email", "email"],
        ["#phone", "phone"],
      ]);
      const result = await runAdapter(known, profile, settings, {
        forceCountryCode: !!document.querySelector("#country"),
      });
      const warnings = [
        ...(eduResult.warnings || []),
        ...(result.warnings || []),
      ];
      return {
        filled: (result.filled || 0) + (eduResult.filled || 0),
        warnings,
      };
    },
  };

  function greenhouseEducationIndexCount() {
    let n = 0;
    while (document.getElementById(`school--${n}`) || document.getElementById(`degree--${n}`)) {
      n++;
    }
    return n;
  }

  function findGreenhouseEducationAddAnother() {
    const anchor =
      document.getElementById("school--0") ||
      document.getElementById("degree--0") ||
      document.querySelector("#education, [id*='education' i], legend");
    const scopes = [];
    if (anchor) {
      scopes.push(
        anchor.closest("form"),
        anchor.closest("fieldset"),
        anchor.closest("section"),
        anchor.closest('[class*="education" i]'),
        anchor.parentElement && anchor.parentElement.parentElement,
        anchor.parentElement
      );
    }
    scopes.push(document);

    const isAddAnother = (el) => {
      if (!el || !isVisible(el)) return false;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return (
        t === "add another" ||
        t === "add education" ||
        t === "add another education" ||
        /^add another\b/.test(t)
      );
    };

    for (const scope of scopes) {
      if (!scope || !scope.querySelectorAll) continue;
      const candidates = scope.querySelectorAll(
        "a, button, [role='button'], span[class*='link'], div[class*='link']"
      );
      for (const el of candidates) {
        if (isAddAnother(el)) return el;
      }
    }
    // Greenhouse sometimes nests the control as a plain clickable text node wrapper.
    const all = document.querySelectorAll("a, button");
    for (const el of all) {
      if (isAddAnother(el)) return el;
    }
    return null;
  }

  async function ensureGreenhouseEducationRows(needed) {
    let have = greenhouseEducationIndexCount();
    if (have === 0) return 0;
    let guard = 0;
    while (have < needed && guard++ < 8) {
      const btn = findGreenhouseEducationAddAnother();
      if (!btn) break;
      btn.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
      );
      btn.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })
      );
      btn.click();
      // Wait for the new school--N input to mount.
      const target = have;
      let appeared = false;
      for (let i = 0; i < 20; i++) {
        await sleep(150);
        if (
          document.getElementById(`school--${target}`) ||
          document.getElementById(`degree--${target}`)
        ) {
          appeared = true;
          break;
        }
      }
      if (!appeared) break;
      have = greenhouseEducationIndexCount();
    }
    return have;
  }

  async function fillGreenhouseEducationRow(index, edu) {
    let filled = 0;
    const warnings = [];
    if (!edu) return { filled, warnings };

    const schoolEl = resolveInput(document.getElementById(`school--${index}`));
    const degreeEl = resolveInput(document.getElementById(`degree--${index}`));
    const disciplineEl = resolveInput(document.getElementById(`discipline--${index}`));
    const startMonthEl = resolveInput(document.getElementById(`start-month--${index}`));
    const startYearEl = resolveInput(document.getElementById(`start-year--${index}`));
    const endMonthEl = resolveInput(document.getElementById(`end-month--${index}`));
    const endYearEl = resolveInput(document.getElementById(`end-year--${index}`));

    const school = educationFieldValue(edu, "school");
    if (schoolEl && school && isCombobox(schoolEl)) {
      const res = await fillSchoolCombobox(schoolEl, school);
      if (res.ok && !res.already) filled++;
      if (res.miss) {
        warnings.push(
          index === 0
            ? "School not in this list — pick once, we'll remember"
            : `Education ${index + 1}: school not in this list — pick once, we'll remember`
        );
      }
    } else if (schoolEl && school && fillField(schoolEl, school)) {
      filled++;
    }

    const degree = educationFieldValue(edu, "degree");
    if (degreeEl && degree && isCombobox(degreeEl)) {
      if (
        await pickComboboxOption(degreeEl, {
          typeahead: false,
          match: (t) => matchDegreeOption(t, degree),
        })
      ) {
        filled++;
      }
    } else if (degreeEl && degree && fillField(degreeEl, degree)) {
      filled++;
    }

    const discipline = educationFieldValue(edu, "discipline");
    if (disciplineEl && discipline && isCombobox(disciplineEl)) {
      if (
        await pickComboboxOption(disciplineEl, {
          typeahead: discipline,
          match: (t) => fuzzyOptionMatch(t, discipline),
        })
      ) {
        filled++;
      }
    } else if (disciplineEl && discipline && fillField(disciplineEl, discipline)) {
      filled++;
    }

    const startMonth = educationFieldValue(edu, "eduStartMonth");
    if (startMonthEl && startMonth && isCombobox(startMonthEl)) {
      if (
        await pickComboboxOption(startMonthEl, {
          typeahead: false,
          match: (t) => matchMonthOption(t, startMonth),
        })
      ) {
        filled++;
      }
    }
    const startYear = educationFieldValue(edu, "eduStartYear");
    if (startYearEl && startYear && fillField(startYearEl, startYear)) filled++;

    const endMonth = educationFieldValue(edu, "eduEndMonth");
    if (endMonthEl && endMonth && isCombobox(endMonthEl)) {
      if (
        await pickComboboxOption(endMonthEl, {
          typeahead: false,
          match: (t) => matchMonthOption(t, endMonth),
        })
      ) {
        filled++;
      }
    }
    const endYear = educationFieldValue(edu, "eduEndYear");
    if (endYearEl && endYear && fillField(endYearEl, endYear)) filled++;

    return { filled, warnings };
  }

  async function fillGreenhouseEducations(profile) {
    const list = listEducations(profile);
    if (!list.length) return { filled: 0, warnings: [] };
    // Only act when Greenhouse education widgets are on the page.
    if (!document.getElementById("school--0") && !document.getElementById("degree--0")) {
      return { filled: 0, warnings: [] };
    }

    const have = await ensureGreenhouseEducationRows(list.length);
    const n = Math.min(list.length, Math.max(have, 1));
    let filled = 0;
    const warnings = [];
    for (let i = 0; i < n; i++) {
      const row = await fillGreenhouseEducationRow(i, list[i]);
      filled += row.filled;
      warnings.push(...row.warnings);
    }
    if (list.length > n) {
      warnings.push(
        `Saved ${list.length} educations — only ${n} row${n === 1 ? "" : "s"} on this form`
      );
    }
    return { filled, warnings };
  }

  // Lever — stable field names (verified on a live jobs.lever.co form).
  // Single "Full name" field; lone phone (gets the country code prepended).
  const leverAdapter = {
    name: "lever",
    label: "Lever",
    fill(profile, settings) {
      const known = collectKnown([
        ['input[name="name"]', "fullName"],
        ['input[name="email"]', "email"],
        ['input[name="phone"]', "phone"],
        ['input[name="urls[LinkedIn]"]', "linkedin"],
        ['input[name="urls[GitHub]"]', "github"],
        ['input[name="urls[Portfolio]"]', "portfolio"],
      ]);
      return runAdapter(known, profile, settings);
    },
  };

  /* ------------------------------------------------------------------ *
   * 4b. Workday — multi-step wizard + PromptSelect widgets
   * ------------------------------------------------------------------ *
   * Workday is ~half of Fortune-500 apply flows. Text inputs use stable
   * data-automation-id attrs; country/state/phone-code are PromptSelect
   * widgets (open → typeahead → click option). The apply flow is a
   * sequential wizard: Fill handles the *current* step only. We never
   * click Continue/Submit — the user does. After Fill, we watch for their
   * Continue click and auto-fill each new step until Review.
   */

  function wd(id) {
    return `[data-automation-id="${CSS.escape(id)}"]`;
  }

  function wdEl(id) {
    return document.querySelector(wd(id));
  }

  // Step identity only — never include dynamic formField lists. Adding a
  // website/resume row changes those ids and used to look like "page advanced",
  // which re-ran Experience fill in a loop (dozens of duplicate URLs).
  function workdayPageFingerprint() {
    const active = textFrom(
      document.querySelector(
        '[data-automation-id="progressBarActiveStep"], [aria-current="step"], [aria-current="page"]'
      )
    );
    const pageEl = document.querySelector(
      "[data-automation-id='applyFlowMyInfoPage'], [data-automation-id='applyFlowMyExpPage'], [data-automation-id='applyFlowPrimaryQuestionsPage'], [data-automation-id^='applyFlow']"
    );
    const page = (pageEl && pageEl.getAttribute("data-automation-id")) || "";
    const heading = textFrom(
      document.querySelector(
        '[data-automation-id="applyFlowMyInfoPage"] h3, [data-automation-id="applyFlowMyExpPage"] h3, h3'
      )
    ).slice(0, 80);
    return `${page}|${active}|${heading}`;
  }

  function isWorkdayAuthWall() {
    const pwd = document.querySelector('input[type="password"]');
    if (!pwd || !isVisible(pwd)) return false;
    const hay = (document.body && document.body.innerText
      ? document.body.innerText
      : ""
    )
      .slice(0, 2500)
      .toLowerCase();
    return /sign in|create account|sign up|verify your email|forgot password/.test(
      hay
    );
  }

  // True when the primary action would submit the application — never auto-click.
  function isWorkdaySubmitPage() {
    const buttons = Array.from(
      document.querySelectorAll("button, a[role='button'], div[role='button']")
    );
    return buttons.some((b) => {
      if (!isVisible(b)) return false;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return (
        t === "submit" ||
        t === "submit application" ||
        t === "submit your application" ||
        /^submit\b/.test(t)
      );
    });
  }

  function findWorkdayNextButton() {
    const byId =
      wdEl("bottom-navigation-next-button") ||
      wdEl("pageFooterNextButton") ||
      wdEl("continueButton");
    if (byId && isVisible(byId) && !byId.disabled && byId.getAttribute("aria-disabled") !== "true") {
      const t = (byId.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (/submit/.test(t) || /save for later/.test(t)) return null;
      return byId;
    }
    const candidates = Array.from(
      document.querySelectorAll("button, a[role='button'], div[role='button']")
    );
    for (const b of candidates) {
      if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
      if (!isVisible(b)) continue;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (/submit|save for later|previous|back|cancel/.test(t)) continue;
      if (
        t === "save and continue" ||
        t === "save & continue" ||
        t === "continue" ||
        t === "next" ||
        /save and continue|continue to next|next step|^next$/.test(t)
      ) {
        return b;
      }
    }
    return null;
  }

  async function waitForWorkdayChange(prevFp, ms = 9000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      await sleep(280);
      if (workdayPageFingerprint() !== prevFp) return true;
      // Error banner = validation failed; stop waiting early.
      if (
        document.querySelector(
          '[data-automation-id="errorBanner"], [data-automation-id="errorMessage"], [data-automation-id*="error"][role="alert"]'
        )
      ) {
        return false;
      }
    }
    return false;
  }

  function closeWorkdayPopup() {
    // Escape once usually closes listboxes / moniker prompts; twice for nested Job Board.
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
      })
    );
    document.dispatchEvent(
      new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
      })
    );
    if (document.activeElement && typeof document.activeElement.blur === "function") {
      document.activeElement.blur();
    }
  }

  function workdayPopupOpen() {
    return !!(
      document.querySelector('[data-automation-id="responsiveMonikerPrompt"]') ||
      document.querySelector('[role="listbox"][aria-label*="Options" i]') ||
      Array.from(document.querySelectorAll('[role="listbox"]')).some((el) => {
        const r = el.getBoundingClientRect();
        // Ignore the tiny "items selected" chip listboxes.
        return r.height > 80 && r.width > 80;
      })
    );
  }

  async function dismissWorkdayPopup() {
    for (let i = 0; i < 3 && workdayPopupOpen(); i++) {
      // Prefer the explicit Done button on Autodesk multiselect prompts.
      const done = Array.from(document.querySelectorAll("button")).find(
        (b) => isVisible(b) && /^done$/i.test((b.textContent || "").trim())
      );
      if (done) {
        fireWorkdayClick(done);
        await sleep(280);
        if (!workdayPopupOpen()) return true;
      }
      closeWorkdayPopup();
      await sleep(180);
    }
    return !workdayPopupOpen();
  }

  // Workday PromptSelect: open widget → optional typeahead → click option.
  // Prefer exact/starts-with matches so "California" doesn't pick "Lower California Sur".
  async function pickWorkdayDropdown(trigger, { typeahead, match }) {
    if (!trigger || !isVisible(trigger)) return false;
    const shownBefore = (trigger.value || trigger.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (
      shownBefore &&
      match(shownBefore) &&
      !/select one|select an option|search|choose/i.test(shownBefore)
    ) {
      // Already set — still dismiss a leftover open list (country listbox stays open).
      if (workdayPopupOpen()) await dismissWorkdayPopup();
      return true;
    }

    trigger.focus();
    trigger.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
    );
    trigger.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })
    );
    trigger.click();
    await sleep(280);

    let search = null;
    if (typeahead) {
      search =
        document.querySelector(
          '[data-automation-id="promptSearchBox"] input, [data-automation-id="promptSearchInput"], [data-automation-id="searchBox"], input[placeholder*="Search" i], input[type="search"]'
        ) ||
        (document.activeElement &&
        /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)
          ? document.activeElement
          : null) ||
        (trigger.matches("input") ? trigger : null);
      if (search) {
        search.focus();
        setNativeValue(search, "");
        await sleep(60);
        setNativeValue(search, typeahead);
        // Some Workday prompts filter on keyup, not only input/change.
        search.dispatchEvent(
          new KeyboardEvent("keyup", { bubbles: true, key: "a", keyCode: 65 })
        );
        await sleep(700);
      } else {
        await sleep(400);
      }
    } else {
      await sleep(400);
    }

    function openPromptRoot() {
      return (
        document.querySelector(
          '[data-automation-id="responsiveMonikerPrompt"], [data-uxi-widget-type="prompt"], [data-automation-id="promptOption"]'
        ) &&
        (document.querySelector(
          '[data-automation-id="responsiveMonikerPrompt"]'
        ) ||
          document.querySelector('[data-uxi-widget-type="prompt"]') ||
          document.querySelector('[data-automation-id="menuItem"][role="option"]')
            ?.closest('[data-uxi-widget-type], [data-automation-id*="prompt"], [role="listbox"]') ||
          document.body)
      );
    }

    const root = openPromptRoot() || document;
    const optionSelectors = [
      '[data-automation-id="menuItem"][role="option"]',
      '[data-automation-id="promptOption"]',
      '[data-automation-id="promptLeafNode"]',
      '[data-uxi-widget-type="multiselectlistitem"]',
      '[role="option"]',
    ];

    let options = [];
    for (const sel of optionSelectors) {
      options = Array.from(root.querySelectorAll(sel)).filter((o) => {
        // Skip selected chips in already-filled multiselects (e.g. phone code).
        if (o.getAttribute("data-automation-id") === "selectedItem") return false;
        if (o.closest('[data-automation-id="selectedItemList"]')) return false;
        const t =
          o.getAttribute("data-automation-label") ||
          (o.textContent || "").trim();
        if (!t) return false;
        // Virtualized rows can report 0x0 briefly; keep ones in an open list.
        const r = o.getBoundingClientRect();
        return r.width > 0 || r.height > 0 || o.offsetParent !== null;
      });
      if (options.length) break;
    }

    const ranked = options
      .map((o) => {
        const t = (
          o.getAttribute("data-automation-label") ||
          o.getAttribute("aria-label") ||
          o.textContent ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .replace(/\s+(not )?checked$/i, "");
        return { o, t };
      })
      .filter(({ t }) => match(t));

    // Exact match first, then shortest label (avoids "India" → "Indiana"-style misses
    // when match() is starts-with; exact wins via sort key).
    ranked.sort((a, b) => {
      const want = (typeahead || "").toLowerCase();
      const ae = want && a.t.toLowerCase() === want ? 0 : 1;
      const be = want && b.t.toLowerCase() === want ? 0 : 1;
      if (ae !== be) return ae - be;
      return a.t.length - b.t.length;
    });

    const target = ranked[0] && ranked[0].o;
    if (!target) {
      await dismissWorkdayPopup();
      return false;
    }

    // Prefer clicking the menu row; Workday often ignores clicks on the inner label only.
    const clickEl =
      target.closest('[data-automation-id="menuItem"]') ||
      target.closest('[role="option"]') ||
      target;

    function fireClick(el) {
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        el.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y,
            buttons: 1,
            detail: 1,
          })
        );
      }
      if (typeof el.click === "function") el.click();
    }

    fireClick(clickEl);
    await sleep(220);

    // Country listboxes often highlight on click but only commit on Enter.
    const enterTarget = clickEl || search || document.activeElement || trigger;
    enterTarget.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
      })
    );
    enterTarget.dispatchEvent(
      new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
      })
    );
    await sleep(220);

    // Last resort: click the promptOption child if we hit the row already.
    const labelChild = clickEl.querySelector(
      '[data-automation-id="promptOption"], [data-automation-label]'
    );
    if (labelChild && labelChild !== clickEl) {
      fireClick(labelChild);
      await sleep(200);
    }

    const verified = match(
      (trigger.value || trigger.textContent || "").replace(/\s+/g, " ").trim()
    );
    // State PromptSelect auto-closes; country listbox / source moniker often stay open
    // after highlight — always dismiss so the next field isn't blocked.
    await dismissWorkdayPopup();
    return verified;
  }

  // Resolve a Workday control by automation-id, formField-* wrapper, or input id.
  // Modern tenants (wd5 Workday careers): formField-legalName--firstName + #name--legalName--firstName
  // Older docs/tenants: legalNameSection_firstName / phone-number / addressSection_*
  function workdayTriggerFor(id) {
    const candidates = [
      wdEl(id),
      wdEl(`formField-${id}`),
      document.getElementById(id),
      document.querySelector(`input[name="${CSS.escape(id)}"], button[name="${CSS.escape(id)}"]`),
    ].filter(Boolean);

    for (const el of candidates) {
      if (
        el.matches(
          "input, button, textarea, select, [role='button'], [role='combobox'], [aria-haspopup], [data-uxi-widget-type='selectinput']"
        )
      ) {
        return el;
      }
      const inner = el.querySelector(
        "input:not([type=hidden]), button[aria-haspopup], button, textarea, select, [role='combobox'], [data-uxi-widget-type='selectinput']"
      );
      if (inner) return inner;
    }
    return null;
  }

  async function pickWorkdayById(id, opts) {
    const trigger = workdayTriggerFor(id);
    return pickWorkdayDropdown(trigger, opts);
  }

  function workdayOptionLabel(o) {
    return (
      o.getAttribute("data-automation-label") ||
      o.getAttribute("aria-label") ||
      o.textContent ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s+(not )?checked$/i, "");
  }

  function listWorkdayPromptOptions() {
    // Options often render in a body-level portal, not inside the field wrapper.
    // Prefer the open popup root, but always fall back to a document-wide scan.
    const portal =
      document.querySelector('[data-automation-id="responsiveMonikerPrompt"]') ||
      document.querySelector('[data-uxi-widget-type="prompt"]') ||
      document.querySelector('[data-automation-id="menuItem"][role="option"]')?.closest(
        '[data-uxi-widget-type], [data-automation-id*="prompt"], [role="listbox"]'
      ) ||
      null;
    const roots = portal ? [portal, document] : [document];
    const optionSelectors = [
      '[data-automation-id="menuItem"][role="option"]',
      '[data-automation-id="promptOption"]',
      '[data-automation-id="promptLeafNode"]',
      '[data-automation-id*="promptOption"]',
      '[data-uxi-widget-type="multiselectlistitem"]',
      '[data-uxi-widget-type="selectinputlistitem"]',
      '[role="option"]',
    ];

    for (const root of roots) {
      for (const sel of optionSelectors) {
        const options = Array.from(root.querySelectorAll(sel)).filter((o) => {
          if (o.getAttribute("data-automation-id") === "selectedItem") return false;
          if (o.closest('[data-automation-id="selectedItemList"]')) return false;
          const t = workdayOptionLabel(o);
          if (!t) return false;
          // Skip the search box row if it ever matches as an option.
          if (/^search$/i.test(t)) return false;
          const r = o.getBoundingClientRect();
          if (!(r.width > 0 || r.height > 0 || o.offsetParent !== null)) return false;
          // Must be in (or near) the viewport-ish popup — ignore off-page ghosts.
          if (r.bottom < 0 || r.top > window.innerHeight + 50) return false;
          return true;
        });
        if (options.length) {
          // De-dupe nested promptOption inside menuItem (keep the outer row).
          const seen = new Set();
          const rows = [];
          for (const o of options) {
            const row =
              o.closest('[data-automation-id="menuItem"]') ||
              o.closest('[role="option"]') ||
              o;
            if (seen.has(row)) continue;
            seen.add(row);
            rows.push({ o: row, t: workdayOptionLabel(row) });
          }
          if (rows.length) return rows;
        }
      }
    }
    return [];
  }

  function fireWorkdayClick(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (_) {}
    try {
      el.focus({ preventScroll: true });
    } catch (_) {}
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      buttons: 1,
      detail: 1,
      clientX: x,
      clientY: y,
    };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(type, opts));
    }
    if (typeof el.click === "function") el.click();
  }

  function workdaySideCharm(row) {
    if (!row) return null;
    const svg = row.querySelector("svg.wd-icon-chevron-right-small");
    if (!svg) return null;
    // Autodesk: click the chevron wrapper (hassidecharm), not the label — label only focuses.
    return svg.parentElement && svg.parentElement.parentElement
      ? svg.parentElement.parentElement
      : svg.parentElement;
  }

  async function openWorkdayPrompt(trigger) {
    if (!trigger || !isVisible(trigger)) return false;
    closeWorkdayPopup();
    await sleep(150);
    trigger.focus();
    fireWorkdayClick(trigger);
    if (
      trigger.matches("input") ||
      trigger.getAttribute("data-uxi-widget-type") === "selectinput"
    ) {
      await sleep(80);
      trigger.click();
    }
    await sleep(450);
    return (
      listWorkdayPromptOptions().length > 0 ||
      !!document.querySelector('[data-automation-id="responsiveMonikerPrompt"]')
    );
  }

  async function typeWorkdayPromptSearch(text) {
    // Prefer the search inside the open prompt (id often "selectInputId-"), not the field.
    const promptSearch =
      document.querySelector(
        '[data-automation-id="responsiveMonikerPrompt"] input[placeholder*="Search" i]'
      ) ||
      document.getElementById("selectInputId-") ||
      document.querySelector(
        '[data-automation-id="promptSearchBox"] input, [data-automation-id="promptSearchInput"]'
      );
    const search = promptSearch;
    if (!search) {
      await sleep(120);
      return null;
    }
    search.focus();
    setNativeValue(search, "");
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(50);
    if (text) {
      setNativeValue(search, text);
      search.dispatchEvent(new Event("input", { bubbles: true }));
      search.dispatchEvent(
        new KeyboardEvent("keyup", {
          bubbles: true,
          key: text.slice(-1) || "a",
          keyCode: 65,
        })
      );
      await sleep(650);
    } else {
      await sleep(250);
    }
    return search;
  }

  async function clickWorkdayPromptOption(match, { drill = false } = {}) {
    const options = listWorkdayPromptOptions().filter(({ t }) => match(t));
    if (!options.length) return false;
    options.sort((a, b) => a.t.length - b.t.length);
    const target = options[0].o;
    if (drill) {
      const charm = workdaySideCharm(target);
      if (charm) {
        fireWorkdayClick(charm);
        await sleep(500);
        return true;
      }
    }
    const labelEl =
      target.querySelector('[data-automation-id="promptOption"]') ||
      target.querySelector("[data-automation-label]") ||
      target;
    fireWorkdayClick(labelEl);
    await sleep(280);
    return true;
  }

  function sourceShowsLinkedIn(trigger) {
    const wrap =
      document.querySelector('[data-automation-id="formField-source"]') ||
      (trigger && trigger.closest('[data-automation-id^="formField-"]')) ||
      (trigger && trigger.parentElement);
    if (!wrap) return false;
    // Selected chips live in selectedItemList — ignore the open options popup.
    const selected = wrap.querySelectorAll(
      '[data-automation-id="selectedItemList"] [data-automation-id="menuItem"], [data-automation-id="selectedItemList"] [data-automation-id="selectedItem"], [data-automation-id="selectedItem"]'
    );
    if (
      Array.from(selected).some((el) => /\blinkedin\b/i.test(el.textContent || ""))
    ) {
      return true;
    }
    // Fallback: "1 item selected" / chip text next to the field.
    const list = wrap.querySelector('[data-automation-id="selectedItemList"]');
    return !!(list && /\blinkedin\b/i.test(list.textContent || ""));
  }

  async function waitForWorkdayOptions(predicate, ms = 1800) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const opts = listWorkdayPromptOptions();
      if (predicate(opts)) return opts;
      await sleep(150);
    }
    return listWorkdayPromptOptions();
  }

  async function scrollWorkdayListForOption(match, ms = 5000) {
    const list = document.querySelector('[data-automation-id="activeListContainer"]');
    const start = Date.now();
    let hit = listWorkdayPromptOptions().find(({ t }) => match(t));
    if (hit) return hit.o;
    if (!list) return null;

    const max = Math.max(list.scrollHeight || 0, 2500);
    for (let y = 0; y <= max && Date.now() - start < ms; y += 120) {
      list.scrollTop = y;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(35);
      hit = listWorkdayPromptOptions().find(({ t }) => match(t));
      if (hit) return hit.o;
    }
    // Keyboard fallback if scroll didn't virtualize.
    const first = listWorkdayPromptOptions()[0];
    if (first && first.o) {
      try {
        first.o.focus();
      } catch (_) {}
      fireWorkdayClick(first.o);
      await sleep(80);
    }
    for (let i = 0; i < 80 && Date.now() - start < ms; i++) {
      const active = document.activeElement || (first && first.o);
      if (active) {
        active.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "ArrowDown",
            code: "ArrowDown",
            keyCode: 40,
            which: 40,
          })
        );
      }
      await sleep(30);
      hit = listWorkdayPromptOptions().find(({ t }) => match(t));
      if (hit) return hit.o;
    }
    return null;
  }

  async function clickWorkdayDone() {
    return dismissWorkdayPopup();
  }

  // Autodesk live form (wd1): hierarchical multiselect.
  // - Root rows with svg.wd-icon-chevron-right-small must be opened via the chevron
  //   (clicking the label only focuses). Search does NOT find LinkedIn at root.
  // - Under Job Board, LinkedIn is mid virtualized list — scroll to it, then Done.
  async function fillWorkdaySourceLinkedIn() {
    let trigger =
      document.getElementById("source--source") ||
      workdayTriggerFor("formField-source") ||
      workdayTriggerFor("source");
    if (!trigger || !isVisible(trigger)) {
      const label = Array.from(document.querySelectorAll("label, h3, h4, legend")).find((el) =>
        /how did you hear/i.test(el.textContent || "")
      );
      if (label) {
        const wrap =
          label.closest('[data-automation-id^="formField-"]') || label.parentElement;
        trigger =
          (wrap &&
            wrap.querySelector(
              'input#source--source, input[data-uxi-widget-type="selectinput"], input[id*="source" i]'
            )) ||
          null;
      }
    }
    if (!trigger || !isVisible(trigger)) return false;
    if (sourceShowsLinkedIn(trigger)) {
      if (workdayPopupOpen()) await dismissWorkdayPopup();
      return true;
    }

    const leafMatch = (t) => /^linkedin$/i.test(String(t || "").trim());
    const parents = [
      { match: (t) => /^job\s*boards?$/i.test(String(t || "").trim()), name: "Job Board" },
      {
        match: (t) => /^social\s*networking$/i.test(String(t || "").trim()),
        name: "Social Networking",
      },
      { match: (t) => /^socially$/i.test(String(t || "").trim()), name: "Socially" },
      { match: (t) => /^social\s*media$/i.test(String(t || "").trim()), name: "Social Media" },
    ];

    async function selectLinkedInLeaf(leafEl) {
      if (!leafEl) return false;
      const opt =
        leafEl.querySelector('[data-automation-id="promptOption"]') || leafEl;
      const radio = leafEl.querySelector(
        '[data-automation-id="radioBtn"], input[type="radio"]'
      );
      // Radio leaf: click radio then label so the chip commits.
      if (radio) fireWorkdayClick(radio);
      fireWorkdayClick(opt);
      fireWorkdayClick(leafEl);
      await sleep(350);
      // Nested Job Board view stays open until Done (unlike State PromptSelect).
      await dismissWorkdayPopup();
      await sleep(200);
      return sourceShowsLinkedIn(trigger);
    }

    if (!(await openWorkdayPrompt(trigger))) return false;
    // Clear any filter on the prompt search (not the field itself).
    await typeWorkdayPromptSearch("");
    await waitForWorkdayOptions((opts) => opts.length > 0, 1500);

    // Direct leaf if present at this level.
    {
      const leaf = await scrollWorkdayListForOption(leafMatch, 1500);
      if (leaf && (await selectLinkedInLeaf(leaf))) return true;
    }

    for (const parent of parents) {
      // Ensure we're on the category root.
      if (!listWorkdayPromptOptions().some(({ t }) => parent.match(t))) {
        const back = document.querySelector('[data-automation-id="backButton"]');
        if (back) {
          fireWorkdayClick(back);
          await sleep(350);
        }
      }
      if (!listWorkdayPromptOptions().some(({ t }) => parent.match(t))) {
        await dismissWorkdayPopup();
        await sleep(120);
        if (!(await openWorkdayPrompt(trigger))) continue;
        await typeWorkdayPromptSearch("");
        await waitForWorkdayOptions((opts) => opts.some(({ t }) => parent.match(t)), 1200);
      }
      if (!listWorkdayPromptOptions().some(({ t }) => parent.match(t))) continue;

      // CRITICAL: click chevron side-charm, not the row text.
      if (!(await clickWorkdayPromptOption(parent.match, { drill: true }))) continue;

      await waitForWorkdayOptions(
        (opts) =>
          opts.length > 0 &&
          (opts.some(({ t }) => leafMatch(t)) || !opts.some(({ t }) => parent.match(t))),
        2000
      );

      // Autodesk Job Board list does not filter on "LinkedIn" — scroll the virtual list.
      let leafEl = await scrollWorkdayListForOption(leafMatch, 6000);
      if (!leafEl) {
        await typeWorkdayPromptSearch("LinkedIn");
        leafEl = await scrollWorkdayListForOption(leafMatch, 2000);
        await typeWorkdayPromptSearch("");
      }
      if (!leafEl) {
        const back = document.querySelector('[data-automation-id="backButton"]');
        if (back) fireWorkdayClick(back);
        await sleep(300);
        continue;
      }

      if (await selectLinkedInLeaf(leafEl)) return true;
    }

    await dismissWorkdayPopup();
    return sourceShowsLinkedIn(trigger);
  }

  // Prefer first matching selector; supports modern + legacy Workday id schemes.
  function collectKnownAny(groups) {
    const items = [];
    for (const [selectors, key] of groups) {
      for (const sel of selectors) {
        const el = resolveInput(document.querySelector(sel));
        if (el) {
          items.push({ el, key });
          break;
        }
      }
    }
    return items;
  }

  // Workday country lists use full names ("United States of America"), not ISO.
  const WD_COUNTRY_ALIASES = {
    us: ["united states of america", "united states", "usa"],
    usa: ["united states of america", "united states", "usa"],
    "united states": ["united states of america", "united states", "usa"],
    "united states of america": ["united states of america", "united states", "usa"],
    in: ["india"],
    india: ["india"],
    uk: ["united kingdom"],
    "united kingdom": ["united kingdom"],
    ca: ["canada"],
    canada: ["canada"],
    au: ["australia"],
    australia: ["australia"],
    de: ["germany"],
    germany: ["germany"],
  };

  function matchCountryOption(profileCountry) {
    const want = (profileCountry || "").toLowerCase().trim();
    const aliases = WD_COUNTRY_ALIASES[want] || [want];
    return (t) => {
      const s = t.toLowerCase().trim();
      // Exact / prefix-with-separator only — never bare startsWith ("India" ≠ "Indiana").
      return aliases.some(
        (a) => s === a || s.startsWith(a + " ") || s.startsWith(a + "(") || s.startsWith(a + ",")
      );
    };
  }

  // Fold accents so Workday's "Mahārāshtra" still matches profile "Maharashtra".
  function foldStateText(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Workday India (and many tenants) list regions as ISO codes: "IN-MH", "MH",
  // or odd official spellings (Orissa, Uttaranchal). Expand profile state → aliases.
  const IN_STATE_ALIASES = {
    "andaman and nicobar islands": ["an", "in-an", "andaman", "andaman nicobar"],
    "andhra pradesh": ["ap", "in-ap"],
    "arunachal pradesh": ["ar", "in-ar"],
    assam: ["as", "in-as"],
    bihar: ["br", "in-br"],
    chandigarh: ["ch", "in-ch", "chd"],
    chhattisgarh: ["ct", "in-ct", "cg", "chattisgarh"],
    "dadra and nagar haveli and daman and diu": [
      "dh",
      "in-dh",
      "dn",
      "in-dn",
      "dd",
      "in-dd",
      "dadra and nagar haveli",
      "daman and diu",
      "dnh",
      "dnhdd",
    ],
    delhi: ["dl", "in-dl", "nct of delhi", "nct delhi", "new delhi", "delhi nct"],
    goa: ["ga", "in-ga"],
    gujarat: ["gj", "in-gj", "guj"],
    haryana: ["hr", "in-hr"],
    "himachal pradesh": ["hp", "in-hp"],
    "jammu and kashmir": ["jk", "in-jk"],
    "jammu & kashmir": ["jk", "in-jk", "jammu and kashmir"],
    jharkhand: ["jh", "in-jh"],
    karnataka: ["ka", "in-ka", "krn"],
    kerala: ["kl", "in-kl", "ker"],
    ladakh: ["la", "in-la"],
    lakshadweep: ["ld", "in-ld", "lkp"],
    "madhya pradesh": ["mp", "in-mp"],
    maharashtra: ["mh", "in-mh", "mah"],
    manipur: ["mn", "in-mn", "mnp"],
    meghalaya: ["ml", "in-ml", "meg"],
    mizoram: ["mz", "in-mz", "miz"],
    nagaland: ["nl", "in-nl", "nld"],
    odisha: ["or", "in-or", "od", "orissa"],
    orissa: ["or", "in-or", "od", "odisha"],
    puducherry: ["py", "in-py", "pdy", "pondicherry"],
    pondicherry: ["py", "in-py", "puducherry"],
    punjab: ["pb", "in-pb"],
    rajasthan: ["rj", "in-rj", "raj"],
    sikkim: ["sk", "in-sk", "skm"],
    "tamil nadu": ["tn", "in-tn", "tamilnadu"],
    telangana: ["tg", "in-tg", "ts", "in-ts"],
    tripura: ["tr", "in-tr", "trp"],
    "uttar pradesh": ["up", "in-up"],
    uttarakhand: ["ut", "in-ut", "uk", "ua", "uttaranchal"],
    uttaranchal: ["ut", "in-ut", "uk", "ua", "uttarakhand"],
    "west bengal": ["wb", "in-wb"],
  };

  const US_STATE_ALIASES = {
    alabama: ["al", "us-al"],
    alaska: ["ak", "us-ak"],
    arizona: ["az", "us-az"],
    arkansas: ["ar", "us-ar"],
    california: ["ca", "us-ca"],
    colorado: ["co", "us-co"],
    connecticut: ["ct", "us-ct"],
    delaware: ["de", "us-de"],
    florida: ["fl", "us-fl"],
    georgia: ["ga", "us-ga"],
    hawaii: ["hi", "us-hi"],
    idaho: ["id", "us-id"],
    illinois: ["il", "us-il"],
    indiana: ["in", "us-in"],
    iowa: ["ia", "us-ia"],
    kansas: ["ks", "us-ks"],
    kentucky: ["ky", "us-ky"],
    louisiana: ["la", "us-la"],
    maine: ["me", "us-me"],
    maryland: ["md", "us-md"],
    massachusetts: ["ma", "us-ma"],
    michigan: ["mi", "us-mi"],
    minnesota: ["mn", "us-mn"],
    mississippi: ["ms", "us-ms"],
    missouri: ["mo", "us-mo"],
    montana: ["mt", "us-mt"],
    nebraska: ["ne", "us-ne"],
    nevada: ["nv", "us-nv"],
    "new hampshire": ["nh", "us-nh"],
    "new jersey": ["nj", "us-nj"],
    "new mexico": ["nm", "us-nm"],
    "new york": ["ny", "us-ny"],
    "north carolina": ["nc", "us-nc"],
    "north dakota": ["nd", "us-nd"],
    ohio: ["oh", "us-oh"],
    oklahoma: ["ok", "us-ok"],
    oregon: ["or", "us-or"],
    pennsylvania: ["pa", "us-pa"],
    "rhode island": ["ri", "us-ri"],
    "south carolina": ["sc", "us-sc"],
    "south dakota": ["sd", "us-sd"],
    tennessee: ["tn", "us-tn"],
    texas: ["tx", "us-tx"],
    utah: ["ut", "us-ut"],
    vermont: ["vt", "us-vt"],
    virginia: ["va", "us-va"],
    washington: ["wa", "us-wa"],
    "west virginia": ["wv", "us-wv"],
    wisconsin: ["wi", "us-wi"],
    wyoming: ["wy", "us-wy"],
    "district of columbia": ["dc", "us-dc", "washington dc", "washington d c"],
  };

  function expandStateAliases(rawState, country) {
    const folded = foldStateText(rawState);
    if (!folded) return [];
    const out = new Set([folded, folded.replace(/\s/g, "")]);

    // Accept "IN-MH" / "IN_MH" / "MH" typed in the profile.
    const iso = folded.match(/^(?:in|us)\s*([a-z]{2})$/);
    if (iso) out.add(iso[1]);
    const bare = folded.match(/^([a-z]{2})$/);
    if (bare) out.add(bare[1]);

    const countryFold = foldStateText(country);
    const tables = [];
    if (!countryFold || /india|\bin\b/.test(countryFold) || folded.startsWith("in ")) {
      tables.push(IN_STATE_ALIASES);
    }
    if (
      !countryFold ||
      /united states|\busa\b|\bus\b/.test(countryFold) ||
      folded.startsWith("us ")
    ) {
      tables.push(US_STATE_ALIASES);
    }
    if (!tables.length) tables.push(IN_STATE_ALIASES, US_STATE_ALIASES);

    for (const table of tables) {
      for (const [name, codes] of Object.entries(table)) {
        const nameFold = foldStateText(name);
        const codeFolds = codes.map(foldStateText);
        const hit =
          folded === nameFold ||
          codeFolds.includes(folded) ||
          codeFolds.includes(folded.replace(/\s/g, "-")) ||
          codeFolds.includes(folded.replace(/\s/g, ""));
        if (!hit) continue;
        out.add(nameFold);
        out.add(nameFold.replace(/\s/g, ""));
        for (const c of codeFolds) {
          out.add(c);
          // Also "in mh" from "in-mh"
          out.add(c.replace(/-/g, " "));
        }
      }
    }
    return Array.from(out).filter(Boolean);
  }

  function matchStateOption(profileState, country) {
    const aliases = expandStateAliases(profileState, country);
    return (t) => {
      const s = foldStateText(t);
      if (!s || !aliases.length) return false;
      if (aliases.some((a) => s === a)) return true;
      // "IN-MH" / "MH - Maharashtra" / "Maharashtra (IN-MH)"
      if (aliases.some((a) => a.length >= 2 && (s.includes(a) || a.includes(s)))) {
        // Guard short codes: require code as its own token ("mh" in "in mh", not inside another word).
        return aliases.some((a) => {
          if (a.length <= 2) {
            return new RegExp(`(?:^|\\s)${a}(?:\\s|$)`).test(s);
          }
          return s === a || s.includes(a) || a.includes(s);
        });
      }
      return false;
    };
  }

  function stateTypeaheadCandidates(profileState, country) {
    const aliases = expandStateAliases(profileState, country);
    const raw = String(profileState || "").trim();
    const preferred = [];
    if (raw) preferred.push(raw);
    // Prefer full names, then ISO (IN-MH), then short (MH).
    const names = aliases.filter((a) => a.length > 3 && !/^(in|us)\s/.test(a));
    const isos = aliases.filter((a) => /^(in|us)\s[a-z]{2}$/.test(a) || /^(in|us)-[a-z]{2}$/.test(a));
    const shorts = aliases.filter((a) => /^[a-z]{2}$/.test(a));
    for (const list of [names, isos.map((a) => a.replace(/\s/g, "-").toUpperCase()), shorts.map((a) => a.toUpperCase())]) {
      for (const x of list) {
        if (x && !preferred.some((p) => foldStateText(p) === foldStateText(x))) {
          preferred.push(x);
        }
      }
    }
    return preferred.slice(0, 6);
  }

  async function fillWorkdayEEODecline() {
    let filled = 0;
    const labelNodes = Array.from(
      document.querySelectorAll("label, legend, h3, h4, [data-automation-id*='label']")
    );
    for (const label of labelNodes) {
      const text = (label.textContent || "").toLowerCase();
      if (
        !/(gender|sex|race|ethnic|hispanic|veteran|disability|disabled|lgbt|orientation|pronoun)/.test(
          text
        )
      ) {
        continue;
      }
      const root =
        label.closest("[data-automation-id]") ||
        label.closest("fieldset") ||
        label.parentElement ||
        label;
      const select = root.querySelector("select");
      if (select && isVisible(select)) {
        const current = select.options[select.selectedIndex];
        const curText = ((current && current.textContent) || "").trim();
        if (curText && !/select one|select an option|choose/i.test(curText)) continue;
        const opt = Array.from(select.options).find((o) => DECLINE_RE.test(o.textContent));
        if (opt) {
          setNativeValue(select, opt.value);
          filled++;
        }
        continue;
      }
      const trigger = root.querySelector(
        'button[aria-haspopup], [role="combobox"], input[role="combobox"], button[data-automation-id], [data-automation-id*="dropDown"], [data-automation-id*="dropdown"]'
      );
      if (trigger && isVisible(trigger)) {
        if (!isWorkdaySelectOneEmpty(trigger)) continue; // already answered from profile
        const ok = await pickWorkdayDropdown(trigger, {
          match: (t) =>
            DECLINE_RE.test(t) ||
            /opt out|do not (wish|want)|don't (wish|want)|decline|prefer not|not to self|i do not want to answer/i.test(
              t
            ),
        });
        if (ok) filled++;
        continue;
      }
      const radios = Array.from(root.querySelectorAll('input[type="radio"]'));
      if (radios.some((r) => r.checked)) continue;
      for (const r of radios) {
        const ctx = getFieldContext(r) + " " + (r.value || "");
        if (DECLINE_RE.test(ctx)) {
          r.click();
          filled++;
          break;
        }
      }
    }
    return filled;
  }

  async function fillWorkdayDropdowns(profile, settings) {
    let filled = 0;

    // Phone device type — button#phoneNumber--phoneType / formField-phoneType
    if (
      (await pickWorkdayById("formField-phoneType", {
        match: (t) => /^(mobile|cell|cellphone|cellular)$/i.test(t.trim()) || /^mobile\b/i.test(t),
      })) ||
      (await pickWorkdayById("phone-device-type", {
        match: (t) => /^(mobile|cell|cellphone|cellular)$/i.test(t.trim()) || /^mobile\b/i.test(t),
      }))
    ) {
      filled++;
    }

    // Phone country code — multiselect input #phoneNumber--countryPhoneCode
    if (profile.country || profile.phoneCountryCode) {
      const phoneCodeOpts = {
        typeahead: profile.country || String(profile.phoneCountryCode || ""),
        match: profile.country
          ? (t) =>
              matchCountryOption(profile.country)(t) ||
              (profile.phoneCountryCode &&
                t.includes(String(profile.phoneCountryCode)))
          : (t) => t.includes(String(profile.phoneCountryCode)),
      };
      // Skip if a chip is already selected (e.g. "India (+91)").
      const phoneCodeWrap =
        wdEl("formField-countryPhoneCode") ||
        document.getElementById("phoneNumber--countryPhoneCode");
      const already =
        phoneCodeWrap &&
        phoneCodeWrap
          .closest("[data-automation-id='formField-countryPhoneCode'], [data-uxi-widget-type='multiselect']")
          ?.querySelector('[data-automation-id="selectedItem"]');
      if (!already) {
        if (await pickWorkdayById("formField-countryPhoneCode", phoneCodeOpts)) filled++;
        else if (await pickWorkdayById("countryPhoneCode", phoneCodeOpts)) filled++;
        else if (await pickWorkdayById("phone-code", phoneCodeOpts)) filled++;
      }
    }

    // Address country — button#country--country / formField-country
    if (profile.country) {
      const opts = {
        typeahead: profile.country,
        match: matchCountryOption(profile.country),
      };
      for (const id of [
        "formField-country",
        "addressSection_countryRegion",
        "countryDropdown",
        "country",
        "address--country",
      ]) {
        if (await pickWorkdayById(id, opts)) {
          filled++;
          await sleep(500); // province list is country-dependent
          break;
        }
      }
    }

    if (profile.state) {
      const match = matchStateOption(profile.state, profile.country);
      const typeaheads = stateTypeaheadCandidates(profile.state, profile.country);
      const stateIds = [
        "formField-countryRegion",
        "formField-address--countryRegion",
        "address--countryRegion",
        "formField-province",
        "formField-state",
        "formField-region",
        "addressSection_countryRegion_province",
        "addressSection_province",
        "address--region",
        "province",
        "state",
        "countryRegion",
        "region",
      ];
      // Resolve the visible state/region control once, then try name → IN-MH → MH.
      let trigger = null;
      for (const id of stateIds) {
        const t = workdayTriggerFor(id);
        if (t && isVisible(t)) {
          trigger = t;
          break;
        }
      }
      if (trigger) {
        let stateOk = false;
        for (const ta of typeaheads) {
          if (await pickWorkdayDropdown(trigger, { typeahead: ta, match })) {
            stateOk = true;
            break;
          }
        }
        if (!stateOk) {
          stateOk = await pickWorkdayDropdown(trigger, { typeahead: "", match });
        }
        if (stateOk) filled++;
      }
    }

    // Source ("How did you hear?") — often hierarchical:
    // Autodesk: Job Board → LinkedIn (search won't find LinkedIn directly).
    // Others: Socially → LinkedIn, or LinkedIn as a top-level option.
    if (await fillWorkdaySourceLinkedIn()) filled++;

    // "Previously worked here?" — default No (safe; never invents employment).
    const prevNo = document.querySelector(
      'input[name="candidateIsPreviousWorker"][value="false"]'
    );
    if (prevNo && isVisible(prevNo) && !prevNo.checked) {
      prevNo.click();
      filled++;
    }

    // EEO / demographics are filled in fillWorkdayDemographics (profile values
    // first, then autoDeclineEEO) — not here.

    return filled;
  }

  // Profile preference → Yes/No. Empty / unset → null (leave the field alone).
  function prefYesNo(value) {
    const v = String(value || "")
      .trim()
      .toLowerCase();
    if (v === "yes" || v === "true" || v === "y") return "yes";
    if (v === "no" || v === "false" || v === "n") return "no";
    if (v === "prefer_not_to_say" || v === "decline" || v === "prefer not to say") {
      return "prefer_not_to_say";
    }
    return null;
  }

  function matchYesNoOption(answer) {
    if (answer === "prefer_not_to_say") {
      return (t) =>
        /prefer not|decline to|don'?t wish|do not wish|rather not/i.test(t) ||
        /^decline$/i.test(t.trim());
    }
    if (answer === "yes") {
      return (t) => /^(yes|y)\b/i.test(t.trim()) || /^true$/i.test(t.trim());
    }
    if (answer === "no") {
      return (t) => /^(no|n)\b/i.test(t.trim()) || /^false$/i.test(t.trim());
    }
    return () => false;
  }

  // Map questionnaire wording → answer. Store facts in profile; match by intent.
  function resolveWorkdayQuestionAnswer(questionText, profile) {
    const q = String(questionText || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!q || q.length < 8) return null;

    // Required honesty / acknowledgment — always Yes when the form asks for it.
    if (
      /acknowledge|truthfully and accurately|please enter\s*["']?yes|i have answered them truthfully|conditioned upon the truth/i.test(
        q
      )
    ) {
      return "yes";
    }

    // More specific intents first.
    if (/non-?compete|non-?solicitation/.test(q)) {
      return prefYesNo(profile.hasNonCompete);
    }
    if (
      /sponsor|visa|immigration filing|work permit|permanent residenc/.test(q) &&
      /require|need|future|now or/.test(q)
    ) {
      return prefYesNo(profile.needsSponsorship);
    }
    if (
      /authori[sz]ed to work|work authori[sz]ation|legally (able|eligible) to work|eligible to work/.test(
        q
      ) &&
      !/sponsor|visa|immigration filing/.test(q)
    ) {
      return prefYesNo(profile.workAuthorized);
    }
    if (/relocat/.test(q)) {
      return prefYesNo(profile.willingToRelocate);
    }
    if (
      ((/\b18\b/.test(q) && /\bage\b|\bold(?:er)?\b|\byears?\b|\byrs?\b/.test(q)) ||
        /\b18\s*\+/.test(q) ||
        /legal(?:ly)? (?:working )?age/.test(q) ||
        /old enough to (?:legally )?work/.test(q)) &&
      !/experience/.test(q)
    ) {
      return prefYesNo(profile.isOfLegalWorkingAge);
    }
    if (
      /government (employee|official)|united states government|u\.?s\.? government|federal (government )?employee/.test(
        q
      ) &&
      !/related to/.test(q)
    ) {
      return prefYesNo(profile.isGovernmentEmployee);
    }
    if (
      /related to.*(employee|workday|customer|government official)|conflict of interest|relative.*(employ|work)/.test(
        q
      )
    ) {
      return prefYesNo(profile.relatedToCompany);
    }
    if (/criminal|convict|felon|misdemeanor/.test(q)) {
      return prefYesNo(profile.hasCriminalRecord);
    }

    // Company / compliance defaults when we have no profile fact — safe negatives
    // for standard required screens (never invents employment or restricted status).
    if (
      /export control|iran|cuba|north korea|syria|crimea|donetsk|luhansk|sanctioned/.test(
        q
      )
    ) {
      return "no";
    }
    if (/ernst\s*&\s*young|ernst and young|\bey\b.*auditor|independent auditor/.test(q)) {
      return "no";
    }
    if (/use or work on the workday system|work on the workday system|use the workday system/.test(q)) {
      return "no";
    }
    if (/previously (worked|employed)|former employee of (this|the) (company|employer)/.test(q)) {
      return "no";
    }

    return null;
  }

  function workdayFormFieldQuestionText(root) {
    if (!root) return "";
    const label =
      root.querySelector(
        'label, legend, [data-automation-id$="label"], [data-automation-id*="FormFieldLabel"], [id$="-label"]'
      ) || null;
    let raw = label ? label.textContent || "" : "";
    if (!raw || raw.length < 12) {
      // Fall back to wrapper text minus the control chrome.
      const clone = root.cloneNode(true);
      clone
        .querySelectorAll(
          "input, button, select, textarea, [role='listbox'], [data-automation-id='errorMessage'], [data-automation-id*='error']"
        )
        .forEach((n) => n.remove());
      raw = clone.textContent || "";
    }
    return raw
      .replace(/\s+/g, " ")
      .replace(/\bSelect One\b/gi, "")
      .replace(/\bError:.*$/gi, "")
      .replace(/\*\s*$/g, "")
      .trim();
  }

  function isWorkdaySelectOneEmpty(trigger) {
    if (!trigger) return false;
    if (trigger.tagName === "SELECT") {
      const opt = trigger.options[trigger.selectedIndex];
      const t = ((opt && opt.textContent) || trigger.value || "").trim();
      return !t || /select one|select an option|choose/i.test(t);
    }
    const t = (trigger.value || trigger.textContent || "").replace(/\s+/g, " ").trim();
    return !t || /select one|select an option|search|choose/i.test(t);
  }

  async function pickWorkdayYesNoRadio(root, answer) {
    const radios = Array.from(root.querySelectorAll('input[type="radio"]')).filter(
      (el) => isVisible(el)
    );
    if (!radios.length) return false;
    const wantYes = answer === "yes";
    const wantNo = answer === "no";
    for (const r of radios) {
      const ctx = (
        getFieldContext(r) +
        " " +
        (r.value || "") +
        " " +
        (r.getAttribute("aria-label") || "")
      ).toLowerCase();
      const hit =
        (wantYes &&
          (/^(yes|true|y)$/i.test(String(r.value || "").trim()) ||
            /\byes\b/.test(ctx))) ||
        (wantNo &&
          (/^(no|false|n)$/i.test(String(r.value || "").trim()) ||
            /\bno\b/.test(ctx) && !/\bnot\b/.test(ctx)));
      if (hit) {
        if (!r.checked) r.click();
        return true;
      }
    }
    return false;
  }

  // Application Questions / Voluntary Disclosures: Yes/No PromptSelects + radios.
  async function fillWorkdayApplicationQuestions(profile) {
    let filled = 0;
    const roots = Array.from(
      document.querySelectorAll('[data-automation-id^="formField-"]')
    );
    // Also catch question blocks that aren't formField-* (some tenants).
    const extra = Array.from(
      document.querySelectorAll(
        '[data-automation-id*="questionnaire"], [data-automation-id*="Questionnaire"], fieldset, [role="group"]'
      )
    ).filter((el) => !el.closest('[data-automation-id^="formField-"]'));

    const seen = new Set();
    const candidates = [...roots, ...extra];

    for (const root of candidates) {
      if (!root || !isVisible(root)) continue;
      if (seen.has(root)) continue;
      seen.add(root);

      const autoId = (root.getAttribute("data-automation-id") || "").toLowerCase();
      // Skip identity / address / experience widgets handled elsewhere.
      if (
        /legalname|phonenumber|phonetype|countryphonecode|addressline|postalcode|formfield-city$|formfield-country$|formfield-source|previousworker|skills|webaddress|jobtitle|companyname|education|certification|dateSection|resume|file-upload|attachments/.test(
          autoId
        )
      ) {
        continue;
      }

      const question = workdayFormFieldQuestionText(root);
      const answer = resolveWorkdayQuestionAnswer(question, profile);
      if (!answer) continue;
      // Prefer-not-to-say only when the control offers it; otherwise skip.
      if (answer === "prefer_not_to_say") {
        // Try dropdown match; if none, leave blank.
      }

      if (await pickWorkdayYesNoRadio(root, answer)) {
        filled++;
        continue;
      }

      const nativeSelect = root.querySelector("select");
      if (nativeSelect && isVisible(nativeSelect)) {
        const match = matchYesNoOption(answer);
        const opts = Array.from(nativeSelect.options);
        const hit = opts.find((o) => match(o.textContent || o.value || ""));
        if (hit) {
          nativeSelect.value = hit.value;
          nativeSelect.dispatchEvent(new Event("input", { bubbles: true }));
          nativeSelect.dispatchEvent(new Event("change", { bubbles: true }));
          filled++;
          continue;
        }
      }

      const trigger =
        root.querySelector(
          'button[aria-haspopup], button[aria-haspopup="listbox"], [role="combobox"], button[id], [data-uxi-widget-type="selectinput"]'
        ) || null;
      if (!trigger || !isVisible(trigger)) continue;
      if (!isWorkdaySelectOneEmpty(trigger) && matchYesNoOption(answer)(
        (trigger.value || trigger.textContent || "").replace(/\s+/g, " ").trim()
      )) {
        continue; // already correct
      }

      const ok = await pickWorkdayDropdown(trigger, {
        match: matchYesNoOption(answer),
      });
      if (ok) filled++;
      await sleep(120);
    }

    return filled;
  }

  function declineOptionMatch(t) {
    return (
      DECLINE_RE.test(t) ||
      /opt out|do not (wish|want)|don't (wish|want)|not to self|i do not want to answer|i don't want to answer/i.test(
        t
      )
    );
  }

  // Profile demographic value → option matcher. Unset → decline if autoDeclineEEO.
  function demographicValueMatch(value, byValue, settings) {
    const v = String(value || "")
      .trim()
      .toLowerCase();
    if (!v) {
      return settings && settings.autoDeclineEEO ? declineOptionMatch : null;
    }
    if (v === "prefer_not_to_say") return declineOptionMatch;
    return byValue[v] || null;
  }

  // Voluntary Disclosures + Self Identify — map question intent → Demographics.
  function resolveWorkdayDemographicMatch(questionText, profile, settings) {
    const q = String(questionText || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!q || q.length < 4) return null;

    // Orientation before bare "sex".
    if (/sexual orientation|lgbtq?|\bsexuality\b/.test(q)) {
      return demographicValueMatch(
        profile.sexualOrientation,
        {
          heterosexual: (t) => /heterosexual|\bstraight\b/i.test(t),
          gay_lesbian: (t) => /\bgay\b|\blesbian\b/i.test(t),
          bisexual: (t) => /bisexual/i.test(t),
          other: (t) =>
            /^(other)\b/i.test(t.trim()) ||
            /self.?describe|not listed|prefer to self/i.test(t),
        },
        settings
      );
    }

    if (/\bgender\b|\bsex\b/.test(q) && !/orientation|sexual/.test(q)) {
      return demographicValueMatch(
        profile.gender,
        {
          male: (t) => /^(male|man)\b/i.test(t.trim()),
          female: (t) => /^(female|woman)\b/i.test(t.trim()),
          non_binary: (t) => /non[-\s]?binary|genderqueer|gender.?fluid|x\b/i.test(t),
          other: (t) =>
            /^(other)\b/i.test(t.trim()) ||
            /self.?describe|not listed|prefer to self/i.test(t),
        },
        settings
      );
    }

    // Standalone Hispanic/Latino Yes/No (often separate from race).
    if (
      /hispanic|latino|latina|latinx/.test(q) &&
      !/race|ethnic|american indian|asian|black|white|pacific/.test(q)
    ) {
      const eth = String(profile.ethnicity || "")
        .trim()
        .toLowerCase();
      if (!eth) {
        return settings && settings.autoDeclineEEO ? declineOptionMatch : null;
      }
      if (eth === "prefer_not_to_say") return declineOptionMatch;
      if (eth === "hispanic") return matchYesNoOption("yes");
      return matchYesNoOption("no");
    }

    if (/race|ethnic|ethnicity|racial category|racial identity/.test(q)) {
      return demographicValueMatch(
        profile.ethnicity,
        {
          american_indian: (t) =>
            /american indian|alaska native|native american/i.test(t),
          asian: (t) => /\basian\b/i.test(t) && !/pacific/i.test(t),
          black: (t) => /black|african american/i.test(t),
          hispanic: (t) => /hispanic|latino|latina|latinx/i.test(t),
          pacific_islander: (t) => /hawaiian|pacific islander/i.test(t),
          white: (t) => /\bwhite\b|caucasian/i.test(t),
          two_or_more: (t) =>
            /two or more|more than one|multiracial|multi-racial|two or more races/i.test(
              t
            ),
        },
        settings
      );
    }

    if (/veteran/.test(q)) {
      return demographicValueMatch(
        profile.veteranStatus,
        {
          not_veteran: (t) =>
            /not a veteran|i am not a veteran|do not identify as.*veteran|i am not a.? protected veteran|not a protected veteran/i.test(
              t
            ) || /^no\b/i.test(t.trim()),
          protected_veteran: (t) =>
            /protected veteran/i.test(t) &&
            !/not a protected|i am not a.? protected|not identify/i.test(t),
          veteran: (t) =>
            (/veteran/i.test(t) &&
              !/protected|not a veteran|i am not/i.test(t)) ||
            /armed forces|other veteran/i.test(t),
        },
        settings
      );
    }

    if (
      /disabilit|disabled|section\s*503|voluntary self-identification of disability/.test(
        q
      )
    ) {
      return demographicValueMatch(
        profile.disabilityStatus,
        {
          yes: (t) =>
            /yes/i.test(t) &&
            /disabilit/i.test(t) &&
            !/do not|don't|not want|no,/i.test(t),
          no: (t) =>
            (/no/i.test(t) && /disabilit/i.test(t)) ||
            /do not have a disabilit|don't have a disabilit|i do not have/i.test(
              t
            ),
        },
        settings
      );
    }

    return null;
  }

  async function pickWorkdayMatchedField(root, match) {
    if (!root || !match) return false;

    const radios = Array.from(root.querySelectorAll('input[type="radio"]')).filter(
      (el) => isVisible(el)
    );
    for (const r of radios) {
      const ctx = (
        getFieldContext(r) +
        " " +
        (r.value || "") +
        " " +
        (r.getAttribute("aria-label") || "")
      ).replace(/\s+/g, " ");
      if (match(ctx)) {
        if (!r.checked) r.click();
        return true;
      }
    }

    const nativeSelect = root.querySelector("select");
    if (nativeSelect && isVisible(nativeSelect)) {
      const hit = Array.from(nativeSelect.options).find((o) =>
        match(o.textContent || o.value || "")
      );
      if (hit) {
        nativeSelect.value = hit.value;
        nativeSelect.dispatchEvent(new Event("input", { bubbles: true }));
        nativeSelect.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    const trigger =
      root.querySelector(
        'button[aria-haspopup], button[aria-haspopup="listbox"], [role="combobox"], button[id], [data-uxi-widget-type="selectinput"]'
      ) || null;
    if (!trigger || !isVisible(trigger)) return false;

    const shown = (trigger.value || trigger.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (shown && match(shown) && !/select one|select an option|choose/i.test(shown)) {
      return true;
    }

    return pickWorkdayDropdown(trigger, { match });
  }

  function workdayQuestionFieldRoots() {
    const roots = Array.from(
      document.querySelectorAll('[data-automation-id^="formField-"]')
    );
    const extra = Array.from(
      document.querySelectorAll(
        '[data-automation-id*="questionnaire"], [data-automation-id*="Questionnaire"], fieldset, [role="group"]'
      )
    ).filter((el) => !el.closest('[data-automation-id^="formField-"]'));
    return [...roots, ...extra];
  }

  function isWorkdayIdentityFieldId(autoId) {
    return /legalname|phonenumber|phonetype|countryphonecode|addressline|postalcode|formfield-city$|formfield-country$|formfield-source|previousworker|skills|webaddress|jobtitle|companyname|education|certification|dateSection|resume|file-upload|attachments/.test(
      autoId
    );
  }

  // Voluntary Disclosures + Self Identify from profile Demographics.
  async function fillWorkdayDemographics(profile, settings) {
    let filled = 0;
    const seen = new Set();

    for (const root of workdayQuestionFieldRoots()) {
      if (!root || !isVisible(root)) continue;
      if (seen.has(root)) continue;
      seen.add(root);

      const autoId = (root.getAttribute("data-automation-id") || "").toLowerCase();
      if (isWorkdayIdentityFieldId(autoId)) continue;

      const question = workdayFormFieldQuestionText(root);
      if (
        !/(gender|sex|race|ethnic|hispanic|latino|veteran|disabilit|disabled|orientation|lgbt|pronoun)/i.test(
          question
        )
      ) {
        continue;
      }

      const match = resolveWorkdayDemographicMatch(question, profile, settings);
      if (!match) continue;
      if (await pickWorkdayMatchedField(root, match)) {
        filled++;
        await sleep(120);
      }
    }

    // Catch any remaining EEO controls that used odd labels / structure.
    if (settings && settings.autoDeclineEEO) {
      filled += await fillWorkdayEEODecline();
    }

    return filled;
  }

  // When Continue is blocked by required open-ended questions, draft a few
  // answers via the hosted AI (capped). User still reviews before Submit.
  async function draftEmptyWorkdayTextareas(max = 5) {
    const areas = Array.from(document.querySelectorAll("textarea")).filter(
      (el) => isVisible(el) && !(el.value && el.value.trim()) && !el.disabled
    );
    let n = 0;
    for (const el of areas.slice(0, max)) {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: "TVARIN_AI_DRAFT",
          question: getQuestionForDraft(el),
          jobContext: {
            title: bestEffortJobTitle().slice(0, 300),
            company: bestEffortCompany().slice(0, 200),
            description: bestEffortJobDescription(),
            requirements: bestEffortJobRequirements(),
            url: location.href.slice(0, 500),
          },
        });
        if (!resp || resp.error || !resp.text) break;
        setNativeValue(el, resp.text);
        n++;
        await sleep(120);
      } catch (_) {
        break;
      }
    }
    return n;
  }

  function fillWorkdayBlobFields(profile) {
    let filled = 0;
    document.querySelectorAll("textarea, input[type='text']").forEach((el) => {
      if (!isVisible(el) || (el.value && el.value.trim())) return;
      // Experience panels have dedicated filler (title/company/dates/role).
      if (
        el.id &&
        (/^workExperience-\d+--/.test(el.id) || /^education-\d+--/.test(el.id))
      ) {
        return;
      }
      const ctx = getFieldContext(el);
      if (/linkedin/.test(ctx) && profile.linkedin) {
        if (fillField(el, profile.linkedin)) filled++;
      } else if (/github/.test(ctx) && profile.github) {
        if (fillField(el, profile.github)) filled++;
      } else if (/portfolio|personal (site|website)|website/.test(ctx) && profile.portfolio) {
        if (fillField(el, profile.portfolio)) filled++;
      } else if (/skill/.test(ctx) && profile.skills) {
        if (fillField(el, profile.skills)) filled++;
      } else if (/(about you|summary|profile|biography)/.test(ctx) && profile.about) {
        if (fillField(el, profile.about)) filled++;
      } else if (
        /role description/.test(ctx) &&
        (profile.experience || primaryExperience(profile))
      ) {
        const text =
          experienceRoleText(primaryExperience(profile)) || profile.experience || "";
        if (text && fillField(el, text)) filled++;
      } else if (/projects?/.test(ctx) && profile.projects) {
        if (fillField(el, profile.projects)) filled++;
      } else if (/school|university|college/.test(ctx) && valueForKey(profile, "school")) {
        if (fillField(el, valueForKey(profile, "school"))) filled++;
      } else if (
        /(degree|accreditation|field of study)/.test(ctx) &&
        valueForKey(profile, "degree")
      ) {
        if (fillField(el, valueForKey(profile, "degree"))) filled++;
      }
    });
    return filled;
  }

  // My Experience: skills PromptSelect — add one chip at a time from profile.skills.
  async function fillWorkdaySkills(profile) {
    if (!profile.skills) return 0;
    const input =
      document.getElementById("skills--skills") ||
      workdayTriggerFor("formField-skills") ||
      workdayTriggerFor("skills");
    if (!input || !isVisible(input)) return 0;

    const parts = String(profile.skills)
      .split(/[,;\n|]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 1)
      .slice(0, 12);
    let filled = 0;
    for (const skill of parts) {
      const ok = await pickWorkdayDropdown(input, {
        typeahead: skill,
        match: (t) => {
          const s = t.toLowerCase();
          const want = skill.toLowerCase();
          return s === want || s.startsWith(want) || s.includes(want);
        },
      });
      if (ok) filled++;
      await sleep(200);
    }
    return filled;
  }

  function normalizeWebsiteUrl(url) {
    return String(url || "")
      .trim()
      .toLowerCase()
      .replace(/\/+$/, "")
      .replace(/^https?:\/\//, "");
  }

  // Websites: at most one row per unique LinkedIn / GitHub / portfolio URL.
  async function fillWorkdayWebsites(profile) {
    const urls = [
      ...new Set(
        [profile.linkedin, profile.github, profile.portfolio]
          .filter(Boolean)
          .map((u) => String(u).trim())
      ),
    ];
    if (!urls.length) return 0;
    const heading = document.getElementById("Websites-section");
    if (!heading) return 0;

    function websitesScope() {
      return (
        heading.closest("section") ||
        heading.closest('[data-automation-id="panelSet"]') ||
        heading.parentElement ||
        heading
      );
    }

    // Workday labels this "Add Another" — automation-id is not always present.
    function findWebsitesAddButton() {
      const scope = websitesScope();
      const candidates = Array.from(
        scope.querySelectorAll(
          'button, a[role="button"], div[role="button"], [data-automation-id="add-button"]'
        )
      ).filter((el) => isVisible(el));

      const byAuto = candidates.find(
        (el) => (el.getAttribute("data-automation-id") || "") === "add-button"
      );
      if (byAuto) return byAuto;

      const byText = candidates.find((el) => {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return (
          t === "add another" ||
          t === "add" ||
          t === "add website" ||
          t === "add url" ||
          /^add another\b/.test(t) ||
          /^add\b/.test(t)
        );
      });
      if (byText) return byText;

      // Fallback: first add-button after the Websites heading, before the next h4.
      const all = Array.from(
        document.querySelectorAll('h4[id$="-section"], [data-automation-id="add-button"]')
      );
      let seen = false;
      for (const el of all) {
        if (el === heading) {
          seen = true;
          continue;
        }
        if (!seen) continue;
        if (el.matches && el.matches("h4")) return null;
        if (el.getAttribute("data-automation-id") === "add-button") return el;
      }
      return null;
    }

    function websiteInputs() {
      const scope = websitesScope();
      return Array.from(
        scope.querySelectorAll(
          'input[name="url"], input[id*="webAddress"][id*="url"], input[id*="webAddress"]'
        )
      ).filter((el) => {
        if (!isVisible(el)) return false;
        const type = (el.getAttribute("type") || "text").toLowerCase();
        return type === "text" || type === "url" || type === "";
      });
    }

    function hasUrl(url) {
      const want = normalizeWebsiteUrl(url);
      return websiteInputs().some((el) => normalizeWebsiteUrl(el.value) === want);
    }

    let filled = 0;
    for (const url of urls) {
      if (hasUrl(url)) continue;

      let inputs = websiteInputs();
      let empty = inputs.find((el) => !(el.value && el.value.trim()));

      if (!empty) {
        const hay = (websitesScope().innerText || "").slice(0, 4000);
        if (/can'?t add duplicate website/i.test(hay)) continue;
        const addBtn = findWebsitesAddButton();
        if (!addBtn) continue;
        const before = inputs.length;
        addBtn.click();
        await sleep(450);
        inputs = websiteInputs();
        // Wait briefly if the new row hasn't mounted yet.
        if (inputs.length <= before) {
          await sleep(400);
          inputs = websiteInputs();
        }
        empty = inputs.find((el) => !(el.value && el.value.trim()));
      }
      if (empty && !hasUrl(url) && fillField(empty, url)) filled++;
    }
    return filled;
  }

  // Per Fill-run guards so Experience extras never loop-stack on the same step.
  let workdayExpExtrasDoneFor = "";

  function workdaySectionHeadings() {
    return Array.from(document.querySelectorAll("[id$='-section']")).filter(
      (el) => el.id && /-section$/.test(el.id)
    );
  }

  function workdayNextSectionHeading(heading) {
    const heads = workdaySectionHeadings();
    const i = heads.indexOf(heading);
    return i >= 0 ? heads[i + 1] || null : null;
  }

  // True when el sits in [heading, nextHeading) — never borrow another section's Add.
  function workdayNodeInSection(el, heading, nextHeading) {
    if (!el || !heading) return false;
    if (el === heading || heading.contains(el)) return true;
    const pos = heading.compareDocumentPosition(el);
    if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    if (!nextHeading) return true;
    if (el === nextHeading || nextHeading.contains(el)) return false;
    return !!(el.compareDocumentPosition(nextHeading) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function findWorkdaySectionAddButton(sectionId) {
    const heading = document.getElementById(sectionId);
    if (!heading) return null;
    const next = workdayNextSectionHeading(heading);
    const candidates = Array.from(
      document.querySelectorAll(
        '[data-automation-id="add-button"], button, a[role="button"], div[role="button"]'
      )
    ).filter(
      (el) => isVisible(el) && workdayNodeInSection(el, heading, next)
    );

    const byAuto = candidates.find(
      (el) => (el.getAttribute("data-automation-id") || "") === "add-button"
    );
    if (byAuto) return byAuto;

    return (
      candidates.find((el) => {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return t === "add" || t === "add another" || /^add another\b/.test(t);
      }) || null
    );
  }

  function countWorkdayIndexed(prefix, field) {
    const indexes = [];
    for (let i = 0; i < 12; i++) {
      if (
        (field && document.getElementById(`${prefix}-${i}--${field}`)) ||
        document.querySelector(`[id^="${CSS.escape(prefix + "-" + i + "--")}"]`)
      ) {
        indexes.push(i);
      }
    }
    if (!indexes.length) return { count: 0, start: 0, indexes: [] };
    return { count: indexes.length, start: indexes[0], indexes };
  }

  // Prefer the tightest ancestor that only contains this index's fields.
  // Shared panelSet wrappers include every Work Experience / Education row — using
  // those made querySelector always hit row 0 (dates, school fallbacks, etc.).
  function workdayPanelRoot(prefix, index) {
    const probe =
      document.getElementById(`${prefix}-${index}--jobTitle`) ||
      document.getElementById(`${prefix}-${index}--companyName`) ||
      document.getElementById(`${prefix}-${index}--school`) ||
      document.getElementById(`${prefix}-${index}--degree`) ||
      document.getElementById(`${prefix}-${index}--fieldOfStudy`) ||
      document.querySelector(
        `[id^="${CSS.escape(prefix + "-" + index + "--")}"]`
      );
    if (!probe) return null;

    const indexRe = new RegExp(
      `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)--`
    );
    function indexesIn(node) {
      const set = new Set();
      if (!node) return set;
      if (node.id) {
        const m = node.id.match(indexRe);
        if (m) set.add(Number(m[1]));
      }
      node.querySelectorAll(`[id^="${CSS.escape(prefix + "-")}"]`).forEach((el) => {
        const m = el.id.match(indexRe);
        if (m) set.add(Number(m[1]));
      });
      return set;
    }

    let best = null;
    let node = probe;
    while (node && node !== document.body) {
      const idxs = indexesIn(node);
      if (idxs.size === 1 && idxs.has(index)) best = node;
      else if (idxs.size > 1) break;
      node = node.parentElement;
    }
    return (
      best ||
      probe.closest("li") ||
      probe.closest('[role="group"]') ||
      probe.closest("fieldset") ||
      probe.parentElement
    );
  }

  function workdayIndexedShown(prefix, index, field) {
    const el = document.getElementById(`${prefix}-${index}--${field}`);
    if (!el) return "";
    return (el.value || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function workdayPlaceholderLabel(text) {
    return !text || /select one|select an option|^search$|choose one/i.test(text);
  }

  function isWorkdayWorkPanelEmpty(index) {
    return (
      !workdayIndexedShown("workExperience", index, "jobTitle") &&
      !workdayIndexedShown("workExperience", index, "companyName")
    );
  }

  function isWorkdayEduPanelEmpty(index) {
    const school = workdayIndexedShown("education", index, "school");
    const degree = workdayIndexedShown("education", index, "degree");
    return !school && workdayPlaceholderLabel(degree);
  }

  function pageHasWorkExperience(exp) {
    const wantTitle = (exp.title || "").trim().toLowerCase();
    const wantCo = (exp.company || "").trim().toLowerCase();
    if (!wantTitle && !wantCo) return false;
    const meta = countWorkdayIndexed("workExperience", "jobTitle");
    for (const idx of meta.indexes) {
      const title = workdayIndexedShown("workExperience", idx, "jobTitle").toLowerCase();
      const company = workdayIndexedShown(
        "workExperience",
        idx,
        "companyName"
      ).toLowerCase();
      if (wantTitle && wantCo) {
        if (title === wantTitle && company === wantCo) return true;
        if (title === wantTitle && company.includes(wantCo.slice(0, 16))) return true;
      } else if (wantTitle && title === wantTitle) {
        return true;
      } else if (wantCo && company === wantCo && !wantTitle) {
        return true;
      }
    }
    return false;
  }

  function pageHasEducation(edu) {
    const wantSchool = (educationFieldValue(edu, "school") || "").trim().toLowerCase();
    if (!wantSchool) return false;
    let meta = countWorkdayIndexed("education", "school");
    if (!meta.count) meta = countWorkdayIndexed("education", "degree");
    for (const idx of meta.indexes) {
      const school = workdayIndexedShown("education", idx, "school").toLowerCase();
      if (!school) continue;
      if (
        school === wantSchool ||
        school.includes(wantSchool.slice(0, 18)) ||
        wantSchool.includes(school.slice(0, 18))
      ) {
        return true;
      }
    }
    return false;
  }

  async function expandWorkdaySection(sectionId) {
    const heading = document.getElementById(sectionId);
    if (!heading) return;
    if (findWorkdaySectionAddButton(sectionId)) return;
    const meta = countWorkdayIndexed(
      sectionId.startsWith("Education") ? "education" : "workExperience",
      sectionId.startsWith("Education") ? "school" : "jobTitle"
    );
    if (meta.count > 0) return;
    const clickable =
      heading.closest("button") ||
      heading.querySelector("button") ||
      heading.parentElement?.querySelector("button") ||
      heading;
    if (clickable && typeof clickable.click === "function") {
      clickable.click();
      await sleep(350);
    }
  }

  async function addOneWorkdayIndexedPanel(sectionId, prefix, fields) {
    const fieldList = Array.isArray(fields) ? fields : [fields];
    function snap() {
      for (const f of fieldList) {
        const meta = countWorkdayIndexed(prefix, f);
        if (meta.count) return meta;
      }
      return countWorkdayIndexed(prefix, fieldList[0]);
    }
    const before = snap();
    await expandWorkdaySection(sectionId);
    const btn = findWorkdaySectionAddButton(sectionId);
    if (!btn) return before;
    btn.click();
    for (let i = 0; i < 28; i++) {
      await sleep(150);
      const meta = snap();
      if (meta.count > before.count) return meta;
    }
    return snap();
  }

  // Reuse an empty row when present; only click Add when every existing row is used.
  async function claimEmptyWorkdayPanel(sectionId, prefix, fields, isEmpty) {
    const fieldList = Array.isArray(fields) ? fields : [fields];
    function snap() {
      for (const f of fieldList) {
        const meta = countWorkdayIndexed(prefix, f);
        if (meta.count) return meta;
      }
      return countWorkdayIndexed(prefix, fieldList[0]);
    }

    await expandWorkdaySection(sectionId);
    let meta = snap();
    const emptyIdx = meta.indexes.find((idx) => isEmpty(idx));
    if (emptyIdx != null) return emptyIdx;

    meta = await addOneWorkdayIndexedPanel(sectionId, prefix, fieldList);
    const afterEmpty = meta.indexes.find((idx) => isEmpty(idx));
    if (afterEmpty != null) return afterEmpty;
    if (meta.indexes.length) return meta.indexes[meta.indexes.length - 1];
    return null;
  }

  async function fillWorkdayMonthYearInRoot(root, yyyyMm) {
    const parts = parseMonthYear(yyyyMm);
    if (!parts || !root) return 0;
    const split = findDobSplitInRoot(root);
    if (split && (split.month || split.year)) {
      return fillDobSplitParts(split, { ...parts, dd: parts.dd || "01" });
    }
    const inputs = Array.from(
      root.querySelectorAll("input:not([type=hidden]):not([type=checkbox]), textarea")
    ).filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length);
    for (const input of inputs) {
      if (input.value && String(input.value).trim()) continue;
      const ph = `${input.placeholder || ""} ${input.getAttribute("aria-label") || ""} ${getFieldContext(input)}`.toLowerCase();
      // Autodesk education uses year-only YYYY boxes.
      if (/^yyyy$/.test((input.placeholder || "").trim()) || (ph.includes("yyyy") && !/mm/.test(ph))) {
        if (fillWorkdayPlainInput(input, parts.yyyy)) return 1;
        continue;
      }
      if (
        /mm\s*\/\s*yyyy|m\s*\/\s*yyyy|month.*year|start date|end date|from|to\b/.test(ph) ||
        inputs.length === 1
      ) {
        const formatted = `${parts.mm}/${parts.yyyy}`;
        if (fillWorkdayPlainInput(input, formatted)) return 1;
      }
    }
    return 0;
  }

  // Focus + native set — Workday rows below the fold / briefly readOnly break fillField.
  function fillWorkdayPlainInput(el, value) {
    if (!el || !value) return false;
    if (el.value && String(el.value).trim()) return false;
    try {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (_) {}
    try {
      el.focus();
    } catch (_) {}
    const wasReadOnly = !!el.readOnly;
    if (wasReadOnly) {
      try {
        el.readOnly = false;
      } catch (_) {}
    }
    setNativeValue(el, value);
    if (wasReadOnly) {
      try {
        el.readOnly = true;
      } catch (_) {}
    }
    return !!(el.value && String(el.value).trim());
  }

  function workdayPanelTitleNumber(el, kind) {
    if (!el) return null;
    const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
    // Title nodes often include a sibling "Delete" in textContent.
    const head = raw.split(/\bDelete\b/i)[0].trim();
    const m = head.match(new RegExp(`^${kind}\\s+(\\d+)$`, "i"));
    return m ? Number(m[1]) : null;
  }

  // Panels labeled "Work Experience 1", "Education 2", … — more reliable than id indexes alone.
  function workdayRepeatingPanelRoots(kind) {
    const titles = [];
    const seen = new Set();

    function consider(el) {
      if (!el || seen.has(el)) return;
      const n = workdayPanelTitleNumber(el, kind);
      if (n == null) return;
      // Prefer the smallest text node / leaf-ish title (avoid giant wrappers).
      const textLen = ((el.textContent || "").replace(/\s+/g, " ").trim() || "").length;
      if (textLen > 64) return;
      seen.add(el);
      if (titles.some((t) => t.n === n)) return;
      titles.push({ n, titleEl: el });
    }

    Array.from(
      document.querySelectorAll(
        'h2, h3, h4, h5, legend, [role="heading"], [data-automation-id*="panel" i], button, div, span, label'
      )
    ).forEach(consider);

    titles.sort((a, b) => a.n - b.n);

    return titles.map(({ n, titleEl }) => {
      let best = null;
      let node = titleEl.parentElement;
      while (node && node !== document.body) {
        const hasDelete = Array.from(node.querySelectorAll("button, a")).some((b) =>
          /^delete$/i.test((b.textContent || "").replace(/\s+/g, " ").trim())
        );
        const hasInputs = !!node.querySelector(
          "input:not([type=hidden]), textarea, button[aria-haspopup], [data-uxi-widget-type]"
        );
        const other = Array.from(
          node.querySelectorAll("h2, h3, h4, h5, legend, [role='heading'], div, span")
        ).some((el) => {
          if (el === titleEl) return false;
          const on = workdayPanelTitleNumber(el, kind);
          return on != null && on !== n;
        });
        if (other) break;
        if (hasDelete && hasInputs) best = node;
        node = node.parentElement;
      }
      return { n, titleEl, root: best || titleEl.parentElement || titleEl };
    });
  }

  function workdayQueryInRoot(root, selectors) {
    if (!root) return null;
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0 || el.offsetParent !== null) return el;
      if (el.getClientRects().length) return el;
    }
    return null;
  }

  async function ensureWorkdayUiPanels(sectionId, kind, needed, prefix, fields) {
    let panels = workdayRepeatingPanelRoots(kind);
    if (needed <= 0) return panels;
    let guard = 0;
    while (panels.length < needed && guard++ < 10) {
      const before = panels.length;
      await addOneWorkdayIndexedPanel(sectionId, prefix, fields);
      panels = workdayRepeatingPanelRoots(kind);
      if (panels.length > before) continue;
      const btn = findWorkdaySectionAddButton(sectionId);
      if (!btn) break;
      btn.click();
      for (let i = 0; i < 24; i++) {
        await sleep(150);
        panels = workdayRepeatingPanelRoots(kind);
        if (panels.length > before) break;
      }
      if (panels.length <= before) break;
    }
    return workdayRepeatingPanelRoots(kind);
  }

  async function fillWorkdaySchoolPrompt(trigger, schoolName) {
    if (!trigger || !schoolName) return false;

    const widget = (trigger.getAttribute("data-uxi-widget-type") || "").toLowerCase();
    const isPrompt =
      trigger.tagName === "BUTTON" ||
      widget === "selectinput" ||
      trigger.getAttribute("aria-haspopup") === "listbox" ||
      trigger.getAttribute("aria-autocomplete") === "list";

    // Autodesk often uses a plain text school box — PromptSelect logic leaves it blank.
    if (!isPrompt && trigger.tagName === "INPUT") {
      return fillWorkdayPlainInput(trigger, schoolName);
    }

    const remembered = await lookupSchoolMapping(schoolName);
    if (remembered) {
      const ok = await pickWorkdayDropdown(trigger, {
        typeahead: remembered.slice(0, 48),
        match: (t) =>
          scoreSchoolOption(t, schoolName) >= 0.72 ||
          scoreSchoolOption(t, remembered) >= 0.85,
      });
      if (ok) return true;
    }
    const queries = schoolTypeaheadQueries(schoolName);
    for (const q of queries) {
      const ok = await pickWorkdayDropdown(trigger, {
        typeahead: q,
        match: (t) => scoreSchoolOption(t, schoolName) >= SCHOOL_MIN_SCORE,
      });
      if (ok) {
        const label = (trigger.value || trigger.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (label) await saveSchoolMapping(schoolName, label);
        return true;
      }
    }
    const last = await pickWorkdayDropdown(trigger, {
      typeahead: schoolName.slice(0, 48),
      match: (t) => scoreSchoolOption(t, schoolName) >= SCHOOL_MIN_SCORE,
    });
    if (last) return true;

    // School not in Workday's list — type the free-text value so the row isn't blank.
    if (trigger.tagName === "INPUT") {
      if (workdayPopupOpen()) await dismissWorkdayPopup();
      return fillWorkdayPlainInput(trigger, schoolName);
    }
    return false;
  }

  // Autodesk: degree prompt is Country → Degree (same hierarchy pattern as source).
  async function fillWorkdayDegreePrompt(trigger, degree, countryHint) {
    if (!trigger || !degree) return false;
    const shown = (trigger.value || trigger.textContent || "").replace(/\s+/g, " ").trim();
    if (shown && matchDegreeOption(shown, degree) && !workdayPlaceholderLabel(shown)) {
      if (workdayPopupOpen()) await dismissWorkdayPopup();
      return true;
    }

    trigger.focus();
    fireWorkdayClick(trigger);
    await sleep(350);

    const country =
      String(countryHint || "").trim() ||
      "";
    const countryMatch = (t) => {
      const s = String(t || "").trim().toLowerCase();
      if (!country) return false;
      const want = country.toLowerCase();
      if (s === want) return true;
      if (want === "india" && /^(india|in)$/i.test(s)) return true;
      if (want === "united states" && /united states|usa|^us$/i.test(s)) return true;
      return s.startsWith(want) || want.startsWith(s);
    };
    const degreeMatch = (t) => matchDegreeOption(t, degree);

    let opts = listWorkdayPromptOptions();
    const looksLikeCountries =
      opts.length > 0 &&
      opts.filter(({ t }) =>
        /^(india|united states|united kingdom|canada|australia|germany|singapore|japan)/i.test(
          String(t || "").trim()
        )
      ).length >= 2;

    if (looksLikeCountries || (country && opts.some(({ t }) => countryMatch(t)))) {
      const parent =
        opts.find(({ t }) => countryMatch(t)) ||
        (country
          ? null
          : opts.find(({ t }) => /^(india|united states)$/i.test(String(t || "").trim())));
      if (parent) {
        const charm = workdaySideCharm(parent.o);
        if (charm) fireWorkdayClick(charm);
        else fireWorkdayClick(parent.o);
        await sleep(500);
        opts = await waitForWorkdayOptions((list) => list.some(({ t }) => degreeMatch(t)), 2500);
      }
    }

    let leaf =
      listWorkdayPromptOptions().find(({ t }) => degreeMatch(t)) ||
      null;
    if (!leaf) {
      const scrolled = await scrollWorkdayListForOption(degreeMatch, 4000);
      if (scrolled) leaf = { o: scrolled, t: scrolled.textContent || "" };
    }
    if (!leaf) {
      // No hierarchy — try typeahead search on degree name.
      await dismissWorkdayPopup();
      return pickWorkdayDropdown(trigger, {
        typeahead: false,
        match: degreeMatch,
      });
    }

    const radio = leaf.o.querySelector(
      '[data-automation-id="radioBtn"], input[type="radio"]'
    );
    if (radio) fireWorkdayClick(radio);
    fireWorkdayClick(
      leaf.o.querySelector('[data-automation-id="promptOption"]') || leaf.o
    );
    await sleep(280);
    // Commit like country listbox.
    leaf.o.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
      })
    );
    await sleep(200);
    await dismissWorkdayPopup();
    const after = (trigger.value || trigger.textContent || "").replace(/\s+/g, " ").trim();
    return !workdayPlaceholderLabel(after) && matchDegreeOption(after, degree);
  }

  async function fillWorkdayWorkExperiences(profile) {
    const list = listExperiences(profile);
    if (!list.length) return 0;
    if (!document.getElementById("Work-Experience-section")) return 0;

    if (workdayPopupOpen()) await dismissWorkdayPopup();

    let panels = await ensureWorkdayUiPanels(
      "Work-Experience-section",
      "Work Experience",
      list.length,
      "workExperience",
      ["jobTitle", "companyName"]
    );
    if (!panels.length) {
      let meta = countWorkdayIndexed("workExperience", "jobTitle");
      if (!meta.count) meta = countWorkdayIndexed("workExperience", "companyName");
      while (meta.count < list.length) {
        const before = meta.count;
        meta = await addOneWorkdayIndexedPanel(
          "Work-Experience-section",
          "workExperience",
          ["jobTitle", "companyName"]
        );
        if (meta.count <= before) break;
      }
      panels = meta.indexes.map((idx, i) => ({
        n: i + 1,
        root: workdayPanelRoot("workExperience", idx),
        idx,
      }));
    }
    if (!panels.length) return 0;

    let filled = 0;
    const n = Math.min(list.length, panels.length);
    for (let i = 0; i < n; i++) {
      const exp = list[i];
      const { root, n: ordinal, idx: idxFromMeta } = panels[i];
      if (!root && idxFromMeta == null) continue;
      const scope = root || document;
      try {
        if (root) root.scrollIntoView({ block: "center" });
      } catch (_) {}
      await sleep(180);

      const idxGuess = idxFromMeta != null ? idxFromMeta : ordinal - 1;
      const titleEl =
        document.getElementById(`workExperience-${idxGuess}--jobTitle`) ||
        document.getElementById(`workExperience-${ordinal}--jobTitle`) ||
        workdayQueryInRoot(scope, [
          '[data-automation-id="formField-jobTitle"] input',
          'input[id*="jobTitle" i]',
          'input[name="jobTitle"]',
        ]);
      const companyEl =
        document.getElementById(`workExperience-${idxGuess}--companyName`) ||
        document.getElementById(`workExperience-${ordinal}--companyName`) ||
        workdayQueryInRoot(scope, [
          '[data-automation-id="formField-companyName"] input',
          'input[id*="companyName" i]',
          'input[name="companyName"]',
        ]);
      const locationEl =
        document.getElementById(`workExperience-${idxGuess}--location`) ||
        document.getElementById(`workExperience-${ordinal}--location`) ||
        workdayQueryInRoot(scope, [
          '[data-automation-id="formField-location"] input',
          'input[id*="location" i]',
          'input[name="location"]',
        ]);
      const roleEl =
        document.getElementById(`workExperience-${idxGuess}--roleDescription`) ||
        document.getElementById(`workExperience-${ordinal}--roleDescription`) ||
        workdayQueryInRoot(scope, [
          '[data-automation-id="formField-roleDescription"] textarea',
          "textarea",
        ]);
      const currentEl =
        document.getElementById(`workExperience-${idxGuess}--currentlyWorkHere`) ||
        document.getElementById(`workExperience-${ordinal}--currentlyWorkHere`) ||
        workdayQueryInRoot(scope, [
          '[data-automation-id="formField-currentlyWorkHere"] input[type="checkbox"]',
          'input[type="checkbox"]',
        ]);

      if (titleEl && exp.title && fillWorkdayPlainInput(titleEl, exp.title)) filled++;
      if (companyEl && exp.company && fillWorkdayPlainInput(companyEl, exp.company)) filled++;
      if (locationEl && exp.location && fillWorkdayPlainInput(locationEl, exp.location)) {
        filled++;
      }

      if (currentEl && typeof exp.current === "boolean") {
        if (!!currentEl.checked !== !!exp.current) {
          currentEl.click();
          filled++;
          await sleep(120);
        }
      }

      const startRoot = workdayQueryInRoot(scope, [
        '[data-automation-id="formField-startDate"]',
      ]);
      const endRoot = workdayQueryInRoot(scope, [
        '[data-automation-id="formField-endDate"]',
      ]);
      if (startRoot && exp.startDate) {
        filled += await fillWorkdayMonthYearInRoot(startRoot, exp.startDate);
      }
      if (endRoot && !exp.current && exp.endDate) {
        filled += await fillWorkdayMonthYearInRoot(endRoot, exp.endDate);
      }

      const role = experienceRoleText(exp);
      if (roleEl && role && fillWorkdayPlainInput(roleEl, role)) filled++;
      await sleep(120);
    }
    return filled;
  }

  async function fillWorkdayEducations(profile) {
    const list = listEducations(profile);
    if (!list.length) return 0;
    if (!document.getElementById("Education-section")) return 0;

    if (workdayPopupOpen()) await dismissWorkdayPopup();

    let panels = await ensureWorkdayUiPanels(
      "Education-section",
      "Education",
      list.length,
      "education",
      ["school", "degree", "fieldOfStudy"]
    );
    if (!panels.length) {
      let meta = countWorkdayIndexed("education", "school");
      if (!meta.count) meta = countWorkdayIndexed("education", "degree");
      while (meta.count < list.length) {
        const before = meta.count;
        meta = await addOneWorkdayIndexedPanel(
          "Education-section",
          "education",
          ["school", "degree", "fieldOfStudy"]
        );
        if (meta.count <= before) break;
      }
      panels = meta.indexes.map((idx, i) => ({
        n: i + 1,
        root: workdayPanelRoot("education", idx),
        idx,
      }));
    }
    if (!panels.length) return 0;

    const countryHint =
      profile.country ||
      profile.addressCountry ||
      (profile.location && /india/i.test(profile.location) ? "India" : "") ||
      "India";

    let filled = 0;
    const n = Math.min(list.length, panels.length);
    for (let i = 0; i < n; i++) {
      const edu = list[i];
      const { root, n: ordinal, idx: idxFromMeta } = panels[i];
      if (!root && idxFromMeta == null) continue;
      const scope = root || document;
      try {
        if (root) root.scrollIntoView({ block: "center" });
      } catch (_) {}
      await sleep(200);

      const idxGuess = idxFromMeta != null ? idxFromMeta : ordinal - 1;
      const schoolEl =
        document.getElementById(`education-${idxGuess}--school`) ||
        document.getElementById(`education-${ordinal}--school`) ||
        workdayQueryInRoot(scope, [
          '[data-automation-id="formField-school"] input',
          '[data-automation-id="formField-school"] button',
          'input[id*="school" i]',
        ]);
      const degreeEl =
        document.getElementById(`education-${idxGuess}--degree`) ||
        document.getElementById(`education-${ordinal}--degree`) ||
        workdayQueryInRoot(scope, [
          '[data-automation-id="formField-degree"] button',
          '[data-automation-id="formField-degree"] input',
          'button[id*="degree" i]',
        ]);
      const fosEl =
        document.getElementById(`education-${idxGuess}--fieldOfStudy`) ||
        document.getElementById(`education-${ordinal}--fieldOfStudy`) ||
        workdayQueryInRoot(scope, [
          '[data-automation-id="formField-fieldOfStudy"] input',
          '[data-automation-id="formField-fieldOfStudy"] button',
          'input[id*="fieldOfStudy" i]',
        ]);
      const gpaEl =
        document.getElementById(`education-${idxGuess}--gradeAverage`) ||
        document.getElementById(`education-${idxGuess}--gpa`) ||
        document.getElementById(`education-${ordinal}--gradeAverage`) ||
        workdayQueryInRoot(scope, [
          '[data-automation-id="formField-gradeAverage"] input',
          '[data-automation-id="formField-gpa"] input',
          '[data-automation-id*="overall" i] input',
          '[data-automation-id*="grade" i] input',
        ]);

      const school = educationFieldValue(edu, "school");
      if (schoolEl && school) {
        if (await fillWorkdaySchoolPrompt(schoolEl, school)) filled++;
        else if (workdayPopupOpen()) await dismissWorkdayPopup();
      }

      const degree = educationFieldValue(edu, "degree");
      if (degreeEl && degree) {
        if (await fillWorkdayDegreePrompt(degreeEl, degree, countryHint)) filled++;
        else if (workdayPopupOpen()) await dismissWorkdayPopup();
      }

      const discipline = educationFieldValue(edu, "discipline");
      if (fosEl && discipline) {
        const widget = (fosEl.getAttribute("data-uxi-widget-type") || "").toLowerCase();
        const isPrompt =
          fosEl.tagName === "BUTTON" ||
          widget === "selectinput" ||
          fosEl.getAttribute("aria-haspopup") === "listbox";
        let ok = false;
        if (isPrompt) {
          ok = await pickWorkdayDropdown(fosEl, {
            typeahead: discipline,
            match: (t) => fuzzyOptionMatch(t, discipline),
          });
        }
        if (!ok) ok = fillWorkdayPlainInput(fosEl, discipline);
        if (ok) filled++;
        else if (workdayPopupOpen()) await dismissWorkdayPopup();
      }

      const gpa = educationFieldValue(edu, "gpa");
      if (gpaEl && gpa && fillWorkdayPlainInput(gpaEl, gpa)) filled++;

      const startRoot = workdayQueryInRoot(scope, [
        '[data-automation-id="formField-startDate"]',
        '[data-automation-id="formField-fromDate"]',
        '[data-automation-id="formField-firstYearAttended"]',
        '[data-automation-id*="from" i]',
      ]);
      const endRoot = workdayQueryInRoot(scope, [
        '[data-automation-id="formField-endDate"]',
        '[data-automation-id="formField-toDate"]',
        '[data-automation-id="formField-yearOfGraduation"]',
        '[data-automation-id="formField-lastYearAttended"]',
        '[data-automation-id*="toDate" i]',
      ]);
      if (edu.startDate) {
        filled += await fillWorkdayMonthYearInRoot(startRoot || scope, edu.startDate);
      }
      if (edu.endDate && !edu.current) {
        filled += await fillWorkdayMonthYearInRoot(endRoot || scope, edu.endDate);
      }
      await sleep(150);
    }
    return filled;
  }

  async function fillWorkdayExperienceExtras(profile, resume) {
    let filled = 0;
    const onExp =
      !!wdEl("applyFlowMyExpPage") ||
      !!document.getElementById("Work-Experience-section") ||
      !!document.getElementById("Education-section") ||
      !!document.getElementById("Resume/CV-section");
    if (!onExp) return 0;

    const stepKey = workdayPageFingerprint();
    if (workdayExpExtrasDoneFor === stepKey) return 0;
    workdayExpExtrasDoneFor = stepKey;

    filled += await fillWorkdayWorkExperiences(profile);
    filled += await fillWorkdayEducations(profile);
    filled += await fillWorkdaySkills(profile);
    filled += await fillWorkdayWebsites(profile);
    if (resume && attachResume(resume)) filled++;
    return filled;
  }

  async function fillWorkdayStep(profile, settings, resume) {
    // Modern wd5 careers use input ids like name--legalName--firstName and
    // wrappers formField-*; older tenants use legalNameSection_* / phone-number.
    const known = collectKnownAny([
      [
        [
          "#name--legalName--firstName",
          'input[name="legalName--firstName"]',
          wd("formField-legalName--firstName"),
          wd("legalNameSection_firstName"),
        ],
        "firstName",
      ],
      [
        [
          "#name--legalName--lastName",
          'input[name="legalName--lastName"]',
          wd("formField-legalName--lastName"),
          wd("legalNameSection_lastName"),
        ],
        "lastName",
      ],
      [
        [
          "#phoneNumber--phoneNumber",
          'input[name="phoneNumber"]',
          wd("formField-phoneNumber"),
          wd("phone-number"),
        ],
        "phone",
      ],
      [
        [
          "#address--addressLine1",
          'input[name="addressLine1"]',
          wd("formField-addressLine1"),
          wd("addressSection_addressLine1"),
        ],
        "addressLine1",
      ],
      [
        [
          "#address--city",
          'input[name="city"]',
          wd("formField-city"),
          wd("addressSection_city"),
        ],
        "city",
      ],
      [
        [
          "#address--postalCode",
          'input[name="postalCode"]',
          wd("formField-postalCode"),
          wd("addressSection_postalCode"),
        ],
        "postalCode",
      ],
      [[wd("email"), 'input[type="email"]'], "email"],
      [
        [
          wd("linkedin"),
          wd("linkedinURL"),
          wd("socialNetworkAccounts--linkedin"),
          'input[id*="linkedin" i]',
        ],
        "linkedin",
      ],
      [[wd("website"), 'input[id*="portfolio" i]', 'input[id*="website" i]'], "portfolio"],
      [[wd("github"), 'input[id*="github" i]'], "github"],
    ]);

    let filled = 0;
    const result = await runAdapter(known, profile, settings, {
      forceCountryCode: true,
    });
    filled += result.filled || 0;
    filled += fillWorkdayBlobFields(profile);
    filled += await fillWorkdayDropdowns(profile, settings);
    filled += await fillWorkdayApplicationQuestions(profile);
    filled += await fillWorkdayDemographics(profile, settings);
    filled += await fillDateOfBirthFields(profile);
    filled += await fillWorkdayExperienceExtras(profile, resume);

    const onExp =
      !!wdEl("applyFlowMyExpPage") || !!document.getElementById("Resume/CV-section");
    // Non-Experience pages only — attachResume itself locks after one attempt.
    if (resume && !onExp && attachResume(resume)) filled++;

    return filled;
  }

  // After the user hits Fill once, keep filling each step they advance to.
  // Never click Continue/Submit ourselves.
  let workdayAssistActive = false;
  let workdayAssistBusy = false;
  let workdayAssistLastFp = "";
  let workdayAssistBound = false;

  function isWorkdayUserContinueClick(target) {
    if (!target || !target.closest) return false;
    const btn = target.closest(
      "button, a[role='button'], div[role='button'], [data-automation-id]"
    );
    if (!btn || !isVisible(btn)) return false;
    const id = (btn.getAttribute("data-automation-id") || "").toLowerCase();
    if (
      id === "pagefooternextbutton" ||
      id === "bottom-navigation-next-button" ||
      id === "continuebutton"
    ) {
      return true;
    }
    const t = (btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!t || /submit|save for later|previous|back|cancel|delete|remove|add/.test(t)) {
      return false;
    }
    return (
      t === "save and continue" ||
      t === "save & continue" ||
      t === "continue" ||
      t === "next" ||
      /save and continue|continue to next|next step|^next$/.test(t)
    );
  }

  function isWorkdayUserSubmitClick(target) {
    if (!target || !target.closest) return false;
    const btn = target.closest("button, a[role='button'], div[role='button']");
    if (!btn) return false;
    const t = (btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    return (
      t === "submit" ||
      t === "submit application" ||
      t === "submit your application" ||
      /^submit\b/.test(t)
    );
  }

  function disarmWorkdayAssist() {
    workdayAssistActive = false;
  }

  async function runWorkdayAssistFill() {
    if (!workdayAssistActive || workdayAssistBusy) return;
    if (isWorkdayAuthWall()) {
      disarmWorkdayAssist();
      toast("Tvarin: sign in to continue, then hit Fill again.");
      return;
    }
    if (isWorkdaySubmitPage()) {
      disarmWorkdayAssist();
      toast("Tvarin: review step — Submit when you’re ready (we won’t click it).");
      return;
    }

    const fp = workdayPageFingerprint();
    if (fp && fp === workdayAssistLastFp) return;

    workdayAssistBusy = true;
    try {
      // New step → allow Experience extras again if they revisit Experience later
      // with a different fingerprint; same-step re-entry is skipped inside extras.
      if (fp !== workdayAssistLastFp) workdayExpExtrasDoneFor = "";

      const profile = await getProfile();
      const settings = await getSettings();
      if (!profile) {
        disarmWorkdayAssist();
        return;
      }
      const resume = await getResume();
      const filled = await fillWorkdayStep(profile, settings, resume);
      workdayAssistLastFp = workdayPageFingerprint();
      if (filled > 0) {
        toast(
          `Tvarin: filled ${filled} field${filled === 1 ? "" : "s"} on this step — Continue when ready.`
        );
      }
    } finally {
      workdayAssistBusy = false;
    }
  }

  function armWorkdayAssist() {
    workdayAssistActive = true;
    workdayAssistLastFp = workdayPageFingerprint();
    if (workdayAssistBound) return;
    workdayAssistBound = true;

    document.addEventListener(
      "click",
      (e) => {
        if (!workdayAssistActive || workdayAssistBusy) return;
        if (isWorkdayUserSubmitClick(e.target)) {
          disarmWorkdayAssist();
          return;
        }
        if (!isWorkdayUserContinueClick(e.target)) return;

        const fpBefore = workdayPageFingerprint();
        // Let Workday handle the click; then fill the step they land on.
        (async () => {
          const advanced = await waitForWorkdayChange(fpBefore, 12000);
          if (!workdayAssistActive) return;
          if (!advanced) {
            // Stayed on same step (validation errors) — try to fill any leftovers.
            workdayAssistLastFp = "";
            await runWorkdayAssistFill();
            return;
          }
          await sleep(400);
          await runWorkdayAssistFill();
        })();
      },
      true
    );
  }

  const workdayAdapter = {
    name: "workday",
    label: "Workday",
    async fill(profile, settings) {
      workdayExpExtrasDoneFor = "";
      resumeAttachLock = false;
      if (isWorkdayAuthWall()) {
        disarmWorkdayAssist();
        return {
          filled: 0,
          steps: 0,
          stopReason: "auth",
        };
      }
      if (isWorkdaySubmitPage()) {
        disarmWorkdayAssist();
        return {
          filled: 0,
          steps: 0,
          stopReason: "review",
        };
      }

      const resume = await getResume();
      const filled = await fillWorkdayStep(profile, settings, resume);
      armWorkdayAssist();

      return {
        filled,
        steps: 1,
        stopReason: "awaiting-continue",
      };
    },
  };

  // iCIMS — varies widely and often lives in an iframe; the generic label pass
  // does most of the work. Kept distinct for detection/labelling and future tuning.
  const icimsAdapter = {
    name: "icims",
    label: "iCIMS",
    fill(profile, settings) {
      return runAdapter([], profile, settings);
    },
  };

  /* ------------------------------------------------------------------ *
   * 5. Router
   * ------------------------------------------------------------------ */

  // Google Forms — recruiters collect applications through docs.google.com/forms.
  // Unlike an ATS, the page has no stable ids and is also used for surveys/RSVPs,
  // so we gate hard (see isJobGoogleForm) before claiming a form is a job app.

  function isGoogleFormsHost() {
    return (
      location.hostname === "docs.google.com" &&
      /\/forms\//.test(location.pathname)
    );
  }

  // The form's own title (shown in the header banner). On the edit view the tab
  // title carries a " - Google Forms" suffix we strip.
  function googleFormTitle() {
    const h = document.querySelector('[role="heading"]');
    const fromHeading = h && h.textContent && h.textContent.trim();
    if (fromHeading) return fromHeading;
    return (document.title || "")
      .replace(/\s*[-–]\s*Google Forms\s*$/i, "")
      .trim();
  }

  // Question text for one list item: the item's heading, else the aria-label of
  // its first control (both point at the same question copy).
  function googleFormListitemLabel(li) {
    const h = li.querySelector('[role="heading"]');
    if (h && h.textContent && h.textContent.trim()) return h.textContent.trim();
    const ctrl = li.querySelector(
      'input, textarea, [role="radiogroup"], [role="listbox"], [role="list"]'
    );
    const al = ctrl && ctrl.getAttribute("aria-label");
    return (al || "").trim();
  }

  function googleFormQuestionLabels() {
    return Array.from(document.querySelectorAll('div[role="listitem"]'))
      .map(googleFormListitemLabel)
      .filter(Boolean);
  }

  // Best-effort {company, jobTitle} so the activity log shows something better
  // than "docs.google.com". The form title is the most reliable single label.
  function scrapeGoogleFormMeta() {
    const title = googleFormTitle();
    const headEl = document.querySelector('[role="heading"]');
    const hay = `${title} ${headEl && headEl.parentElement ? headEl.parentElement.textContent : ""}`;
    let company = "";
    const at = hay.match(/\bat\s+([A-Z][A-Za-z0-9&.\- ]{1,40})/);
    if (at) company = at[1].trim().replace(/\s+(is|are|we|for)\b[\s\S]*$/i, "");
    return { jobTitle: title, company };
  }

  // Short-answer questions we could not map to a profile field and left empty.
  // Excludes paragraph/essay and choice widgets — those aren't profile data, so
  // counting them would just be noise. Surfacing this turns a silent miss (an
  // unusually-worded question like "What should we call you?") into a visible one.
  function countUnmappedGoogleFormQuestions() {
    let n = 0;
    document.querySelectorAll('div[role="listitem"]').forEach((li) => {
      const input = li.querySelector(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type])'
      );
      if (!input || !isVisible(input)) return;
      if (input.value && input.value.trim()) return; // already filled (by us or the user)
      if (matchProfileKey(getFieldContext(input))) return; // mapped — value may just be absent
      n++;
    });
    return n;
  }

  // Phase 2 — choice widgets. Google Forms renders single-choice, checkbox, and
  // dropdown questions as ARIA role-divs (not native inputs), so the generic
  // text pass skips them. We fill them by reusing the same intent (yes/no), EEO,
  // and profile-value resolvers the ATS adapters use. A wrong pick on a required
  // single-choice question can't be cleared, so we only click on a confident
  // match and otherwise leave the question blank.

  function gfOptionText(el) {
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("data-value") ||
      el.textContent ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
  }

  function gfNorm(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  // Matcher (optionText -> bool) for a choice question, or null when we have no
  // confident answer to give.
  function resolveGoogleFormChoiceMatcher(label, profile, settings) {
    const q = String(label || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!q) return null;
    // EEO / demographics (gender, ethnicity, veteran, disability, orientation).
    const demo = resolveWorkdayDemographicMatch(q, profile, settings);
    if (demo) return demo;
    // Intent-based yes/no facts (work auth, sponsorship, relocation, 18+, ...).
    const yn = resolveWorkdayQuestionAnswer(q, profile);
    if (yn) return matchYesNoOption(yn);
    // Direct profile value (e.g. country, pronouns). Conservative: normalized
    // equality, or one side is a clear prefix of the other.
    const key = matchProfileKey(q);
    if (key && key !== "fullName") {
      const val = gfNorm(valueForKey(profile, key));
      if (val && val.length >= 2) {
        return (t) => {
          const nt = gfNorm(t);
          if (!nt) return false;
          if (nt === val) return true;
          const [a, b] = nt.length <= val.length ? [nt, val] : [val, nt];
          return a.length >= 3 && b.startsWith(a + " ");
        };
      }
    }
    return null;
  }

  // Each choice question: its radiogroup or checkbox list, tied to its listitem.
  function googleFormChoiceGroups() {
    const groups = [];
    document.querySelectorAll('div[role="listitem"]').forEach((li) => {
      const rg = li.querySelector('[role="radiogroup"]');
      if (rg) {
        groups.push({ li, container: rg, optSel: '[role="radio"]' });
        return;
      }
      const list = li.querySelector('[role="list"]');
      if (list && list.querySelector('[role="checkbox"]')) {
        groups.push({ li, container: list, optSel: '[role="checkbox"]' });
      }
    });
    return groups;
  }

  // Single-choice + checkbox questions: click the matching option (plain .click()
  // registers with Google's handler — verified on a live form).
  function fillGoogleFormChoice(profile, settings) {
    let filled = 0;
    for (const g of googleFormChoiceGroups()) {
      const matcher = resolveGoogleFormChoiceMatcher(
        googleFormListitemLabel(g.li),
        profile,
        settings
      );
      if (!matcher) continue;
      const opts = Array.from(g.container.querySelectorAll(g.optSel)).filter(isVisible);
      const hit = opts.find((o) => {
        const t = gfOptionText(o);
        return t && matcher(t);
      });
      if (!hit || hit.getAttribute("aria-checked") === "true") continue;
      hit.click();
      filled++;
    }
    return filled;
  }

  // Dropdown questions (role="listbox"): open, pick the matching option, skipping
  // the "Choose" placeholder. Closes the menu again when nothing matches.
  async function fillGoogleFormDropdowns(profile, settings) {
    let filled = 0;
    const items = Array.from(document.querySelectorAll('div[role="listitem"]'));
    for (const li of items) {
      const listbox = li.querySelector('[role="listbox"]');
      if (!listbox || li.querySelector('[role="radiogroup"]')) continue;
      const matcher = resolveGoogleFormChoiceMatcher(
        googleFormListitemLabel(li),
        profile,
        settings
      );
      if (!matcher) continue;
      const chosen = listbox.querySelector('[role="option"][aria-selected="true"]');
      if (chosen && !/^\s*choose\s*$/i.test(chosen.textContent || "")) continue;
      listbox.click();
      await sleep(220);
      let opts = Array.from(li.querySelectorAll('[role="option"]'));
      if (!opts.length) opts = Array.from(document.querySelectorAll('[role="option"]'));
      const hit = opts.find((o) => {
        const t = gfOptionText(o);
        return t && !/^\s*choose\s*$/i.test(t) && matcher(t);
      });
      if (hit) {
        hit.click();
        filled++;
      } else {
        listbox.click(); // no match — close the menu we opened
        await sleep(60);
      }
    }
    return filled;
  }

  // Is this Google Form a job application (vs. a survey/RSVP/feedback form)?
  // Host is a given, so we require a real content signal on top of it: either a
  // job-shaped field cluster, or a job-shaped title alongside identity fields.
  function computeIsJobGoogleForm() {
    if (!isGoogleFormsHost()) return false;

    const titleHay = `${googleFormTitle()} ${document.title}`.toLowerCase();
    const titleLooksJob =
      /appl(y|ication)|position|\brole\b|candidate|hiring|resume|\bcv\b|cover letter|\bjob\b/.test(
        titleHay
      );

    const blob = googleFormQuestionLabels().join(" | ").toLowerCase();
    const hasEmail = /e-?mail/.test(blob);
    const hasName = /\bname\b|full name|first name|last name/.test(blob);
    const hasJobArtifact =
      /linkedin|resume|\bcv\b|portfolio|years?\s*of\s*experience|notice period|salary|work authorization|sponsorship|current company|current role|why do you want/.test(
        blob
      );

    if (hasEmail && hasName && hasJobArtifact) return true;
    if (titleLooksJob && hasEmail && hasName) return true;
    return false;
  }

  // Cheap on non-Google pages (host check short-circuits). On a form the DOM
  // scan is called repeatedly by the sidebar's mutation observer, so memoize
  // per-URL for a few seconds.
  let _gformGate = { url: "", val: false, at: 0 };
  function isJobGoogleForm() {
    if (!isGoogleFormsHost()) return false;
    const now = Date.now();
    const url = location.href.split("#")[0];
    if (_gformGate.url === url && now - _gformGate.at < 3000) return _gformGate.val;
    const val = computeIsJobGoogleForm();
    _gformGate = { url, val, at: now };
    return val;
  }

  function pickAdapter() {
    const host = location.hostname.toLowerCase();
    // Greenhouse: hosted boards, embedded iframe, or the tell-tale field ids.
    if (
      /greenhouse\.io$/.test(host) ||
      host.includes("greenhouse") ||
      (document.querySelector("#first_name") &&
        document.querySelector("#last_name") &&
        document.querySelector("#email"))
    ) {
      return greenhouseAdapter;
    }
    // Lever: hosted boards, or its distinctive urls[...] field names.
    if (
      /lever\.co$/.test(host) ||
      host.includes("lever.co") ||
      document.querySelector('input[name="urls[LinkedIn]"]')
    ) {
      return leverAdapter;
    }
    // Workday: myworkdayjobs.com, or its data-automation-id attributes.
    if (
      host.includes("myworkdayjobs.com") ||
      host.includes("workday") ||
      document.querySelector('[data-automation-id="applyFlowMyInfoPage"]') ||
      document.querySelector('[data-automation-id="formField-legalName--firstName"]') ||
      document.querySelector('[data-automation-id="legalNameSection_firstName"]') ||
      document.querySelector("#name--legalName--firstName")
    ) {
      return workdayAdapter;
    }
    // iCIMS: hosted domain (form often inside an icims.com iframe).
    if (host.includes("icims.com")) return icimsAdapter;

    // Google Forms: only when the gate says it's a job application.
    if (isJobGoogleForm()) return googleFormsAdapter;

    return genericAdapter;
  }

  // Used by the sidebar to auto-open on application pages.
  function isJobApplicationPage() {
    const host = location.hostname.toLowerCase();
    // Google Forms used as a job application (gated — see isJobGoogleForm).
    if (isJobGoogleForm()) return true;
    if (
      /greenhouse\.io$/.test(host) ||
      host.includes("greenhouse") ||
      host.includes("job-boards.") ||
      /lever\.co$/.test(host) ||
      host.includes("ashbyhq.com") ||
      host.includes("myworkdayjobs.com") ||
      /icims\.com$/.test(host) ||
      host.includes("jobs.") ||
      host.includes("careers.")
    ) {
      return true;
    }

    // Job description pages often have Apply but no form yet — still treat as job UX.
    const hay = (
      (document.body && document.body.innerText ? document.body.innerText : "") +
      " " +
      (document.title || "")
    )
      .slice(0, 8000)
      .toLowerCase();
    if (
      /\bapply\b/.test(hay) &&
      /(job description|about the role|responsibilities|qualifications|we're hiring|we are hiring)/.test(
        hay
      )
    ) {
      return true;
    }

    const forms = Array.from(document.querySelectorAll("form"));
    if (!forms.length) return false;

    const jobSignals =
      /apply|application|resume|curriculum|cover letter|job title|position applied/.test(
        hay
      );

    return forms.some((form) => {
      const hasEmail = !!form.querySelector(
        'input[type="email"], input[name*="email" i], input[id*="email" i], #email'
      );
      const hasName = !!form.querySelector(
        'input[name*="name" i], input[id*="name" i], #first_name, #last_name'
      );
      const hasResume = !!form.querySelector('input[type="file"]');
      return hasEmail && (hasName || hasResume || jobSignals);
    });
  }

  /* ------------------------------------------------------------------ *
   * 6. Orchestration + messaging
   * ------------------------------------------------------------------ */

  // Load Inter on the host page so toast / Draft match the sidebar.
  (function injectInterFonts() {
    if (document.getElementById("tvarin-inter-fonts")) return;
    const style = document.createElement("style");
    style.id = "tvarin-inter-fonts";
    const weights = [400, 500, 600, 700, 800];
    style.textContent = weights
      .map(
        (w) => `@font-face{font-family:"Inter";font-style:normal;font-weight:${w};font-display:swap;src:url("${chrome.runtime.getURL(
          `src/shared/fonts/Inter-${w}.woff2`
        )}") format("woff2");}`
      )
      .join("");
    (document.head || document.documentElement).appendChild(style);
  })();

  function toast(message, ms = 3200) {
    const existing = document.getElementById("tvarin-toast");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.id = "tvarin-toast";
    el.textContent = message;
    document.documentElement.appendChild(el);
    requestAnimationFrame(() => el.classList.add("tvarin-toast--show"));
    setTimeout(() => {
      el.classList.remove("tvarin-toast--show");
      setTimeout(() => el.remove(), 300);
    }, ms);
  }

  function bestEffortJobTitle() {
    const selectors = [
      "h1",
      "[data-qa='job-title']",
      ".app-title",
      ".job__title",
      ".posting-headline h2",
      "meta[property='og:title']",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const text =
        el.tagName === "META"
          ? el.getAttribute("content")
          : el.textContent;
      if (text && text.trim()) return text.trim();
    }
    return document.title || "";
  }

  function bestEffortCompany() {
    const sels = [
      "meta[property='og:site_name']",
      "[data-qa='company-name']",
      ".company-name",
      ".app-title .company",
      "a[data-mapped='companyName']",
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const text =
        el.tagName === "META"
          ? el.getAttribute("content")
          : el.textContent;
      if (text && text.trim()) return text.trim();
    }
    const host = location.hostname.replace(/^www\./, "");
    return host.split(".")[0] || "";
  }

  function textFrom(el) {
    return (el && (el.innerText || el.textContent) || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function bestEffortJobDescription() {
    const selectors = [
      "[data-qa='job-description']",
      ".job__description",
      "#content .content",
      ".content-intro",
      ".posting-description",
      ".job-description",
      "#job-description",
      "section[class*='description' i]",
      "div[class*='description' i]",
      "main",
      "article",
      "[role='main']",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const text = textFrom(el);
      if (text && text.length > 120) return text.slice(0, 8000);
    }
    return textFrom(document.body).slice(0, 8000);
  }

  function bestEffortJobRequirements() {
    const bodyText = textFrom(document.body);
    const chunks = [];
    const patterns = [
      /(?:requirements?|qualifications?|what (?:you'?ll|you will) need|you (?:should|must) have|minimum qualifications?)[:\s]+([\s\S]{80,2500}?)(?=(?:responsibilities|benefits|about (?:us|the)|equal opportunity|nice to have|$))/i,
      /(?:responsibilities|what (?:you'?ll|you will) do|the role)[:\s]+([\s\S]{80,2500}?)(?=(?:requirements|qualifications|benefits|about |equal opportunity|$))/i,
    ];
    for (const re of patterns) {
      const m = bodyText.match(re);
      if (m && m[0]) chunks.push(m[0].slice(0, 3000));
    }
    // Prefer explicit list sections on the page
    document.querySelectorAll("h2, h3, h4, strong").forEach((h) => {
      const label = (h.textContent || "").toLowerCase();
      if (!/(requirement|qualification|responsibilit|what you|you will|skills?)/.test(label)) {
        return;
      }
      const block = h.parentElement || h.nextElementSibling;
      const t = textFrom(block);
      if (t.length > 60) chunks.push(t.slice(0, 2500));
    });
    return [...new Set(chunks)].join("\n\n").slice(0, 5000);
  }

  // Human-readable question for the AI (not the autofill matcher haystack).
  function getQuestionForDraft(el) {
    const parts = [];
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) parts.push(lbl.innerText || lbl.textContent);
    }
    const wrapping = el.closest("label");
    if (wrapping) parts.push(wrapping.innerText || wrapping.textContent);

    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      labelledby.split(/\s+/).forEach((id) => {
        const n = document.getElementById(id);
        if (n) parts.push(n.innerText || n.textContent);
      });
    }

    // Nearby heading / legend / helper text above the field
    let node = el.previousElementSibling;
    for (let i = 0; i < 4 && node; i++, node = node.previousElementSibling) {
      const tag = node.tagName;
      if (/^(LABEL|P|SPAN|DIV|H[1-6]|LEGEND|STRONG)$/.test(tag)) {
        const t = (node.innerText || node.textContent || "").trim();
        if (t && t.length < 400) parts.push(t);
      }
    }
    const fieldset = el.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector("legend");
      if (legend) parts.push(legend.innerText || legend.textContent);
    }
    const group = el.closest("[class*='question' i], [class*='field' i], [data-qa]");
    if (group) {
      const qLabel = group.querySelector("label, .label, [class*='label' i], h3, h4");
      if (qLabel) parts.push(qLabel.innerText || qLabel.textContent);
    }

    parts.push(el.getAttribute("aria-label") || "", el.getAttribute("placeholder") || "");

    // Deduplicate while keeping order; pick the longest meaningful string
    const cleaned = [...new Set(parts.map((p) => (p || "").replace(/\s+/g, " ").trim()).filter(Boolean))];
    cleaned.sort((a, b) => b.length - a.length);
    return (cleaned[0] || "this open-ended question").slice(0, 800);
  }

  /* ------------------------------------------------------------------ *
   * 6b. AI answer drafting (open-ended questions)
   * ------------------------------------------------------------------ *
   * A floating "✨ Draft" button appears when the user focuses a textarea.
   * Clicking it asks the background worker for an AI draft (grounded in the
   * saved profile/resume), then fills the field FOR REVIEW — never submits.
   */

  let draftBtn = null;
  let activeTextarea = null;

  function ensureDraftButton() {
    if (draftBtn) return draftBtn;
    draftBtn = document.createElement("button");
    draftBtn.id = "tvarin-draft-btn";
    draftBtn.type = "button";
    draftBtn.textContent = "Draft";
    draftBtn.addEventListener("mousedown", (e) => e.preventDefault()); // keep textarea focus
    draftBtn.addEventListener("click", () => {
      if (activeTextarea) draftFor(activeTextarea);
    });
    document.documentElement.appendChild(draftBtn);
    return draftBtn;
  }

  function positionDraftButton(el) {
    const btn = ensureDraftButton();
    const r = el.getBoundingClientRect();
    btn.style.top = `${Math.max(4, r.top - 2)}px`;
    btn.style.left = `${Math.max(4, r.right - 64)}px`;
    btn.classList.add("tvarin-draft-btn--show");
  }

  function hideDraftButton() {
    if (draftBtn) draftBtn.classList.remove("tvarin-draft-btn--show");
  }

  async function draftFor(textarea) {
    if (!draftBtn) return;
    const question = getQuestionForDraft(textarea);
    draftBtn.textContent = "Drafting…";
    draftBtn.disabled = true;
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "TVARIN_AI_DRAFT",
        question,
        jobContext: {
          title: bestEffortJobTitle().slice(0, 300),
          company: bestEffortCompany().slice(0, 200),
          description: bestEffortJobDescription(),
          requirements: bestEffortJobRequirements(),
          url: location.href.slice(0, 500),
        },
      });
    } catch (e) {
      resp = { error: "Extension error — try reloading the page." };
    }
    draftBtn.textContent = "Draft";
    draftBtn.disabled = false;
    if (!resp || resp.error) {
      toast(`Tvarin AI: ${(resp && resp.error) || "no response."}`);
      return;
    }
    setNativeValue(textarea, resp.text);
    toast("Tvarin: drafted an answer — review and edit before submitting.");
  }

  // Draft is a job-application helper — it must not attach to every textarea on
  // the web (code editors, chat boxes, comment fields, etc.). Two gates:
  //   1. the page has to look like a job application (same test the sidebar uses
  //      to decide whether to auto-open), and
  //   2. the field must not be the backing textarea of a code editor — those
  //      show up in online coding assessments that can live on careers/jobs
  //      subdomains and would otherwise pass gate 1.
  let _jobPageCache = { href: null, val: false };
  function isJobApplicationPageCached() {
    if (_jobPageCache.href !== location.href) {
      _jobPageCache = { href: location.href, val: isJobApplicationPage() };
    }
    return _jobPageCache.val;
  }

  function isCodeEditorField(el) {
    if (!el) return false;
    // Backing textareas of the common web code editors live inside these hosts.
    if (
      el.closest(
        ".monaco-editor, .CodeMirror, .cm-editor, .ace_editor, " +
          "[data-mode-id], [class*='codemirror' i], [class*='monaco' i]"
      )
    ) {
      return true;
    }
    // Monaco/ACE/CodeMirror name their input element distinctively.
    const cls = (el.className && String(el.className)) || "";
    if (/\b(inputarea|ace_text-input|cm-content)\b/i.test(cls)) return true;
    // Editors hide their backing input from assistive tech.
    if (el.getAttribute("aria-hidden") === "true") return true;
    return false;
  }

  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (
        el &&
        el.tagName === "TEXTAREA" &&
        isVisible(el) &&
        !isCodeEditorField(el) &&
        isJobApplicationPageCached()
      ) {
        activeTextarea = el;
        positionDraftButton(el);
      }
    },
    true
  );
  document.addEventListener(
    "focusout",
    (e) => {
      if (e.target === activeTextarea) {
        setTimeout(() => {
          if (document.activeElement !== activeTextarea) {
            hideDraftButton();
            activeTextarea = null;
          }
        }, 200);
      }
    },
    true
  );
  window.addEventListener(
    "scroll",
    () => {
      if (activeTextarea && document.activeElement === activeTextarea) {
        positionDraftButton(activeTextarea);
      }
    },
    true
  );

  async function fillPage() {
    resumeAttachLock = false;
    const profile = await getProfile();
    if (!profile) {
      toast("Tvarin: set up your profile first (open the sidebar → Profile).");
      return { filled: 0, needsProfile: true };
    }
    const settings = await getSettings();
    const adapter = pickAdapter();
    const result = await adapter.fill(profile, settings);
    const filled = result.filled || 0;
    const stopReason = result.stopReason || null;
    const steps = result.steps || 0;
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];

    // Attach only if the adapter didn't already (Workday does this on Experience).
    // attachResume no-ops when the file is listed or this Fill already tried.
    const resume = await getResume();
    const resumeAttached = resume ? attachResume(resume) : false;

    // Filling a form is not the same as submitting an application. Keep the
    // useful local activity record, but make its state explicit so the tracker
    // never claims the applicant applied when they may still be reviewing it.
    // Only the TOP frame logs — otherwise embedded iframes (reCAPTCHA, Google
    // APIs, ATS embeds) each log themselves as bogus "applications".
    if (window === window.top) {
      // Adapters may supply better metadata than the page-scrape heuristics
      // (e.g. Google Forms, where hostname is always docs.google.com).
      const meta = result.meta || {};
      await upsertApplication({
        url: location.href.split("#")[0],
        hostname: location.hostname,
        jobTitle: (meta.jobTitle || bestEffortJobTitle()).slice(0, 200),
        company: (meta.company || bestEffortCompany()).slice(0, 200),
        ats: adapter.name,
        // Capture the JD now, while the posting is guaranteed on screen — the
        // record survives even after the posting is taken down.
        jobDescription: meta.jobDescription || bestEffortJobDescription(),
        filled,
        steps,
        stopReason,
        resumeAttached,
        status: "started",
      });
    }

    if (stopReason === "auth") {
      toast("Tvarin: sign in / create your Workday account, then hit Fill again.");
      return { filled, resumeAttached, adapter: adapter.name, stopReason, steps };
    }

    const parts = [];
    if (filled > 0) parts.push(`filled ${filled} field${filled === 1 ? "" : "s"}`);
    if (steps > 1) parts.push(`${steps} steps`);
    if (resumeAttached) parts.push("attached resume");
    if (stopReason === "awaiting-continue") {
      parts.push("Continue when ready — next steps fill automatically");
    } else if (stopReason === "review") {
      parts.push("stopped before Submit — review and send yourself");
    } else if (stopReason === "blocked") {
      parts.push("paused on a step that needs your input");
    }
    for (const w of warnings) {
      if (w && !parts.includes(w)) parts.push(w);
    }

    toast(
      parts.length
        ? `Tvarin: ${parts.join(" · ")} via ${adapter.label}.`
        : `Tvarin: no matching fields found (${adapter.label}).`,
      warnings.length ? 5200 : 3200
    );
    return { filled, resumeAttached, adapter: adapter.name, stopReason, steps, warnings };
  }

  /* ------------------------------------------------------------------ *
   * 6b. Form progress (sidebar progress bar + jump-to-field)
   * ------------------------------------------------------------------ */

  let tvarinFieldIdSeq = 0;
  const tvarinFieldById = new Map();
  let tvarinFlashEl = null;

  function ensureTvarinFieldId(el) {
    let id = el.getAttribute("data-tvarin-fid");
    if (id && tvarinFieldById.get(id) === el) return id;
    id = `tf${++tvarinFieldIdSeq}`;
    el.setAttribute("data-tvarin-fid", id);
    tvarinFieldById.set(id, el);
    return id;
  }

  function progressFieldLabel(el) {
    const wrap =
      el.closest('[data-automation-id^="formField-"]') ||
      el.closest("fieldset") ||
      el.closest("label") ||
      el.parentElement;
    let raw = "";
    if (wrap && typeof workdayFormFieldQuestionText === "function") {
      raw = workdayFormFieldQuestionText(wrap) || "";
    }
    if (!raw || raw.length < 2) {
      raw = getFieldContext(el);
    }
    raw = String(raw || "")
      .replace(/\s+/g, " ")
      .replace(/\bSelect One\b/gi, "")
      .replace(/\bError:.*$/gi, "")
      .replace(/\*\s*/g, "")
      .trim();
    if (!raw) {
      raw =
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.name ||
        el.id ||
        "Field";
    }
    if (raw.length > 100) raw = raw.slice(0, 97) + "…";
    return raw;
  }

  function isProgressFieldRequired(el) {
    if (el.required || el.getAttribute("aria-required") === "true") return true;
    const wrap =
      el.closest('[data-automation-id^="formField-"]') ||
      el.closest("fieldset") ||
      el.closest("label") ||
      el.parentElement;
    const hay = ((wrap && wrap.innerText) || getFieldContext(el) || "").slice(0, 500);
    if (/\*|required/i.test(hay)) return true;
    // Workday required markers
    if (wrap && wrap.querySelector('[data-automation-id*="required"], .required, abbr[title*="required" i]')) {
      return true;
    }
    return false;
  }

  function isProgressControlFilled(el) {
    if (!el) return false;
    if (el.type === "file") {
      if (el.files && el.files.length > 0) return true;
      const scope =
        el.closest("section") ||
        el.closest('[data-automation-id*="FileUpload"]') ||
        el.parentElement;
      const hay = (scope && scope.innerText) || "";
      return /successfully uploaded|uploaded!/i.test(hay);
    }
    if (el.tagName === "SELECT") {
      const opt = el.options[el.selectedIndex];
      const t = ((opt && opt.textContent) || el.value || "").trim();
      return !!(t && !/select one|select an option|choose|select/i.test(t));
    }
    if (
      el.matches &&
      el.matches(
        'button, [role="combobox"], [aria-haspopup="listbox"], [data-uxi-widget-type="selectinput"]'
      )
    ) {
      const t = (el.value || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || /select one|select an option|search|choose/i.test(t)) return false;
      // Chip selected nearby (phone code etc.)
      const wrap = el.closest('[data-automation-id^="formField-"]') || el.parentElement;
      if (wrap && wrap.querySelector('[data-automation-id="selectedItem"]')) return true;
      return t.length > 0;
    }
    if (el.type === "checkbox" || el.type === "radio") {
      const name = el.name;
      if (name) {
        const group = document.querySelectorAll(
          `input[type="${el.type}"][name="${CSS.escape(name)}"]`
        );
        return Array.from(group).some((r) => r.checked);
      }
      return !!el.checked;
    }
    return !!(el.value && String(el.value).trim());
  }

  function progressCandidateElements() {
    const list = [];
    const add = (el) => {
      if (!el || !isVisible(el)) return;
      list.push(el);
    };

    document
      .querySelectorAll(
        'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]), textarea, select'
      )
      .forEach(add);

    // Workday / custom "Select One" triggers
    document
      .querySelectorAll(
        'button[aria-haspopup="listbox"], [role="combobox"], button[id*="--"], [data-uxi-widget-type="selectinput"]'
      )
      .forEach((el) => {
        if (el.closest("nav, header, footer, [data-automation-id='bottom-navigation']")) {
          return;
        }
        const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (/save and continue|continue|submit|previous|back|cancel|add another|^add$/.test(t)) {
          return;
        }
        add(el);
      });

    return list;
  }

  function scanFormProgress() {
    const seen = new Set();
    const fields = [];

    for (const el of progressCandidateElements()) {
      const wrap =
        el.closest('[data-automation-id^="formField-"]') ||
        el.closest("fieldset") ||
        el.closest('[role="group"]');
      // Dedupe radios / splits: one entry per formField wrapper when possible.
      const dedupeKey = wrap || el;
      if (seen.has(dedupeKey)) continue;

      const label = progressFieldLabel(el);
      if (!label || label.length < 2) continue;
      // Skip chrome / navigation noise
      if (
        /save and continue|save for later|sign in|create account|cookie|privacy policy/i.test(
          label
        )
      ) {
        continue;
      }

      const required = isProgressFieldRequired(el);
      const key = matchProfileKey(getFieldContext(el) + " " + label);
      const looksLikeAppField =
        required ||
        !!key ||
        /question|experience|employ|sponsor|authori|relocat|resume|\bcv\b|linkedin|phone|email|name|address|gender|veteran|disabilit|birth|acknowledge/i.test(
          label
        );

      if (!looksLikeAppField) continue;

      seen.add(dedupeKey);
      // Prefer the interactive control inside the wrapper
      let control = el;
      if (wrap) {
        const inner =
          wrap.querySelector(
            'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select, button[aria-haspopup], [role="combobox"]'
          ) ||
          wrap.querySelector('input[type="radio"], input[type="checkbox"], input[type="file"]');
        if (inner) control = inner;
      }

      const id = ensureTvarinFieldId(control);
      fields.push({
        id,
        label,
        required,
        filled: isProgressControlFilled(control),
      });
    }

    const requiredList = fields.filter((f) => f.required);
    const list = requiredList.length >= 2 ? requiredList : fields;
    // Cap for UI sanity
    const capped = list.slice(0, 40);
    const filledCount = capped.filter((f) => f.filled).length;
    const total = capped.length;
    return {
      total,
      filled: filledCount,
      percent: total ? Math.round((filledCount / total) * 100) : 0,
      fields: capped,
    };
  }

  function focusFormField(id) {
    if (!id) return false;
    const el =
      tvarinFieldById.get(id) ||
      document.querySelector(`[data-tvarin-fid="${CSS.escape(String(id))}"]`);
    if (!el || !document.contains(el)) return false;

    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    try {
      el.focus({ preventScroll: true });
    } catch (_) {
      try {
        el.focus();
      } catch (_) {
        /* ignore */
      }
    }

    if (tvarinFlashEl) {
      tvarinFlashEl.style.outline = "";
      tvarinFlashEl.style.outlineOffset = "";
    }
    tvarinFlashEl = el;
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = "2px solid #2f6fed";
    el.style.outlineOffset = "3px";
    setTimeout(() => {
      if (tvarinFlashEl === el) {
        el.style.outline = prevOutline;
        el.style.outlineOffset = prevOffset;
        tvarinFlashEl = null;
      }
    }, 1600);
    return true;
  }

  // Shared with sidebar.js (same isolated world, top frame).
  // Job context for the resume↔job match analysis (leads with the requirements
  // section — the strongest matching signal — then the broader description).
  function jobInfo() {
    const requirements = bestEffortJobRequirements();
    const description = bestEffortJobDescription();
    const combined = [requirements, description].filter(Boolean).join("\n\n");
    return {
      title: bestEffortJobTitle().slice(0, 300),
      description: combined.slice(0, 8000),
    };
  }

  /* ------------------------------------------------------------------ *
   * 7. Saved logins — autofill & offer-to-save on auth pages
   * ------------------------------------------------------------------ *
   * Companies force a new account per portal (Workday, iCIMS, …). This
   * detects login / signup forms, autofills a saved login, offers to save a
   * new one after submit, and can generate a strong password at signup.
   * Passwords are decrypted in the background just-in-time; this script only
   * ever holds the one it's about to type. Never auto-submits.
   */

  const SIGNUP_RE =
    /sign\s?up|create (an )?account|register|get started|new account|join now/i;

  function visiblePasswordInputs(root) {
    return Array.from(
      (root || document).querySelectorAll('input[type="password"]')
    ).filter(isVisible);
  }

  // Find the username/email field paired with a password field: an explicit
  // email/username input, else the last text-like input before it.
  function findUsernameInput(scope, passwordEl) {
    const byType = Array.from(
      scope.querySelectorAll('input[type="email"]')
    ).filter(isVisible);
    if (byType.length) return byType[0];

    const hintRe = /user|email|login|identifier|account|e-mail/i;
    const hinted = Array.from(
      scope.querySelectorAll('input[type="text"], input[type="tel"], input:not([type])')
    ).filter((el) => {
      if (!isVisible(el)) return false;
      const hay = `${el.name} ${el.id} ${el.autocomplete} ${el.placeholder} ${
        el.getAttribute("aria-label") || ""
      }`;
      return hintRe.test(hay);
    });
    if (hinted.length) return hinted[0];

    // Fallback: last visible text input that sits before the password field.
    const texts = Array.from(
      scope.querySelectorAll('input[type="text"], input:not([type])')
    ).filter(isVisible);
    if (passwordEl) {
      const before = texts.filter(
        (t) => t.compareDocumentPosition(passwordEl) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (before.length) return before[before.length - 1];
    }
    return texts[0] || null;
  }

  // Describe the auth form on the page, if any.
  function detectAuthForm() {
    const pwds = visiblePasswordInputs(document);
    if (!pwds.length) return null;
    const first = pwds[0];
    const scope = first.closest("form") || document.body;
    const scopedPwds = pwds.filter((p) => (p.closest("form") || document.body) === scope);
    const username = findUsernameInput(scope, first);

    const text = `${scope.innerText || ""} ${document.title}`.slice(0, 4000);
    const kind = scopedPwds.length >= 2 || SIGNUP_RE.test(text) ? "signup" : "login";
    return { scope, passwords: scopedPwds.length ? scopedPwds : pwds, username, kind };
  }

  function sendBg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          void chrome.runtime.lastError; // swallow "context invalidated"
          resolve(resp || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  // A dismissible prompt with action buttons (richer than toast()).
  function credPrompt(message, actions) {
    const existing = document.getElementById("tvarin-cred-prompt");
    if (existing) existing.remove();
    const box = document.createElement("div");
    box.id = "tvarin-cred-prompt";
    const msg = document.createElement("div");
    msg.className = "tvarin-cred-prompt__msg";
    msg.textContent = message;
    box.appendChild(msg);
    const row = document.createElement("div");
    row.className = "tvarin-cred-prompt__actions";
    const close = () => {
      box.classList.remove("tvarin-cred-prompt--show");
      setTimeout(() => box.remove(), 250);
    };
    (actions || []).forEach((a) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = a.label;
      btn.className = a.primary
        ? "tvarin-cred-prompt__btn tvarin-cred-prompt__btn--primary"
        : "tvarin-cred-prompt__btn";
      btn.addEventListener("click", () => {
        close();
        try {
          a.onClick && a.onClick();
        } catch (_) {}
      });
      row.appendChild(btn);
    });
    box.appendChild(row);
    document.documentElement.appendChild(box);
    requestAnimationFrame(() => box.classList.add("tvarin-cred-prompt--show"));
    // Auto-dismiss non-critical prompts after a while.
    setTimeout(close, 18000);
    return close;
  }

  function fillPasswordField(el, value) {
    // Password managers usually leave a filled field alone; we do too.
    if (!value || !isVisible(el) || (el.value && el.value.trim())) return false;
    setNativeValue(el, value);
    return true;
  }

  async function autofillSavedLogin(auth) {
    const resp = await sendBg({ type: "TVARIN_CRED_MATCH", host: location.hostname });
    const creds = (resp && resp.credentials) || [];
    if (!creds.length) return false;
    const cred = creds[0]; // most-recently-used match
    let filled = false;
    if (auth.username && cred.username) {
      filled = fillField(auth.username, cred.username) || filled;
    }
    auth.passwords.forEach((p) => {
      filled = fillPasswordField(p, cred.password) || filled;
    });
    if (filled) {
      sendBg({ type: "TVARIN_CRED_TOUCH", id: cred.id });
      const who = cred.username ? ` (${cred.username})` : "";
      toast(`Tvarin: filled your saved login${who}. Review, then sign in.`);
    }
    return filled;
  }

  async function offerGeneratePassword(auth) {
    const resp = await sendBg({ type: "TVARIN_CRED_GENERATE" });
    const pw = resp && resp.password;
    if (!pw) return;
    credPrompt("Creating an account? Tvarin can set a strong password.", [
      {
        label: "Generate password",
        primary: true,
        onClick: () => {
          let did = false;
          auth.passwords.forEach((p) => {
            setNativeValue(p, pw);
            did = true;
          });
          if (did) toast("Tvarin: strong password filled. It'll be offered to save on submit.");
        },
      },
      { label: "No thanks" },
    ]);
  }

  // Stash the just-submitted credentials so the save prompt survives a
  // full-page navigation (background holds them in session memory).
  function stashOnSubmit(auth) {
    const capture = () => {
      const pw = auth.passwords.find((p) => p.value && p.value.trim());
      if (!pw) return;
      sendBg({
        type: "TVARIN_CRED_STASH",
        origin: location.hostname,
        username: (auth.username && auth.username.value) || "",
        password: pw.value,
        kind: auth.kind,
      });
    };
    const form = auth.scope.tagName === "FORM" ? auth.scope : null;
    if (form) form.addEventListener("submit", capture, true);
    // SPA logins often submit via a button click, not a form submit event.
    auth.scope.addEventListener(
      "click",
      (e) => {
        if (isSubmitControl(e.target) || /log ?in|sign ?in|sign ?up|continue|create/i.test(
          (e.target.closest("button,[role=button]") || {}).textContent || ""
        )) {
          setTimeout(capture, 0);
        }
      },
      true
    );
  }

  // If a submit stashed a login, ask whether to save it (this page or the next).
  async function maybeOfferSave() {
    const resp = await sendBg({ type: "TVARIN_CRED_PENDING", host: location.hostname });
    const pending = resp && resp.pending;
    if (!pending) return;
    const who = pending.username ? ` for ${pending.username}` : "";
    credPrompt(`Save this login${who} on ${credLabelHost(pending.origin)} to Tvarin?`, [
      {
        label: "Save password",
        primary: true,
        onClick: async () => {
          const r = await sendBg({ type: "TVARIN_CRED_COMMIT_PENDING" });
          toast(r && r.ok ? "Tvarin: login saved." : "Tvarin: couldn't save login.");
        },
      },
      {
        label: "Not now",
        onClick: () => sendBg({ type: "TVARIN_CRED_PENDING_CLEAR" }),
      },
    ]);
  }

  function credLabelHost(host) {
    return String(host || location.hostname).replace(/^www\./, "");
  }

  let credInited = false;
  async function initCredentials() {
    if (credInited) return;
    // First, surface any pending save from a previous page's submit.
    await maybeOfferSave();

    const auth = detectAuthForm();
    if (!auth) return;
    credInited = true;

    stashOnSubmit(auth);
    const didFill = await autofillSavedLogin(auth);
    if (!didFill && auth.kind === "signup") await offerGeneratePassword(auth);
  }

  // Auth forms often render after load (SPAs); retry briefly, then observe.
  function scheduleCredInit() {
    initCredentials();
    let tries = 0;
    const iv = setInterval(() => {
      if (credInited || tries++ > 6) {
        clearInterval(iv);
        return;
      }
      if (detectAuthForm()) initCredentials();
    }, 700);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleCredInit, { once: true });
  } else {
    scheduleCredInit();
  }

  globalThis.TvarinAPI = {
    fill: fillPage,
    isJobPage: isJobApplicationPage,
    scanProgress: scanFormProgress,
    focusField: focusFormField,
    jobInfo,
  };

  // Cross-frame relay: sidebar → iframes ("fill"), iframe → top ("submitted").
  window.addEventListener("message", (e) => {
    if (!e.data || e.data.source !== "tvarin") return;
    if (e.data.type === "TVARIN_FILL_FRAME") {
      if (window === window.top) return; // top frame fills via TvarinAPI directly
      fillPage();
    } else if (e.data.type === "TVARIN_SUBMITTED" && window === window.top) {
      const now = Date.now();
      if (now - lastAppliedAt < 4000) return;
      lastAppliedAt = now;
      markApplicationApplied().then(() => toast("Tvarin: recorded as applied."));
    }
  });

  // Keep message fill for toolbar/background relay and tests.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "TVARIN_FILL") {
      fillPage().then(sendResponse);
      return true; // keep the message channel open for the async response
    }
  });
})();

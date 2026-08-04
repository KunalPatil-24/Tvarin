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

  function logApplication(entry) {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEYS.applications, (res) => {
        const list = res[STORAGE_KEYS.applications] || [];
        list.unshift(entry);
        chrome.storage.local.set(
          { [STORAGE_KEYS.applications]: list.slice(0, 500) },
          resolve
        );
      });
    });
  }

  // Promote an in-progress ("started") fill to "applied", or create a new applied
  // entry. Fill alone never means the user submitted — only a real Submit click.
  function markApplicationApplied(meta = {}) {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEYS.applications, (res) => {
        const list = res[STORAGE_KEYS.applications] || [];
        const now = Date.now();
        const job = {
          url: (meta.url || location.href).split("#")[0],
          hostname: meta.hostname || location.hostname,
          jobTitle: (meta.jobTitle || bestEffortJobTitle()).slice(0, 200),
          company: (meta.company || bestEffortCompany()).slice(0, 200),
          ats: meta.ats || (pickAdapter() && pickAdapter().name) || "generic",
        };

        const norm = (u) =>
          String(u || "")
            .split("?")[0]
            .replace(/\/apply\/?.*$/i, "")
            .replace(/\/$/, "");

        const sameJob = (a) => {
          if (!a) return false;
          if ((a.hostname || "") !== job.hostname) return false;
          if (a.jobTitle && job.jobTitle && a.jobTitle === job.jobTitle) return true;
          return norm(a.url) === norm(job.url);
        };

        // Prefer upgrading a recent "started" row for this job (last 7 days).
        const idx = list.findIndex(
          (a) =>
            sameJob(a) &&
            a.status !== "applied" &&
            now - (a.timestamp || 0) < 7 * 24 * 60 * 60 * 1000
        );

        if (idx >= 0) {
          list[idx] = {
            ...list[idx],
            ...job,
            status: "applied",
            appliedAt: now,
            timestamp: now,
          };
        } else if (!list.some((a) => sameJob(a) && a.status === "applied" && now - (a.appliedAt || a.timestamp || 0) < 60 * 1000)) {
          // Avoid double-logging the same Submit within a minute.
          list.unshift({
            ...job,
            status: "applied",
            appliedAt: now,
            timestamp: now,
          });
        }

        chrome.storage.local.set(
          { [STORAGE_KEYS.applications]: list.slice(0, 500) },
          resolve
        );
      });
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
    ["addressLine1", [/address line ?1/, /street/, /\baddress\b/, /\baddr\b/]],
    ["city", [/\bcity\b/, /\btown\b/]],
    ["state", [/\bstate\b/, /province/, /\bregion\b/]],
    ["postalCode", [/postal/, /post ?code/, /\bzip\b/, /pin ?code/]],
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
      if (patterns.some((re) => re.test(context))) return key;
    }
    return null;
  }

  function primaryEducation(profile) {
    return Array.isArray(profile.educations) && profile.educations.length
      ? profile.educations[0]
      : null;
  }

  function primaryExperience(profile) {
    return Array.isArray(profile.experiences) && profile.experiences.length
      ? profile.experiences[0]
      : null;
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

  // Async pass: fill the comboboxes we can. Returns how many were set.
  async function fillComboboxes(items, profile, settings) {
    let filled = 0;
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

    // Greenhouse Education: School / Degree / Discipline / start+end month.
    await fillKey("school", {
      typeahead: valueForKey(profile, "school"),
      match: (t) => fuzzyOptionMatch(t, valueForKey(profile, "school")),
    });
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

    return filled;
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
    filled += await fillComboboxes(items, profile, settings);
    filled += await fillDateOfBirthFields(profile);
    return { filled };
  }

  // Generic heuristic adapter — the fallback that works best-effort anywhere.
  const genericAdapter = {
    name: "generic",
    label: "Generic",
    fill(profile, settings) {
      return runAdapter([], profile, settings);
    },
  };

  // Greenhouse — stable ids; phone is always paired with a country selector,
  // so the phone box holds the national number only.
  // Education uses react-select comboboxes (#school--0 …) plus year number inputs.
  const greenhouseAdapter = {
    name: "greenhouse",
    label: "Greenhouse",
    fill(profile, settings) {
      const known = collectKnown([
        ["#first_name", "firstName"],
        ["#last_name", "lastName"],
        ["#email", "email"],
        ["#phone", "phone"],
        ["#school--0", "school"],
        ["#degree--0", "degree"],
        ["#discipline--0", "discipline"],
        ["#start-month--0", "eduStartMonth"],
        ["#start-year--0", "eduStartYear"],
        ["#end-month--0", "eduEndMonth"],
        ["#end-year--0", "eduEndYear"],
      ]);
      return runAdapter(known, profile, settings, {
        forceCountryCode: !!document.querySelector("#country"),
      });
    },
  };

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
    document.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape", keyCode: 27 })
    );
    if (document.activeElement) document.activeElement.blur();
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
      return true; // already set
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
      closeWorkdayPopup();
      return false;
    }

    // Prefer clicking the menu row; Workday often ignores clicks on the inner label only.
    const clickEl =
      target.closest('[data-automation-id="menuItem"]') ||
      target.closest('[role="option"]') ||
      target;

    function fireClick(el) {
      el.scrollIntoView({ block: "nearest" });
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        el.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
        );
      }
    }

    fireClick(clickEl);
    await sleep(220);

    // If the trigger still doesn't show the value, try Enter (active highlighted row).
    const shownAfter = (trigger.value || trigger.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!match(shownAfter)) {
      const enterTarget = search || document.activeElement || trigger;
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
      await sleep(220);
    }

    const finalShown = (trigger.value || trigger.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (match(finalShown)) return true;

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
    if (!verified) closeWorkdayPopup();
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
      const want = profile.state.toLowerCase().trim();
      const opts = {
        typeahead: profile.state,
        match: (t) => {
          const s = t.toLowerCase().trim();
          return s === want || s.startsWith(want);
        },
      };
      for (const id of [
        "formField-countryRegion",
        "formField-province",
        "formField-state",
        "addressSection_countryRegion_province",
        "addressSection_province",
        "province",
        "state",
        "countryRegion",
      ]) {
        if (await pickWorkdayById(id, opts)) {
          filled++;
          break;
        }
      }
    }

    // Source ("How did you hear?") — hierarchical categories on some tenants
    // (Socially → LinkedIn). Try LinkedIn first, then Socially as a parent.
    {
      const sourceIds = ["formField-source", "source"];
      let sourceOk = false;
      for (const id of sourceIds) {
        if (
          await pickWorkdayById(id, {
            typeahead: "LinkedIn",
            match: (t) => /linkedin/i.test(t),
          })
        ) {
          sourceOk = true;
          break;
        }
      }
      if (!sourceOk) {
        for (const id of sourceIds) {
          if (
            await pickWorkdayById(id, {
              typeahead: "Socially",
              match: (t) => /^socially$/i.test(t.trim()),
            })
          ) {
            // After picking a parent category, try LinkedIn leaf if it appears.
            await sleep(350);
            const leaf = Array.from(
              document.querySelectorAll(
                '[data-automation-id="menuItem"][role="option"], [data-automation-id="promptOption"]'
              )
            ).find((o) =>
              /linkedin/i.test(
                o.getAttribute("data-automation-label") || o.textContent || ""
              )
            );
            if (leaf) {
              leaf.click();
              await sleep(150);
            }
            sourceOk = true;
            break;
          }
        }
      }
      if (sourceOk) filled++;
    }

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
        /(work experience|experience description|role description|job description|experience summary)/.test(
          ctx
        ) &&
        (profile.experience || primaryExperience(profile))
      ) {
        const exp = primaryExperience(profile);
        const bullets =
          exp && Array.isArray(exp.bullets)
            ? exp.bullets.filter(Boolean).map((b) => `• ${b}`).join("\n")
            : "";
        const text =
          (exp &&
            [exp.summary, bullets].filter(Boolean).join("\n").trim()) ||
          profile.experience;
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

  async function fillWorkdayExperienceExtras(profile, resume) {
    let filled = 0;
    const onExp =
      !!wdEl("applyFlowMyExpPage") ||
      !!document.getElementById("Work-Experience-section") ||
      !!document.getElementById("Resume/CV-section");
    if (!onExp) return 0;

    const stepKey = workdayPageFingerprint();
    if (workdayExpExtrasDoneFor === stepKey) return 0;
    workdayExpExtrasDoneFor = stepKey;

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

    return genericAdapter;
  }

  // Used by the sidebar to auto-open on application pages.
  function isJobApplicationPage() {
    const host = location.hostname.toLowerCase();
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

  function toast(message) {
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
    }, 3200);
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

  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (el && el.tagName === "TEXTAREA" && isVisible(el)) {
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
      await logApplication({
        url: location.href,
        hostname: location.hostname,
        jobTitle: bestEffortJobTitle().slice(0, 200),
        company: bestEffortCompany().slice(0, 200),
        ats: adapter.name,
        filled,
        steps,
        stopReason,
        resumeAttached,
        status: "started",
        timestamp: Date.now(),
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

    toast(
      parts.length
        ? `Tvarin: ${parts.join(" · ")} via ${adapter.label}.`
        : `Tvarin: no matching fields found (${adapter.label}).`
    );
    return { filled, resumeAttached, adapter: adapter.name, stopReason, steps };
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

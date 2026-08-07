/*
 * In-page profile modal (Jobright-style), same isolated world as sidebar.
 * Opens over the current tab instead of chrome.runtime.openOptionsPage().
 */
(() => {
  "use strict";

  if (window !== window.top) return;
  if (globalThis.__tvarinProfileModalLoaded) return;
  globalThis.__tvarinProfileModalLoaded = true;

  const HOST_ID = "tvarin-profile-modal-host";
  const KEYS = {
    profile: "tvarin.profile",
    settings: "tvarin.settings",
    ai: "tvarin.ai",
  };

  const PROFILE_FIELDS = [
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
    // experience / educations are structured arrays (see helpers below)
    // Application facts — same intents, different wording per company/country
    "willingToRelocate",
    "hasNonCompete",
    "workAuthorized",
    "needsSponsorship",
    "isOfLegalWorkingAge",
    "isGovernmentEmployee",
    "relatedToCompany",
    "hasCriminalRecord",
    // Semi-constant — real values drift, so the UI flags them for a re-check.
    "noticePeriod",
    "currentCTC",
    // Demographics / EEO (voluntary)
    "gender",
    "ethnicity",
    "veteranStatus",
    "sexualOrientation",
    "disabilityStatus",
  ];

  const YES_NO = [
    ["", "Not set"],
    ["yes", "Yes"],
    ["no", "No"],
  ];

  const YES_NO_DECLINE = [
    ["", "Not set"],
    ["yes", "Yes"],
    ["no", "No"],
    ["prefer_not_to_say", "Prefer not to say"],
  ];

  const GENDER_OPTS = [
    ["", "Not set"],
    ["male", "Male"],
    ["female", "Female"],
    ["non_binary", "Non-binary"],
    ["other", "Other"],
    ["prefer_not_to_say", "Prefer not to say"],
  ];

  const ETHNICITY_OPTS = [
    ["", "Not set"],
    ["american_indian", "American Indian or Alaska Native"],
    ["asian", "Asian"],
    ["black", "Black or African American"],
    ["hispanic", "Hispanic or Latino"],
    ["pacific_islander", "Native Hawaiian or Other Pacific Islander"],
    ["white", "White"],
    ["two_or_more", "Two or more races"],
    ["prefer_not_to_say", "Prefer not to say"],
  ];

  const VETERAN_OPTS = [
    ["", "Not set"],
    ["not_veteran", "I am not a veteran"],
    ["protected_veteran", "I identify as a protected veteran"],
    ["veteran", "I am a veteran, but not protected"],
    ["prefer_not_to_say", "Prefer not to say"],
  ];

  const ORIENTATION_OPTS = [
    ["", "Not set"],
    ["heterosexual", "Heterosexual / Straight"],
    ["gay_lesbian", "Gay or Lesbian"],
    ["bisexual", "Bisexual"],
    ["other", "Other"],
    ["prefer_not_to_say", "Prefer not to say"],
  ];

  const DISABILITY_OPTS = [
    ["", "Not set"],
    ["yes", "Yes, I have a disability (or have had one)"],
    ["no", "No, I do not have a disability"],
    ["prefer_not_to_say", "I do not want to answer"],
  ];

  let host = null;
  let root = null;
  let activeSection = "personal";

  function get(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }
  function set(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  function fontFaceCss() {
    return [400, 500, 600, 700, 800]
      .map(
        (w) => `@font-face{font-family:"Inter";font-style:normal;font-weight:${w};font-display:swap;src:url("${chrome.runtime.getURL(
          `src/shared/fonts/Inter-${w}.woff2`
        )}") format("woff2");}`
      )
      .join("");
  }

  function css() {
    return `
      ${fontFaceCss()}
      :host { all: initial; }
      * { box-sizing: border-box; }
      .overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 32px 40px;
        font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #111111;
        -webkit-font-smoothing: antialiased;
      }
      .overlay[hidden] { display: none !important; }
      .backdrop {
        position: absolute;
        inset: 0;
        background: rgba(17, 24, 39, 0.45);
      }
      .dialog {
        position: relative;
        width: min(1120px, 82vw);
        height: min(760px, 78vh);
        background: #ffffff;
        border-radius: 16px;
        box-shadow: 0 24px 64px rgba(17, 24, 39, 0.22);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .dialog__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 18px 20px 14px;
        flex-shrink: 0;
      }
      .dialog__title {
        margin: 0;
        font-size: 20px;
        font-weight: 800;
        letter-spacing: -0.03em;
      }
      .x {
        width: 36px;
        height: 36px;
        border: none;
        border-radius: 10px;
        background: transparent;
        color: #6b7280;
        cursor: pointer;
        display: grid;
        place-items: center;
      }
      .x:hover { background: #f3f4f6; color: #111; }
      .x svg { width: 18px; height: 18px; }
      .banner {
        margin: 0 20px 12px;
        padding: 10px 12px;
        border-radius: 10px;
        background: #f5f6f8;
        color: #4b5563;
        font-size: 12.5px;
        line-height: 1.45;
        flex-shrink: 0;
      }
      .banner strong { color: #111; font-weight: 600; }
      .main {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: 220px 1fr;
        border-top: 1px solid #ebebeb;
      }
      .nav {
        padding: 12px;
        border-right: 1px solid #ebebeb;
        background: #fafafa;
        overflow-y: auto;
      }
      .nav button {
        display: block;
        width: 100%;
        text-align: left;
        border: none;
        background: transparent;
        border-radius: 10px;
        padding: 10px 12px;
        font: 600 13.5px/1.3 "Inter", system-ui, sans-serif;
        color: #374151;
        cursor: pointer;
        margin-bottom: 2px;
      }
      .nav button:hover { background: #f0f1f3; }
      .nav button.is-active {
        background: #eef0f3;
        color: #111;
      }
      .content {
        display: flex;
        flex-direction: column;
        min-height: 0;
        height: 100%;
        overflow: hidden;
        background: #fff;
      }
      .content form {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        height: 100%;
      }
      .panels {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 28px 32px 16px;
        -webkit-overflow-scrolling: touch;
      }
      .foot {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 14px;
        padding: 16px 22px 20px;
        border-top: 1px solid #ebebeb;
        flex-shrink: 0;
      }
      .panel[hidden] { display: none !important; }
      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px 16px;
      }
      .grid__full { grid-column: 1 / -1; }
      label.field, .field {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 12.5px;
        font-weight: 600;
        color: #111;
      }
      label.field span.req, .field > span .req, .field .req { color: #ef4444; margin-right: 2px; }
      input, textarea, select {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid transparent;
        border-radius: 10px;
        background: #f3f4f6;
        font: 400 14px/1.4 "Inter", system-ui, sans-serif;
        color: #111;
      }
      input:focus, textarea:focus, select:focus {
        outline: none;
        background: #fff;
        border-color: #2f6fed;
        box-shadow: 0 0 0 3px rgba(47, 111, 237, 0.18);
      }
      textarea { resize: vertical; min-height: 120px; }
      .note {
        margin: 0 0 14px;
        font-size: 13px;
        font-weight: 400;
        color: #6b7280;
        line-height: 1.45;
      }
      .note--warn {
        padding: 9px 12px;
        border-radius: 8px;
        background: #fef3c7;
        border: 1px solid #fcd34d;
        color: #92400e;
        font-weight: 500;
      }
      .section-title {
        margin: 18px 0 10px;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: #111;
      }
      .section-title:first-child { margin-top: 0; }
      .check {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        font-size: 13px;
        font-weight: 400;
        color: #4b5563;
        line-height: 1.45;
        margin-top: 14px;
      }
      .check input { width: auto; margin-top: 3px; flex-shrink: 0; }
      .entry {
        margin-bottom: 22px;
        padding-bottom: 18px;
        border-bottom: 1px solid #f0f1f3;
      }
      .entry:last-of-type { border-bottom: none; padding-bottom: 0; }
      .entry__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
      }
      .entry__title {
        margin: 0;
        font-size: 18px;
        font-weight: 800;
        letter-spacing: -0.02em;
        color: #111;
      }
      .entry__remove {
        border: none;
        background: transparent;
        color: #9ca3af;
        font: 600 12.5px/1 "Inter", system-ui, sans-serif;
        cursor: pointer;
        padding: 6px 8px;
        border-radius: 8px;
      }
      .entry__remove:hover { background: #f3f4f6; color: #b91c1c; }
      .month-year {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .month-year select:disabled {
        background: #f3f4f6;
        color: #9ca3af;
        cursor: not-allowed;
      }
      .date-check {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-top: 8px;
        font-size: 12.5px;
        font-weight: 500;
        color: #4b5563;
      }
      .date-check input { width: auto; margin: 0; flex-shrink: 0; }
      .bullets { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
      .bullet {
        display: flex;
        gap: 8px;
        align-items: flex-start;
      }
      .bullet textarea {
        min-height: 64px;
        flex: 1;
      }
      .bullet__remove {
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        margin-top: 4px;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: #9ca3af;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
      }
      .bullet__remove:hover { background: #f3f4f6; color: #b91c1c; }
      .add-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        margin-top: 10px;
        padding: 10px 16px;
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        background: #fff;
        color: #111;
        font: 600 13.5px/1.2 "Inter", system-ui, sans-serif;
        cursor: pointer;
      }
      .add-btn:hover { background: #f9fafb; border-color: #d1d5db; }
      .add-btn--block { width: 100%; margin-top: 4px; }
      .skills-block {
        margin-top: 28px;
        padding-top: 18px;
        border-top: 1px solid #ebebeb;
      }
      .save {
        min-width: 280px;
        padding: 13px 28px;
        border: none;
        border-radius: 999px;
        background: #2f6fed;
        color: #fff;
        font: 700 15px/1.2 "Inter", system-ui, sans-serif;
        cursor: pointer;
      }
      .save:hover { filter: brightness(1.05); }
      .save:disabled { opacity: 0.55; cursor: default; }
      .saved {
        font-size: 13px;
        font-weight: 600;
        color: #059669;
        min-width: 4ch;
      }
      .linkish {
        border: none;
        background: none;
        color: #2f6fed;
        font: 600 13px/1.3 inherit;
        cursor: pointer;
        padding: 0;
        text-decoration: underline;
      }
      @media (max-width: 720px) {
        .overlay { padding: 12px; }
        .dialog {
          width: 100%;
          height: min(900px, 92vh);
        }
        .main { grid-template-columns: 1fr; }
        .nav {
          display: flex;
          gap: 4px;
          overflow-x: auto;
          border-right: none;
          border-bottom: 1px solid #ebebeb;
        }
        .nav button { width: auto; white-space: nowrap; }
        .grid { grid-template-columns: 1fr; }
      }
    `;
  }

  const CLOSE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

  function escapeAttr(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function emptyEducation() {
    return {
      school: "",
      accreditation: "",
      discipline: "",
      gpa: "",
      startDate: "",
      endDate: "",
      current: false,
    };
  }

  function emptyExperience() {
    return {
      company: "",
      title: "",
      location: "",
      startDate: "",
      endDate: "",
      current: false,
      summary: "",
      bullets: [""],
    };
  }

  function formatExperienceBlob(list) {
    return (list || [])
      .map((e) => {
        const role = [e.title, e.company].filter(Boolean).join(" at ");
        const loc = e.location ? ` (${e.location})` : "";
        const dates = e.current
          ? `${e.startDate || ""} – Present`
          : [e.startDate, e.endDate].filter(Boolean).join(" – ");
        const bullets = (e.bullets || [])
          .map((b) => String(b || "").trim())
          .filter(Boolean)
          .map((b) => `• ${b}`)
          .join("\n");
        return [role + loc, dates, e.summary, bullets].filter(Boolean).join("\n");
      })
      .filter(Boolean)
      .join("\n\n");
  }

  function formatEducationBlob(list) {
    return (list || [])
      .map((e) => {
        const head = [e.school, e.accreditation, e.discipline]
          .filter(Boolean)
          .join(" — ");
        const dates = e.current
          ? `${e.startDate || ""} – Present`
          : [e.startDate, e.endDate].filter(Boolean).join(" – ");
        const gpa = e.gpa ? `GPA: ${e.gpa}` : "";
        return [head, dates, gpa].filter(Boolean).join("\n");
      })
      .filter(Boolean)
      .join("\n\n");
  }

  function normalizeEducations(profile) {
    if (Array.isArray(profile.educations) && profile.educations.length) {
      return profile.educations.map((e) => ({
        ...emptyEducation(),
        ...e,
        current: !!e.current,
      }));
    }
    return [emptyEducation()];
  }

  function normalizeExperiences(profile) {
    if (Array.isArray(profile.experiences) && profile.experiences.length) {
      return profile.experiences.map((e) => ({
        ...emptyExperience(),
        ...e,
        current: !!e.current,
        bullets:
          Array.isArray(e.bullets) && e.bullets.length ? e.bullets : [""],
      }));
    }
    if (profile.experience && String(profile.experience).trim()) {
      const seeded = emptyExperience();
      seeded.summary = String(profile.experience).trim();
      return [seeded];
    }
    return [emptyExperience()];
  }

  function field(name, label, opts = {}) {
    const req = opts.required
      ? `<span class="req">*</span>`
      : "";
    const type = opts.type || "text";
    const ph = opts.placeholder ? ` placeholder="${opts.placeholder}"` : "";
    const full = opts.full ? " grid__full" : "";
    return `<label class="field${full}">${req}${label}<input name="${name}" type="${type}"${ph} /></label>`;
  }

  function selectField(name, label, options, opts = {}) {
    const full = opts.full ? " grid__full" : "";
    const optsHtml = options
      .map(
        ([value, text]) =>
          `<option value="${value}">${text.replace(/</g, "&lt;")}</option>`
      )
      .join("");
    return `<label class="field${full}">${label}<select name="${name}">${optsHtml}</select></label>`;
  }

  // Native <input type="month"> year spinner is broken/unusable in Shadow DOM.
  // Month + Year <select>s stay as YYYY-MM for autofill.
  const MONTH_OPTS = [
    ["", "Month"],
    ["01", "Jan"],
    ["02", "Feb"],
    ["03", "Mar"],
    ["04", "Apr"],
    ["05", "May"],
    ["06", "Jun"],
    ["07", "Jul"],
    ["08", "Aug"],
    ["09", "Sep"],
    ["10", "Oct"],
    ["11", "Nov"],
    ["12", "Dec"],
  ];

  function yearOpts() {
    const now = new Date().getFullYear();
    const out = [["", "Year"]];
    for (let y = now + 1; y >= 1970; y--) out.push([String(y), String(y)]);
    return out;
  }

  function splitMonthYear(raw) {
    const m = String(raw || "").match(/^(\d{4})-(\d{2})$/);
    return m ? { year: m[1], month: m[2] } : { year: "", month: "" };
  }

  function optionsHtml(options, selected) {
    return options
      .map(([value, text]) => {
        const sel = value === selected ? " selected" : "";
        return `<option value="${value}"${sel}>${text}</option>`;
      })
      .join("");
  }

  function monthYearControls(prefix, raw, disabled) {
    const { year, month } = splitMonthYear(raw);
    const dis = disabled ? " disabled" : "";
    return `
      <div class="month-year" data-my="${prefix}">
        <select data-f="${prefix}Month"${dis} aria-label="Month">${optionsHtml(MONTH_OPTS, month)}</select>
        <select data-f="${prefix}Year"${dis} aria-label="Year">${optionsHtml(yearOpts(), year)}</select>
      </div>`;
  }

  function readMonthYearFromCard(card, prefix) {
    const y = card.querySelector(`[data-f="${prefix}Year"]`)?.value || "";
    const m = card.querySelector(`[data-f="${prefix}Month"]`)?.value || "";
    if (!y || !m) return "";
    return `${y}-${m}`;
  }

  function setEndDateDisabled(card, disabled) {
    for (const f of ["endMonth", "endYear"]) {
      const el = card.querySelector(`[data-f="${f}"]`);
      if (!el) continue;
      el.disabled = disabled;
      if (disabled) el.value = "";
    }
  }

  function educationCardHtml(edu, index, total) {
    const remove =
      total > 1
        ? `<button type="button" class="entry__remove" data-action="remove-education" data-index="${index}">Remove</button>`
        : "";
    return `
      <div class="entry" data-edu-index="${index}">
        <div class="entry__head">
          <h3 class="entry__title">Education ${index + 1}</h3>
          ${remove}
        </div>
        <div class="grid">
          <label class="field grid__full"><span class="req">*</span>School Name
            <input data-f="school" type="text" value="${escapeAttr(edu.school)}" placeholder="School or university" />
          </label>
          <label class="field"><span class="req">*</span>Accreditation
            <input data-f="accreditation" type="text" value="${escapeAttr(edu.accreditation)}" placeholder="B.Tech, B.S., M.S.…" />
          </label>
          <label class="field">Discipline / Major
            <input data-f="discipline" type="text" value="${escapeAttr(edu.discipline)}" placeholder="Computer Science, Math…" />
          </label>
          <label class="field">GPA
            <input data-f="gpa" type="text" value="${escapeAttr(edu.gpa)}" placeholder="3.8 / 4.0" />
          </label>
          <div class="field">
            <span>Start Date</span>
            ${monthYearControls("start", edu.startDate, false)}
          </div>
          <div class="field">
            <span>End Date</span>
            ${monthYearControls("end", edu.endDate, !!edu.current)}
            <label class="date-check">
              <input data-f="current" type="checkbox"${edu.current ? " checked" : ""} />
              <span>I currently study here</span>
            </label>
          </div>
        </div>
      </div>`;
  }

  function experienceCardHtml(exp, index, total) {
    const remove =
      total > 1
        ? `<button type="button" class="entry__remove" data-action="remove-experience" data-index="${index}">Remove</button>`
        : "";
    const bullets = (exp.bullets && exp.bullets.length ? exp.bullets : [""])
      .map(
        (b, bi) => `
        <div class="bullet" data-bullet-index="${bi}">
          <textarea data-f="bullet" rows="2" placeholder="Impact, ownership, tech…">${escapeAttr(b)}</textarea>
          ${
            (exp.bullets || []).length > 1
              ? `<button type="button" class="bullet__remove" data-action="remove-bullet" data-exp="${index}" data-bullet="${bi}" aria-label="Remove bullet">×</button>`
              : ""
          }
        </div>`
      )
      .join("");
    return `
      <div class="entry" data-exp-index="${index}">
        <div class="entry__head">
          <h3 class="entry__title">Work Experience ${index + 1}</h3>
          ${remove}
        </div>
        <div class="grid">
          <label class="field grid__full"><span class="req">*</span>Company
            <input data-f="company" type="text" value="${escapeAttr(exp.company)}" placeholder="Company name" />
          </label>
          <label class="field grid__full"><span class="req">*</span>Job Title
            <input data-f="title" type="text" value="${escapeAttr(exp.title)}" placeholder="Role title" />
          </label>
          <label class="field grid__full">Location
            <input data-f="location" type="text" value="${escapeAttr(exp.location)}" placeholder="City, Country or Remote" />
          </label>
          <div class="field">
            <span>Start Date</span>
            ${monthYearControls("start", exp.startDate, false)}
          </div>
          <div class="field">
            <span>End Date</span>
            ${monthYearControls("end", exp.endDate, !!exp.current)}
            <label class="date-check">
              <input data-f="current" type="checkbox"${exp.current ? " checked" : ""} />
              <span>I currently work here</span>
            </label>
          </div>
          <label class="field grid__full">Experience Summary
            <textarea data-f="summary" rows="3" placeholder="Experience Summary">${escapeAttr(exp.summary)}</textarea>
          </label>
          <div class="grid__full">
            <div class="field" style="margin-bottom:6px">Job Description</div>
            <div class="bullets" data-el="bullets">${bullets}</div>
            <button type="button" class="add-btn" data-action="add-bullet" data-exp="${index}">+ Add Bullet Point</button>
          </div>
        </div>
      </div>`;
  }

  function readEducationsFromDom() {
    const wrap = root.querySelector('[data-el="educations"]');
    if (!wrap) return [emptyEducation()];
    const cards = [...wrap.querySelectorAll("[data-edu-index]")];
    if (!cards.length) return [emptyEducation()];
    return cards.map((card) => ({
      school: card.querySelector('[data-f="school"]')?.value.trim() || "",
      accreditation:
        card.querySelector('[data-f="accreditation"]')?.value.trim() || "",
      discipline: card.querySelector('[data-f="discipline"]')?.value.trim() || "",
      gpa: card.querySelector('[data-f="gpa"]')?.value.trim() || "",
      startDate: readMonthYearFromCard(card, "start"),
      endDate: readMonthYearFromCard(card, "end"),
      current: !!card.querySelector('[data-f="current"]')?.checked,
    }));
  }

  function readExperiencesFromDom() {
    const wrap = root.querySelector('[data-el="experiences"]');
    if (!wrap) return [emptyExperience()];
    const cards = [...wrap.querySelectorAll("[data-exp-index]")];
    if (!cards.length) return [emptyExperience()];
    return cards.map((card) => {
      const bullets = [...card.querySelectorAll('[data-f="bullet"]')].map(
        (el) => el.value
      );
      return {
        company: card.querySelector('[data-f="company"]')?.value.trim() || "",
        title: card.querySelector('[data-f="title"]')?.value.trim() || "",
        location: card.querySelector('[data-f="location"]')?.value.trim() || "",
        startDate: readMonthYearFromCard(card, "start"),
        endDate: readMonthYearFromCard(card, "end"),
        current: !!card.querySelector('[data-f="current"]')?.checked,
        summary: card.querySelector('[data-f="summary"]')?.value.trim() || "",
        bullets: bullets.length ? bullets : [""],
      };
    });
  }

  function renderEducations(list) {
    const wrap = root.querySelector('[data-el="educations"]');
    if (!wrap) return;
    const items = list && list.length ? list : [emptyEducation()];
    wrap.innerHTML = items
      .map((edu, i) => educationCardHtml(edu, i, items.length))
      .join("");
  }

  function renderExperiences(list) {
    const wrap = root.querySelector('[data-el="experiences"]');
    if (!wrap) return;
    const items = list && list.length ? list : [emptyExperience()];
    wrap.innerHTML = items
      .map((exp, i) => experienceCardHtml(exp, i, items.length))
      .join("");
  }

  function ensure() {
    if (root) return root;
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();
    host = document.createElement("div");
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>${css()}</style>
      <div class="overlay" data-el="overlay" hidden>
        <div class="backdrop" data-action="close"></div>
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="tvarin-profile-title">
          <div class="dialog__head">
            <h2 class="dialog__title" id="tvarin-profile-title">Your autofill information</h2>
            <button class="x" type="button" data-action="close" aria-label="Close">${CLOSE_SVG}</button>
          </div>
          <div class="banner">
            Your autofill information is stored locally on this device. It updates when you
            <strong>save changes here</strong> or <strong>replace your resume</strong> in the sidebar.
          </div>
          <div class="main">
            <nav class="nav" data-el="nav">
              <button type="button" data-section="personal" class="is-active">Personal</button>
              <button type="button" data-section="education">Education</button>
              <button type="button" data-section="work">Work Experience</button>
              <button type="button" data-section="address">Address</button>
              <button type="button" data-section="links">Links</button>
              <button type="button" data-section="preferences">Preferences</button>
              <button type="button" data-section="demographics">Demographics</button>
              <button type="button" data-section="ai">AI answers</button>
            </nav>
            <div class="content">
              <form data-el="form">
                <div class="panels">
                  <div class="panel" data-panel="personal">
                    <div class="grid">
                      ${field("firstName", "First name", { required: true })}
                      ${field("lastName", "Last name", { required: true })}
                      ${field("middleName", "Middle name")}
                      ${field("preferredName", "Preferred name", { placeholder: "What you like to be called" })}
                      ${field("pronouns", "Pronouns", { placeholder: "she/her", full: true })}
                      ${field("email", "Email address", { type: "email", required: true, full: true })}
                      ${field("phoneCountryCode", "Country code", { placeholder: "+91" })}
                      ${field("phone", "Phone", { type: "tel", placeholder: "9405824003" })}
                      ${field("dateOfBirth", "Date of birth", { type: "date", full: true })}
                    </div>
                  </div>
                  <div class="panel" data-panel="education" hidden>
                    <div data-el="educations"></div>
                    <button type="button" class="add-btn add-btn--block" data-action="add-education">+ Add Education</button>
                  </div>
                  <div class="panel" data-panel="work" hidden>
                    <div data-el="experiences"></div>
                    <button type="button" class="add-btn add-btn--block" data-action="add-experience">+ Add Work Experience</button>
                    <div class="skills-block">
                      <p class="note">Summary, projects, and skills still help AI drafts and generic text fields.</p>
                      <div class="grid">
                        <label class="field grid__full">
                          About / summary
                          <textarea name="about" rows="3" placeholder="Short professional summary…"></textarea>
                        </label>
                        <label class="field grid__full">
                          Personal / side projects
                          <textarea name="projects" rows="4" placeholder="Project name, what it does, tech stack, outcomes, links…"></textarea>
                        </label>
                        <label class="field grid__full">
                          Skills
                          <textarea name="skills" rows="3" placeholder="Languages, frameworks, tools…"></textarea>
                        </label>
                      </div>
                    </div>
                  </div>
                  <div class="panel" data-panel="address" hidden>
                    <div class="grid">
                      ${field("currentLocation", "Current location", { placeholder: "e.g. Bengaluru, India", full: true })}
                      ${field("addressLine1", "Street address", { full: true })}
                      ${field("city", "City")}
                      ${field("state", "State / Province")}
                      ${field("postalCode", "Postal code")}
                      ${field("country", "Country")}
                    </div>
                  </div>
                  <div class="panel" data-panel="links" hidden>
                    <div class="grid">
                      ${field("linkedin", "LinkedIn", { type: "url", placeholder: "https://linkedin.com/in/…", full: true })}
                      ${field("github", "GitHub", { type: "url", placeholder: "https://github.com/…", full: true })}
                      ${field("portfolio", "Portfolio / website", { type: "url", placeholder: "https://…", full: true })}
                    </div>
                  </div>
                  <div class="panel" data-panel="preferences" hidden>
                    <p class="note">
                      These answers show up on almost every serious application, with different wording.
                      Fill them once — Tvarin maps them by intent (work auth, visa, relocate, etc.).
                    </p>
                    <div class="section-title">Work eligibility</div>
                    <div class="grid">
                      ${selectField("workAuthorized", "Authorized to work in the job’s country?", YES_NO, { full: true })}
                      ${selectField("needsSponsorship", "Will you need visa / immigration sponsorship now or in the future?", YES_NO, { full: true })}
                      ${selectField("isOfLegalWorkingAge", "Are you at least 18 years old?", YES_NO, { full: true })}
                      ${selectField("willingToRelocate", "Willing to relocate for a role?", YES_NO_DECLINE, { full: true })}
                    </div>
                    <div class="section-title">Background &amp; conflicts</div>
                    <div class="grid">
                      ${selectField("hasNonCompete", "Subject to a non-compete or non-solicitation?", YES_NO, { full: true })}
                      ${selectField("isGovernmentEmployee", "Current or former government employee?", YES_NO, { full: true })}
                      ${selectField("relatedToCompany", "Related to an employee of the company (or a conflict of interest)?", YES_NO, { full: true })}
                      ${selectField("hasCriminalRecord", "Convictions or pending criminal charges?", YES_NO_DECLINE, { full: true })}
                    </div>
                    <div class="section-title">Compensation &amp; availability</div>
                    <div class="note note--warn">
                      These drift over time. Tvarin fills them, but double-check they’re current before you submit.
                    </div>
                    <div class="grid">
                      ${field("noticePeriod", "Notice period", { placeholder: "e.g. 2 months / Immediate", full: true })}
                      ${field("currentCTC", "Current CTC / salary", { placeholder: "e.g. ₹18,00,000 / $120,000", full: true })}
                    </div>
                  </div>
                  <div class="panel" data-panel="demographics" hidden>
                    <p class="note">
                      Voluntary self-identification (EEO). Stored only on this device. You can choose
                      “Prefer not to say” / “I do not want to answer” for any field.
                    </p>
                    <div class="grid">
                      ${selectField("gender", "Gender", GENDER_OPTS)}
                      ${selectField("ethnicity", "Race / ethnicity", ETHNICITY_OPTS)}
                      ${selectField("veteranStatus", "Veteran status", VETERAN_OPTS, { full: true })}
                      ${selectField("sexualOrientation", "Sexual orientation", ORIENTATION_OPTS, { full: true })}
                      ${selectField("disabilityStatus", "Disability status", DISABILITY_OPTS, { full: true })}
                    </div>
                    <label class="check">
                      <input name="autoDeclineEEO" type="checkbox" />
                      <span>If a demographic answer is not set, auto-answer as “Decline to self-identify.” Off by default.</span>
                    </label>
                  </div>
                  <div class="panel" data-panel="ai" hidden>
                    <p class="note">
                      Paste your full resume text here (in addition to Experience). Google sign-in for the free draft quota lives in the full settings page.
                    </p>
                    <label class="field grid__full">
                      Resume / about you (text)
                      <textarea name="aiResumeText" rows="8" placeholder="Paste your resume text or a short summary…"></textarea>
                    </label>
                    <p class="note" style="margin-top:12px">
                      <button type="button" class="linkish" data-action="open-options">Open AI sign-in settings</button>
                    </p>
                  </div>
                </div>
                <div class="foot">
                  <button class="save" type="submit">Update</button>
                  <span class="saved" data-el="saved" aria-live="polite"></span>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    `;

    const overlay = root.querySelector('[data-el="overlay"]');
    overlay.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      if (action === "close") close();
      if (action === "open-options") {
        chrome.runtime.sendMessage({ type: "TVARIN_OPEN_OPTIONS" });
      }
    });

    root.querySelector('[data-el="nav"]').addEventListener("click", (e) => {
      const btn = e.target.closest("[data-section]");
      if (!btn) return;
      setSection(btn.getAttribute("data-section"));
    });

    root.querySelector('[data-el="form"]').addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");

      if (action === "add-education") {
        const list = readEducationsFromDom();
        list.push(emptyEducation());
        renderEducations(list);
        return;
      }
      if (action === "remove-education") {
        const list = readEducationsFromDom();
        const i = Number(btn.getAttribute("data-index"));
        if (list.length <= 1) return;
        list.splice(i, 1);
        renderEducations(list);
        return;
      }
      if (action === "add-experience") {
        const list = readExperiencesFromDom();
        list.push(emptyExperience());
        renderExperiences(list);
        return;
      }
      if (action === "remove-experience") {
        const list = readExperiencesFromDom();
        const i = Number(btn.getAttribute("data-index"));
        if (list.length <= 1) return;
        list.splice(i, 1);
        renderExperiences(list);
        return;
      }
      if (action === "add-bullet") {
        const list = readExperiencesFromDom();
        const i = Number(btn.getAttribute("data-exp"));
        if (!list[i]) return;
        list[i].bullets = list[i].bullets || [""];
        list[i].bullets.push("");
        renderExperiences(list);
        return;
      }
      if (action === "remove-bullet") {
        const list = readExperiencesFromDom();
        const i = Number(btn.getAttribute("data-exp"));
        const bi = Number(btn.getAttribute("data-bullet"));
        if (!list[i]?.bullets || list[i].bullets.length <= 1) return;
        list[i].bullets.splice(bi, 1);
        renderExperiences(list);
      }
    });

    root.querySelector('[data-el="form"]').addEventListener("change", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (t.getAttribute("data-f") !== "current") return;
      const card = t.closest("[data-edu-index], [data-exp-index]");
      if (!card) return;
      setEndDateDisabled(card, t.checked);
    });

    root.querySelector('[data-el="form"]').addEventListener("submit", async (e) => {
      e.preventDefault();
      await save();
    });

    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && isOpen()) close();
      },
      true
    );

    return root;
  }

  function isOpen() {
    const overlay = root && root.querySelector('[data-el="overlay"]');
    return !!(overlay && !overlay.hidden);
  }

  function setSection(name) {
    activeSection = name;
    ensure();
    root.querySelectorAll("[data-section]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-section") === name);
    });
    root.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.hidden = panel.getAttribute("data-panel") !== name;
    });
  }

  async function load() {
    ensure();
    const data = await get([KEYS.profile, KEYS.settings, KEYS.ai]);
    const profile = data[KEYS.profile] || {};
    const settings = data[KEYS.settings] || {};
    const ai = data[KEYS.ai] || {};
    const form = root.querySelector('[data-el="form"]');

    PROFILE_FIELDS.forEach((name) => {
      if (form.elements[name]) form.elements[name].value = profile[name] || "";
    });
    renderEducations(normalizeEducations(profile));
    renderExperiences(normalizeExperiences(profile));
    if (form.elements.autoDeclineEEO) {
      form.elements.autoDeclineEEO.checked = !!settings.autoDeclineEEO;
    }
    if (form.elements.aiResumeText) {
      form.elements.aiResumeText.value = ai.resumeText || "";
    }
    root.querySelector('[data-el="saved"]').textContent = "";
  }

  async function save() {
    ensure();
    const form = root.querySelector('[data-el="form"]');
    const saveBtn = form.querySelector(".save");
    const saved = root.querySelector('[data-el="saved"]');
    saveBtn.disabled = true;
    saved.textContent = "";

    const profile = {};
    PROFILE_FIELDS.forEach((name) => {
      const el = form.elements[name];
      if (el && el.value.trim()) profile[name] = el.value.trim();
    });

    const educations = readEducationsFromDom().filter(
      (e) =>
        e.school ||
        e.accreditation ||
        e.discipline ||
        e.gpa ||
        e.startDate ||
        e.endDate
    );
    const experiences = readExperiencesFromDom()
      .map((e) => ({
        ...e,
        bullets: (e.bullets || []).map((b) => b.trim()).filter(Boolean),
      }))
      .filter(
        (e) =>
          e.company ||
          e.title ||
          e.location ||
          e.summary ||
          e.startDate ||
          (e.bullets && e.bullets.length)
      );

    if (educations.length) profile.educations = educations;
    if (experiences.length) {
      profile.experiences = experiences;
      const blob = formatExperienceBlob(experiences);
      if (blob) profile.experience = blob;
    }
    const eduBlob = formatEducationBlob(educations);
    if (eduBlob) profile.education = eduBlob;

    const settings = {
      autoDeclineEEO: !!(form.elements.autoDeclineEEO && form.elements.autoDeclineEEO.checked),
    };
    const ai = {
      resumeText: form.elements.aiResumeText
        ? form.elements.aiResumeText.value.trim()
        : "",
    };

    try {
      await set({
        [KEYS.profile]: profile,
        [KEYS.settings]: settings,
        [KEYS.ai]: ai,
      });
      saved.textContent = "Saved";
      setTimeout(() => {
        if (saved.textContent === "Saved") saved.textContent = "";
      }, 2000);
    } catch (_) {
      saved.textContent = "Save failed";
      saved.style.color = "#b91c1c";
    } finally {
      saveBtn.disabled = false;
      saved.style.color = "";
    }
  }

  async function open() {
    ensure();
    await load();
    setSection(activeSection || "personal");
    root.querySelector('[data-el="overlay"]').hidden = false;
    document.documentElement.style.overflow = "hidden";
  }

  function close() {
    if (!root) return;
    root.querySelector('[data-el="overlay"]').hidden = true;
    document.documentElement.style.overflow = "";
  }

  globalThis.TvarinProfileModal = { open, close, isOpen };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "TVARIN_OPEN_PROFILE_MODAL") {
      open().then(() => sendResponse({ ok: true }));
      return true;
    }
  });
})();

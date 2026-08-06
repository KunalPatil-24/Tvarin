# Google Forms adapter — implementation plan

Status: **Phase 1 shipped** (text fields + gate + logging + auto-open) · Phases 2–3 pending.
Target: `src/content/content.js` (new adapter + router + gate), minor `src/sidebar/sidebar.js` copy.

## Phase 1 — shipped

Landed in `src/content/content.js`:

- `isGoogleFormsHost()`, `googleFormTitle()`, `googleFormListitemLabel()`,
  `googleFormQuestionLabels()`, `scrapeGoogleFormMeta()`, `computeIsJobGoogleForm()` +
  per-URL-memoized `isJobGoogleForm()` — the two-signal gate.
- `googleFormsAdapter` (name `googleForms`) — runs the generic text/paragraph pass and
  attaches `{ company, jobTitle }` metadata.
- `pickAdapter()` routes job Google Forms to it; `isJobApplicationPage()` returns true for
  them, which drives **auto-open** of the sidebar (decision below).
- `fillPage()` now prefers `result.meta` over the `bestEffort*` page scrape when an adapter
  supplies it, so the activity log shows the form title / company instead of
  `docs.google.com`.
- `countUnmappedGoogleFormQuestions()` — the adapter pushes a warning
  ("couldn't place N questions — review before you submit") through the existing fill toast
  when a short-answer question maps to no profile field, so an unusually-worded question
  (e.g. "What should we call you?") is a **visible** miss, not a silent one. Paragraph/essay
  and choice widgets are excluded to avoid noise. (Deferred: the alias vocabulary — Tier A —
  and semantic mapping — Phase 3/Tier B.)
- Fixture: `test/sample-google-form.html` (ARIA-accurate: `role="listitem"`,
  `aria-labelledby`, `role="radio/checkbox/listbox"`).

Verified against real DOM parsing of the fixture: gate rejects RSVP/survey/event-registration
forms and accepts job forms (incl. an untitled form with a name+email+LinkedIn cluster); text
fields map to `fullName/email/phone/linkedin/portfolio`; paragraph + choice widgets are left
untouched (Phases 2–3).

**Still to validate on a live form:** that the form title is the first `[role="heading"]` and
question titles are `[role="heading"]` inside each `[role="listitem"]` — the fixture follows the
documented structure, but Google's live markup should be spot-checked before Phase 2.

## Goal

Make Tvarin fill job-application **Google Forms** (`docs.google.com/forms/...` and published
`/viewform` pages), gated so it does **not** fire on the millions of non-job Google Forms
(RSVPs, surveys, feedback). Reuse the existing profile, filler, combobox, and logging plumbing;
add a dedicated `googleFormsAdapter` rather than leaning on `genericAdapter`.

## What already works (do not rebuild)

- **Injection.** Content script matches `https://*/*` (`manifest.json:21`), so it already runs on
  `docs.google.com`. No manifest change needed for activation.
- **Label extraction.** `getFieldContext()` (`content.js:222`) already reads `aria-labelledby`,
  which is exactly how Google Forms ties a question's text to its `<input>`. So **short-answer and
  paragraph text questions map to profile keys today** through `classifyFields()` → `MATCH_RULES`.
- **Combobox machinery.** `role="listbox"` / `role="option"` open-and-click flow already exists for
  Workday/Greenhouse react-select (`content.js:1003`, `1059`, `2453`). Google Forms dropdowns are the
  same shape and can reuse it with a Forms-specific opener.

## What breaks on Google Forms (the actual work)

| # | Gap | Root cause | Fix location |
|---|-----|-----------|--------------|
| 1 | Multiple-choice & checkbox questions never fill | `FILLABLE_SELECTOR` excludes `radio`/`checkbox`, and Forms renders them as `role="radio"`/`role="checkbox"` **divs**, not native inputs (`content.js:549`) | new `fillGoogleFormChoice()` |
| 2 | Dropdown questions never fill | Forms dropdown is a `role="listbox"` div, not `<select>`; not opened by the current generic pass | new opener in adapter, reuse option-click |
| 3 | Page never recognized as a job app | `pickAdapter()` / `isJobApplicationPage()` don't know `docs.google.com/forms` (`content.js:5244`, `5282`) | router + gate |
| 4 | Logging collapses | `bestEffortCompany()` returns `docs` for every form; no company/role (`content.js:5390`) | Forms-specific title scrape |
| 5 | Over-triggering | Edge tab + auto-open key entirely on `isJobApplicationPage()` (`sidebar.js:1484`, `1516`) — every Google Form would light up | detection gate (see below) |

## Google Forms DOM reference

Confirmed structure for filling logic (verify against a live form during build):

- Each question is a `div[role="listitem"]`. The question text lives in a heading node whose id the
  input references via `aria-labelledby`.
- **Short answer:** `input[type="text"][aria-labelledby="…"]` inside the listitem.
- **Paragraph:** `textarea[aria-labelledby="…"]`.
- **Multiple choice (radio):** `div[role="radiogroup"]` containing `div[role="radio"][aria-label="…"][data-value="…"]`.
  Select by `.click()` on the matching radio div; `aria-checked` flips to `true`.
- **Checkboxes:** `div[role="list"]` of `div[role="checkbox"][aria-label="…"]`.
- **Dropdown:** `div[role="listbox"]` (collapsed shows selection); click to expand, then
  `div[role="option"][data-value="…"]`. First option is the "Choose" placeholder — skip it.
- **Linear scale / grid / date / time:** out of scope for v1 (see Non-goals).
- Required questions carry an asterisk; not needed for fill but useful for the gate signal.

Key trait: **question text is free-form natural language** ("What should we call you?", "Where are
you based?"), so key matching is fuzzier and more false-positive-prone than ATS id/name matching.

## Detection gate (prevents over-triggering)

A single predicate, `isJobGoogleForm()`, used by both the router and the page gate. Treat a Google
Form as a job application only when **at least two** of these hold:

1. Host is `docs.google.com` **and** path contains `/forms/`.
2. Form title / description (`<meta property="og:title">`, first `[role="heading"]`, or `document.title`
   minus " - Google Forms") matches `/appl(y|ication)|position|role|candidate|hiring|resume|cv|cover letter/i`.
3. The set of question labels contains a job-shaped cluster — e.g. **email + (full name | first/last)
   + at least one of** `linkedin|resume|cv|portfolio|years of experience|notice period|salary|work authorization`.

Rationale: title alone is unreliable (recruiters name forms "Untitled form"); field-cluster is the
strong signal. Requiring two signals keeps surveys/RSVPs out. Expose a manual override — the sidebar
edge tab should still be openable so a user can force-fill a form the gate missed (see UX below).

## Architecture

```
pickAdapter()
  ├─ greenhouse / lever / workday / icims  (unchanged)
  ├─ isJobGoogleForm()  → googleFormsAdapter   ← new
  └─ generic

googleFormsAdapter.fill(profile, settings)
  ├─ scrapeGoogleFormMeta()           → {company, jobTitle} for logging
  ├─ classifyFields() + runAdapter()  → text/paragraph inputs (reuses existing path)
  ├─ fillGoogleFormChoice(profile)    → role=radio / role=checkbox divs   ← new
  └─ fillGoogleFormDropdowns(profile) → role=listbox open + option click  ← new (reuses option-click)
```

`googleFormsAdapter` mirrors the `greenhouseAdapter` shape (`content.js:1964`): async `fill()`
returning `{ filled, warnings }`, so `fillPage()` (`content.js:5613`) needs no change — it already
calls `pickAdapter().fill()` and logs via `bestEffort*`. Only override company/title through the
`meta` path so logs are meaningful.

## Changes, file by file

### `src/content/content.js`

1. **`isJobGoogleForm()`** — new predicate implementing the gate above. Place near `pickAdapter()`.
2. **`pickAdapter()`** (`5244`) — add `if (isJobGoogleForm()) return googleFormsAdapter;` before the
   generic fallback.
3. **`isJobApplicationPage()`** (`5282`) — add `if (isJobGoogleForm()) return true;` near the top so
   the sidebar edge tab + auto-open respect the gate (this drives `sidebar.js` via `TvarinAPI.isJobPage`).
4. **`scrapeGoogleFormMeta()`** — new; returns `{ company, jobTitle }` from the form heading/description.
   Wire into logging: extend `fillPage()` (`5638`) to prefer adapter-provided meta over `bestEffort*`
   when `adapter.name === "googleForms"` (either return meta from `fill()` or read a module-scoped var).
5. **`fillGoogleFormChoice(profile)`** — new; iterate `div[role="listitem"]`, read label via the
   heading node, resolve profile value (`resolveValue`), match against `role="radio"`/`role="checkbox"`
   `aria-label`/`data-value`, `.click()` the winner. Reuse yes/no logic pattern from
   `content.js:3580`. Return count.
6. **`fillGoogleFormDropdowns(profile)`** — new; for each `role="listbox"`, derive the question label,
   click to expand, wait for options (reuse the `waitFor…` pattern), click the `role="option"` whose
   text matches `resolveValue`, skipping the placeholder option.
7. **`googleFormsAdapter`** object — assembles the above; returns `{ filled, warnings, meta }`.

### `src/sidebar/sidebar.js`

- No logic change required — auto-open/edge tab already delegate to `TvarinAPI.isJobPage`
  (`sidebar.js:1484`). Optional: a small "Not a job form? Close" affordance so a false-positive
  auto-open is dismissible, and confirm the manual-open path works when the gate says false.

### `manifest.json`

- No change. (Host permission already covers `docs.google.com`.)

## Field-mapping strategy

- **Text / paragraph:** existing `MATCH_RULES` (`content.js:256`). Add a few Forms-flavored aliases
  where phrasing differs from ATS labels (e.g. `/what should we call you/`, `/where are you based/ →
  location`, `/tell us about/` left unmatched deliberately to avoid dumping into essay questions).
- **Choice/dropdown enumerations:** match `resolveValue` against option `aria-label`/text with the
  existing normalize/alias helpers (accent fold, starts-with preference) used by Workday selects.
- **Fuzzy leftovers (Phase 3):** questions that don't regex-match are candidates for the backend
  `match`/`draft` functions (`backend/supabase/functions/`) — semantic question→field mapping and
  drafted long answers. Keep this behind the existing AI-enabled setting.

## Phased delivery

- **Phase 1 — text fields + gate + logging.** Items 1–4, 7 (text only). Highest value, ~80% already
  works via generic path once routing + meta land. Ship and dogfood.
- **Phase 2 — choice widgets.** `fillGoogleFormChoice` + `fillGoogleFormDropdowns` (items 5, 6).
- **Phase 3 — semantic matching for essay/fuzzy questions** via backend, behind AI setting.

## Edge cases & risks

- **Multi-page (section) forms.** Google Forms can paginate with "Next". v1 fills the visible page
  only; do **not** auto-click Next (mirrors the never-auto-submit rule). Note it in the toast.
- **Never submit.** Do not click the form's Submit — same policy as ATS (`stopReason: "review"`).
- **File upload questions.** Require the user to be signed into Google and use a Drive picker in an
  iframe — out of scope; skip, don't attempt resume attach here.
- **Randomized/duplicated `aria-label`s** across options — match on `data-value` first, text second.
- **False positives** from the gate — two-signal requirement + dismissible auto-open + manual override.
- **DOM churn.** Google ships obfuscated class names that change; the plan deliberately keys on
  stable ARIA roles/attributes, not classes.

## Non-goals (v1)

Linear scale, multiple-choice grid, checkbox grid, date, time, file upload, and multi-page
auto-advance. Log a warning for unfilled question types so we can prioritize later.

## Testing

- Add `test/sample-google-form.html` fixtures mirroring the ARIA structure above (text, radio,
  checkbox, dropdown) alongside the existing `test/sample-form.html`.
- Manual matrix: a real job Google Form (fill correctness), a survey/RSVP form (gate must **not**
  fire), a multi-page form (fills page 1, no auto-next), a form with an unmatched essay question
  (left blank, warned).

## Open questions

1. ~~Auto-open on job Google Forms, or edge-tab only?~~ **Resolved: auto-open** (matches ATS
   behavior; false-positive risk is held down by the two-signal gate).
2. Should Phase 3 semantic matching be on by default for Forms, or opt-in per fill?

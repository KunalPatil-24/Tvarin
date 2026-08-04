# Tvarin — Product Spec

*A Chrome extension that makes applying to jobs fast, and gets smarter the more you use it.*

**Name:** Tvarin — from Sanskrit त्वरा (*tvara*), "speed"; "the swift one." Domain: tvarin.com (available as of naming). Tagline direction: *"Apply in seconds."*

Last updated: 2026-08-03

---

## The problem

Filling out job applications is slow, repetitive, and demoralizing. The same details get re-typed on every form, and every company asks slightly different open-ended questions. Job seekers burn hours on mechanical work instead of on the jobs themselves.

## The core idea

Enter your details once. On any job form, click the extension and it fills everything in seconds. On top of that, use AI to handle the parts that normally eat the most time — open-ended questions, resume tailoring, cover letters — and quietly keep a record of everything you've applied to.

## Guiding principles

- **Help the applicant first.** Every feature must make life easier for the person using the extension. Anything that only helps strangers or the business comes later.
- **Tailor, never fabricate.** AI reshapes and re-emphasizes the user's *real* experience. It never invents jobs, skills, or credentials.
- **Human reviews before submit.** AI drafts; the person approves. Nothing is auto-submitted.
- **Privacy is a feature.** Personal data stays on the user's machine by default and only leaves for AI calls the user explicitly triggers.
- **Start narrow, layer up.** Nail one thing before adding the next. Each stage is useful on its own.

---

## Features

### 1. Autofill — *free* (the hook)
Store profile once (name, contact, address, links, work history), fill standard fields with one click.
- **Deterministic layer:** heuristic field matching (name/id/label/placeholder + synonym dictionary) plus hand-tuned templates for major ATS platforms (Workday, Greenhouse, Lever, iCIMS).
- **AI fallback:** when heuristics can't match a field, ask the model which profile field it is. Powerful, but never the default path.
- Must be **rock-solid** — this is the reason anyone installs it.

### 2. AI short-answer drafting — *free or premium*
Drafts answers to open-ended questions ("Why this company?") grounded strictly in the user's profile. Same engine that grows into resume tailoring.

### 3. Resume tailoring + cover letter — *premium*
On the job posting, tailor the resume and generate a cover letter against that exact role.
- Edge: the extension is already *on* the posting — no copy-paste of the job description.
- Highest willingness-to-pay moment; genuinely costs money to run (AI calls) — cost and value line up, so this is where the paywall belongs.
- **Hard part:** formatting. Producing clean, ATS-parseable output that matches the user's layout is harder than generating the text. Decide early: edit existing wording vs. generate a document.

### 4. Application tracking + analytics — *free*
The log of jobs the user **submits**, turned around and shown back as something useful.
- **Applied is recorded only on Submit** (not on Fill). Fill may log a local `started` row for in-progress context; Submit promotes it to `applied`.
- Application history: who, when, which role — foundation for the job tracker (tracker UI later).
- Status pipeline (applied → response → interview → offer/reject) — **manually updated** by the user; can't be fully automated in v1.
- Humble, honest insights: count applied, response rate, activity over time. Useful at small numbers, not a BI dashboard.
- Kept free on purpose: cheap to run, drives stickiness, and quietly banks the dataset (with consent).

### 5. Jobs board — *someday, not a launch goal*
The dataset of real jobs users apply to, accumulated as exhaust from normal use.
- **Do not build first, and not as a generic re-listing** — that's a worse Indeed, legally shaky, cold-start-prone, and a brutal two-sided market.
- If/when built, the value is the **signal on top of the listings** (application volume, ghost-job detection, real demand trends) — things no existing board can show because they don't sit in the browser at apply-time. Niche + enriched, or not at all.

---

## Architecture (sketch)

```
Chrome Extension (Manifest V3)
├── Popup UI ............ edit profile, trigger fill, review AI drafts
├── Options page ........ full profile + resume + API key settings
├── Content script ...... reads the page's form, fills fields, injects UI
│     └── ATS Router → picks the right adapter for the current site
├── Background worker .... makes LLM calls (MV3 service worker constraints)
└── Storage (chrome.storage.local)
      └── profile, resume text, per-site templates, application log, settings
```

### ATS router + adapters (the core design)

Each ATS is genuinely different, so there is no single generic filler that works well everywhere. Instead: detect which platform the page is on, then run logic built specifically for it.

```
Page loads → detect host → route to the matching adapter
  ├── *.myworkdayjobs.com → Workday adapter
  ├── *.greenhouse.io     → Greenhouse adapter
  ├── *.lever.co          → Lever adapter
  ├── *.icims.com         → iCIMS adapter
  └── unknown site        → Generic adapter (heuristic field matching, best-effort)
```

- **Adapter = self-contained** knowledge of one platform's fields, quirks, and multi-step flow. Adding a new ATS later = writing one new adapter, no changes to the others.
- **Always keep a Generic fallback adapter** so the extension is never useless on sites without a dedicated adapter — it does its best everywhere, and shines where specifically tuned.
- **Architecture supports many adapters; build them one at a time.** Designing for all ATSs is the goal; *implementing* all at once is the trap. Ship with one solid adapter, prove the framework end-to-end, then add the rest incrementally.
- **Build the first adapter for ease, not just frequency.** Greenhouse/Lever use fairly standard forms; Workday is notoriously hard (multi-step, custom React widgets, sometimes shadow DOM). Get the framework solid on an easy one first, so Workday becomes "just another adapter" rather than the thing that also breaks the framework.

- **Manifest V3** is mandatory for new extensions — plan AI calls around the service-worker model (no long-running background processes).
- **AI calls, v1:** bring-your-own API key (user pastes their own key, calls go direct). Zero infra/cost for a solo build. A hosted backend proxy (nicer UX, but adds auth/billing/abuse) is a later upgrade, not a v1.
- **Data location:** `chrome.storage.local` by default (private, on-device). Cross-device sync or multi-user changes this — defer it.

---

## Backend — hosted AI (Supabase)

**Decision (someday → now):** AI moves from bring-your-own-key to a **hosted service** (Simplify-style). Users sign in; Tvarin holds one AI key server-side; users get a free monthly quota. BYO-key is dropped from the product. This turns Tvarin from a client-only extension into a service with a backend.

### Stack — Supabase (chosen; developer already knows it)
Bundles the three things this needs:
- **Auth** — Google sign-in.
- **Postgres** — store the user + a monthly draft counter (nothing else).
- **Edge Function** — the proxy that holds the AI key and calls the model.

### Flow
```
Extension → (Supabase JWT) → Edge Function "/draft" → Gemini → back to extension
```
1. User signs into the extension with Google (Supabase Auth; in an extension, via `chrome.identity.launchWebAuthFlow`).
2. Extension calls the Edge Function with the user's JWT + `{ question, jobContext, profile, resumeText }`.
3. Function: verify JWT → look up the user's draft count for the month → if over the limit, return a "limit reached" response → else call **Gemini** (key held as a Supabase secret), increment the count, return the draft.

### Data model (minimal)
- Supabase Auth `users` (built in).
- `usage(user_id, month, draft_count)` — the only app table. **No resume text stored** — the resume lives in the extension (always current) and is sent fresh with each request, so results never go stale.

### Cost controls (why this is safe to run)
- **Per-user cap: 10 free drafts / month.** Over that → prompt to upgrade (paid tier, later).
- **Model: Gemini 2.5 Flash on the free tier now** (₹0, no card). Swap to 3.5 Flash / paid tier later, server-side, once there's revenue — users don't notice.
- Gemini free tier has an **app-wide daily cap** (~250/day on 2.5 Flash) — a soft ceiling that's fine at launch and signals real traction when hit.
- Only signed-in users can call the endpoint (JWT-gated), so no anonymous abuse; per-user metering bounds spend.
- If a paid AI tier is ever attached: set a **hard budget cap + alert**.

### Cost reality
Runs at **₹0** to start (Supabase free + Gemini free tier). You only pay when you outgrow the free tier — i.e. when there's enough usage to justify **paid subscriptions**, which then cover the cost. The developer should never personally fund a large free base; the paywall does.

### Honest caveats
- **Free-tier data use:** Gemini's *free* tier may use inputs/outputs (users' resume text + answers) to improve Google's models. Acceptable for MVP; the paid tier / Vertex AI stops it. Revisit at monetization.
- This is real infrastructure with ongoing upkeep — the biggest step in the project.

### Client-side changes this implies
- **Remove** the API-key entry and provider selector from Options.
- **Add** "Sign in with Google" + a small "drafts left this month" indicator.
- The extension calls the Supabase Edge Function instead of an AI provider directly; resume text stays client-side and is sent per request.

### Billing (later)
Ship free-tier-only first. Add paid plans (**Razorpay** for India) once real usage proves demand — not before.

---

## Build sequence

1. **Static autofill** on standard fields, profile stored locally. Test on 5–10 real applications. Useful on its own.
2. **Field-matching quality** — build the ATS router + Generic fallback adapter, then the first dedicated adapter (easiest ATS first). Add more adapters incrementally.
3. **Tracking** — nearly free since jobs are already being logged; makes the tool sticky.
4. **AI short answers** → grow into **resume tailoring + cover letters** (the premium tier).
5. **Someday:** the enriched, signal-rich board, once there's scale.

## Monetization

| Feature | Tier |
|---|---|
| Autofill (static + smart matching) | Free |
| AI short-answer drafting | Free or premium |
| Resume tailoring + cover letter | **Premium** |
| Application tracking + analytics | Free |

Paywall sits on the expensive-to-run AI features, where cost and user value align. Free features (autofill, tracking) drive adoption and stickiness.

---

## Open decisions before building

- **Which ATS gets the first dedicated adapter?** ~~Open~~ Greenhouse + Lever are in; **Workday** is the hard multi-step adapter (PromptSelect widgets + auto-advance, stops before Submit).
- **Resume tailoring: edit existing wording, or generate a document?** Determines the hardest technical work.
- ~~AI: bring-your-own-key vs. hosted proxy?~~ **Decided: hosted proxy on Supabase, Google sign-in, Gemini 2.5 Flash free tier, 10 free drafts/month, billing later. See "Backend — hosted AI".**

## Known risks / honest caveats

- Field matching across varied job sites is the real engineering challenge, not data storage.
- Resume/cover-letter *formatting* (ATS-parseable, clean) is harder than the text generation.
- Application statuses can't be fully auto-detected in v1 (that lives in email) — manual updates for now.
- The board is a competitive minefield; keep it a someday-goal and only ever build the enriched version.
- Solo builder + four features = sequence strictly; don't build in parallel.

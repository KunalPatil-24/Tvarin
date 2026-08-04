# Tvarin

Fill job application forms in seconds. Store your details once, apply everywhere.

*Tvarin* — from Sanskrit त्वरा (*tvara*), "speed."

This is the v0.1 skeleton: a working Manifest V3 Chrome extension with a profile
page, a **right sidebar** that auto-opens on job forms, one-click autofill, an
application log, and the **ATS router + adapter** architecture (Generic
fallback + Greenhouse, Lever, and a multi-step **Workday** adapter).

## Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (`Tvarin/`).
4. The Options page opens on first install — fill in your profile and **Save**.

> After loading (or after code changes), click the **reload** icon on the
> extension card. Pages that were already open need a refresh before Tvarin can
> fill them, because the content script is injected at page load.

## Try it

- Open `test/sample-form.html` in Chrome (drag it into a tab).
  - To fill a local `file://` page, enable **"Allow access to file URLs"** on
    the Tvarin card in `chrome://extensions`, then reload the tab. (Or serve the
    folder over http, e.g. `python3 -m http.server` and open `localhost:8000`.)
- On a detected job form, the **Tvarin sidebar slides in from the right**.
  You can also click the Tvarin toolbar icon to toggle it.
- Click **Fill this page** in the sidebar.
- You should see fields populate and a toast: *"filled N fields via Generic."*
- Then try a real Greenhouse form (e.g. a `boards.greenhouse.io/...` job) to see
  the Greenhouse adapter kick in.

## Project layout

```
manifest.json                 Extension manifest (MV3)
src/
  background/service-worker.js Opens Options on install; toolbar toggles sidebar; AI drafts
  content/
    content.js                Router + matcher + filler + adapters (the core)
    content.css               On-page toast + Draft button
  sidebar/                    Right in-page panel (auto-opens on job pages)
  options/                    Profile editor (stored in chrome.storage.local)
  shared/tokens.css           Shared light mint design tokens
  popup/                      Legacy popup files (unused; sidebar replaced it)
test/
  sample-form.html            Local form to test autofill without a live site
```

## How the fill works

1. Sidebar triggers fill on the page (and notifies iframes for embedded ATS forms).
2. `content.js` picks an **adapter** by inspecting the host (Greenhouse / Lever /
   Workday / Generic).
3. The adapter maps form fields → saved profile keys and sets values in a
   React-safe way (native setter + `input`/`change` events). Workday also drives
   its PromptSelect dropdowns and auto-advances wizard steps, stopping before
   Submit so you always review.
4. A local activity entry is added with status **started**; filling is never
   treated as submitting. When you click **Submit** on the form, Tvarin records
   the job as **applied** (promotes the started row when present). The sidebar
   counts applied jobs — that data feeds the job tracker (UI later).

## AI answers (hosted — no API key needed)

Open **Options → AI answers** → **Sign in with Google** → paste your resume text
(used to ground answers). Then on any job form, focus a long-answer box — a
**Draft** button appears. Click it and Tvarin drafts a first-person answer
from your profile + resume, grounded (it won't invent experience), inserted
**for review** — it never submits. **10 free drafts / month.**

- Sign-in uses `chrome.identity.launchWebAuthFlow` + Supabase (PKCE). The
  session is stored locally; the extension calls the Tvarin backend (a Supabase
  Edge Function) with the user's token — the AI key lives **server-side**.
- Requires the backend deployed (see [`backend/`](backend/)) and the Supabase
  URL + anon key set in `src/lib/supabase-config.js`.
- Resume text stays in the extension and is sent fresh with each request (never
  stored server-side), so results are never stale.

## Roadmap (see PRODUCT_SPEC.md)

- Tune Workday against more live tenants (phone formats, experience rows).
- More ATS adapters (iCIMS depth, Ashby, SmartRecruiters) — one at a time.
- AI answers → grow into resume tailoring + cover letters (premium tier).
- Richer application tracking (status pipeline) + analytics.

## Note

No toolbar icon art is bundled yet, so Chrome shows a default puzzle-piece icon.
Drop `icon16/32/48/128.png` in an `icons/` folder and reference them in
`manifest.json` when you have artwork.

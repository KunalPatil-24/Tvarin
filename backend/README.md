# Tvarin backend (Supabase)

The hosted AI layer: users sign in with Google, and this backend holds the
AI key, meters usage (10 free drafts/user/month), and returns drafts.
The extension calls the `draft` Edge Function instead of an AI provider directly.

**Default provider: [Groq](https://console.groq.com)** — free API key, no credit card.
Gemini remains optional if you later want it (`AI_PROVIDER=gemini`).

```
backend/supabase/
├── schema.sql            # usage table + atomic consume_draft() function
└── functions/draft/
    └── index.ts          # verify user → meter → call Groq (or Gemini)
```

---

## What you set up (one-time)

### 1. Get a free Groq API key
- Go to [console.groq.com/keys](https://console.groq.com/keys)
- Sign in → **Create API Key** → copy it
- No billing / credits required for the free tier

### 2. Create a Supabase project
- supabase.com → **New project** (free tier). Note the **Project URL** and
  **anon public key** (Project Settings → API) — the extension needs these later.

### 3. Create the database objects
- Supabase dashboard → **SQL Editor** → paste all of `supabase/schema.sql` → **Run**.

### 4. Enable Google sign-in
- Dashboard → **Authentication → Providers → Google** → enable.
- You'll need a Google OAuth client (Google Cloud Console → Credentials →
  OAuth client ID). Paste its client ID + secret into Supabase. Add Supabase's
  callback URL (shown on that page) to the OAuth client's redirect URIs.
- In Supabase → **Authentication → URL Configuration**, allow the extension
  redirect: `https://<YOUR_EXTENSION_ID>.chromiumapp.org/`
  (find the ID on `chrome://extensions` after loading the unpacked build).
  The sidebar sign-in button uses `chrome.identity` with that URL.

### 5. Install the Supabase CLI and link the project
```bash
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>
```

### 6. Set the function's secrets
```bash
supabase secrets set GROQ_API_KEY=your_groq_key
# optional overrides:
supabase secrets set GROQ_MODEL=llama-3.3-70b-versatile
supabase secrets set AI_PROVIDER=groq
# Monthly draft cap is OFF by default until product ship:
# supabase secrets set DRAFT_QUOTA_ENABLED=true
# supabase secrets set FREE_DRAFT_LIMIT=10
```
(`SUPABASE_URL` and `SUPABASE_ANON_KEY` are provided automatically.)

### 7. Deploy the function
```bash
supabase functions deploy draft
```
Your endpoint is:
`https://<project-ref>.functions.supabase.co/draft`

---

## Optional: use Gemini instead

Only if you have a working free Gemini key from [AI Studio](https://aistudio.google.com/app/apikey)
(and your project is **not** stuck on prepaid with ₹0 credits):

```bash
supabase secrets set AI_PROVIDER=gemini
supabase secrets set GEMINI_API_KEY=your_gemini_key
supabase secrets set GEMINI_MODEL=gemini-2.5-flash
supabase functions deploy draft
```

---

## Test it

The function requires a signed-in user's JWT (that's the point — no anonymous
use). Two ways to get one:

- **Easiest:** finish wiring the extension's Google sign-in, then the Draft
  button exercises it for real.
- **Manual:** create a test user (Authentication → Users → Add user), get a
  session token for them, and:

```bash
curl -X POST "https://<project-ref>.functions.supabase.co/draft" \
  -H "Authorization: Bearer <USER_JWT>" \
  -H "content-type: application/json" \
  -d '{"question":"Why do you want to work here?","profile":{"firstName":"Kunal"},"resumeText":"..."}'
```

Expected: `{ "text": "…drafted answer…", "used": 1, "limit": 10 }`.
After 10 in a month: HTTP 402 with `limitReached: true`.

---

## How the pieces protect you

- **Key stays server-side** — it's a Supabase secret, never shipped to browsers.
- **JWT-gated** — only signed-in users can call `draft`; no anonymous abuse.
- **Per-user cap** — `consume_draft()` enforces 10/month atomically in Postgres.
- **No stale data** — no resume is stored; the extension sends the current one
  with each request.

## Later
- **Billing:** add a `plan` column + Razorpay when real usage justifies it; raise
  the limit for paid users in the function.

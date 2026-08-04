// Tvarin "draft" Edge Function (Supabase / Deno).
//
// Flow: verify the signed-in user (their JWT) → meter their monthly usage →
// call the AI provider with a server-held key → return the drafted answer.
// Provider keys never reach the browser.
//
// Default provider: Groq (free API key at https://console.groq.com/keys — no card).
//
// Secrets to set (see backend/README.md):
//   GROQ_API_KEY     (required for default provider)
//   GROQ_MODEL       (optional, default "llama-3.3-70b-versatile")
//   AI_PROVIDER      (optional, "groq" | "gemini", default "groq")
//   GEMINI_API_KEY   (only if AI_PROVIDER=gemini)
//   GEMINI_MODEL     (optional, default "gemini-2.5-flash")
//   FREE_DRAFT_LIMIT    (optional, default "10" — only when quota is on)
//   DRAFT_QUOTA_ENABLED (optional, default "false" — set "true" at product ship)
// SUPABASE_URL and SUPABASE_ANON_KEY are injected by the platform.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const AI_PROVIDER = (Deno.env.get("AI_PROVIDER") ?? "groq").toLowerCase();
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const GROQ_MODEL = Deno.env.get("GROQ_MODEL") ?? "llama-3.3-70b-versatile";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
const FREE_DRAFT_LIMIT = Number(Deno.env.get("FREE_DRAFT_LIMIT") ?? "10");
// Off until product ship. Set DRAFT_QUOTA_ENABLED=true to enforce the monthly cap.
const DRAFT_QUOTA_ENABLED =
  (Deno.env.get("DRAFT_QUOTA_ENABLED") ?? "false").toLowerCase() === "true";

const SYSTEM_PROMPT = `You are the job applicant. Write your own answer to ONE question on a job application, in your own voice.

You get: the exact question, job context (role/company/requirements), and the applicant's real data (personal info, links, about, work experience, projects, skills, resume text).

ANSWER THE ACTUAL QUESTION — the most important rule.
- Read what is literally asked and answer THAT, directly, in the first sentence.
- "How much experience do you have in X?" → lead with a concrete answer about X specifically (roughly how long + 1–2 real examples of using it). Do NOT write a cover-letter intro.
- "Why do you want to work here / this role?" → a specific, honest reason tied to the role and your real interests — not generic enthusiasm.
- Short/yes-no question → keep it short. Never restate or rephrase the question back.

SOUND LIKE A REAL PERSON, not marketing copy or a chatbot.
- Plain, direct, specific. Write like a capable person explaining themselves to a smart colleague.
- Ground every claim in the applicant's real data: name the actual projects, the actual stack, real outcomes/numbers. Specific always beats generic.
- Use ONLY facts present in the data. Never invent employers, titles, dates, skills, projects, or achievements. If something's missing, answer honestly with what they have.
- Match length to the question. Most answers are 2–4 sentences. Don't pad.
- Vary wording between answers. When answering several similar questions, each answer must be about ITS specific topic and must start differently.

BANNED — never use these, they scream "AI":
- Openers: "As a recent graduate…", "As a passionate…", "I am excited to apply…", "I'm thrilled…".
- Phrases: "strong foundation", "confident in my ability", "align with", "leverage", "passionate about", "hit the ground running", "in today's fast-paced", "contribute to the company's mission/success/product engineering efforts", "honed my skills", "spearheaded", "proven track record".
- Do NOT open like a cover letter unless the question literally asks for one.

Output ONLY the answer text — no preamble, no quotation marks, no "Here is…".

EXAMPLE
Question: "How much experience do you have with React?"
BAD: "As a recent graduate with a strong foundation in full-stack development, I'm excited to apply for this role. I'm confident in my ability to contribute using React."
GOOD: "About two years, across four projects. Most recently I built <their real project>, a <what it does> app in React using hooks and context for state, with a live chat feature over WebSockets. I'm comfortable with component design, performance tuning, and wiring up REST APIs."`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function section(title: string, body: string): string {
  const t = (body || "").trim();
  return t ? `${title}:\n${t}` : "";
}

function buildUserMessage(body: any): string {
  const jc = body.jobContext || {};
  const applicant = body.applicant || {};
  const profile = body.profile || {};
  const personal = applicant.personal || {};
  const links = applicant.links || {};

  const parts: string[] = [];
  parts.push(`QUESTION TO ANSWER:\n${body.question}`);

  const jobBits = [
    jc.title ? `Role: ${jc.title}` : "",
    jc.company ? `Company: ${jc.company}` : "",
    jc.url ? `URL: ${jc.url}` : "",
    section("Job requirements / qualifications", jc.requirements || ""),
    section("Job description", jc.description || ""),
  ].filter(Boolean);
  if (jobBits.length) parts.push(`JOB CONTEXT:\n${jobBits.join("\n\n")}`);

  const personalLines = [
    personal.firstName || profile.firstName
      ? `Name: ${[personal.firstName || profile.firstName, personal.lastName || profile.lastName]
          .filter(Boolean)
          .join(" ")}`
      : "",
    (personal.email || profile.email) ? `Email: ${personal.email || profile.email}` : "",
    personal.phone ? `Phone: ${personal.phone}` : "",
    personal.location ? `Location: ${personal.location}` : "",
    personal.address ? `Address: ${personal.address}` : "",
    (links.linkedin || profile.linkedin) ? `LinkedIn: ${links.linkedin || profile.linkedin}` : "",
    (links.github || profile.github) ? `GitHub: ${links.github || profile.github}` : "",
    (links.portfolio || profile.portfolio)
      ? `Portfolio: ${links.portfolio || profile.portfolio}`
      : "",
  ].filter(Boolean);
  if (personalLines.length) parts.push(`APPLICANT PERSONAL INFO:\n${personalLines.join("\n")}`);

  const about = applicant.about || profile.about || "";
  const experience = applicant.experience || profile.experience || "";
  const projects = applicant.projects || profile.projects || "";
  const skills = applicant.skills || profile.skills || "";
  const resumeText = applicant.resumeText || body.resumeText || "";

  const aboutSec = section("About / summary", about);
  if (aboutSec) parts.push(`APPLICANT ABOUT:\n${about}`);
  const expSec = section("Work experience", experience);
  if (expSec) parts.push(`APPLICANT WORK EXPERIENCE:\n${experience}`);
  const projSec = section("Personal / side projects", projects);
  if (projSec) parts.push(`APPLICANT PROJECTS:\n${projects}`);
  const skillsSec = section("Skills", skills);
  if (skillsSec) parts.push(`APPLICANT SKILLS:\n${skills}`);
  if (resumeText) parts.push(`APPLICANT RESUME / FULL TEXT:\n${resumeText}`);

  // Fallback: dump raw profile keys if we somehow got nothing structured
  if (parts.length < 3) {
    const profileLines = Object.entries(profile)
      .filter(([, v]) => v)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n");
    if (profileLines) parts.push(`APPLICANT PROFILE:\n${profileLines}`);
  }

  parts.push(
    "Write the answer now. Ground every claim in the applicant data above and align it with the job requirements when possible.",
  );
  return parts.join("\n\n");
}

async function callGroq(userMessage: string): Promise<{ text?: string; error?: string; status?: number }> {
  if (!GROQ_API_KEY) {
    return { error: "Server not configured — set GROQ_API_KEY in Supabase secrets.", status: 500 };
  }
  let res: Response;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.6,
        max_tokens: 1024,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      }),
    });
  } catch (_) {
    return { error: "Could not reach the AI provider.", status: 502 };
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail =
      body?.error?.message ||
      (typeof body?.error === "string" ? body.error : "") ||
      "";
    return {
      error: detail
        ? `AI provider error (${res.status}): ${detail}`
        : `AI provider error (${res.status}).`,
      status: 502,
    };
  }

  const text = (body?.choices?.[0]?.message?.content || "").trim();
  if (!text) return { error: "No answer produced. Try again.", status: 502 };
  return { text };
}

async function callGemini(userMessage: string): Promise<{ text?: string; error?: string; status?: number }> {
  if (!GEMINI_API_KEY) {
    return { error: "Server not configured — set GEMINI_API_KEY in Supabase secrets.", status: 500 };
  }
  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
          generationConfig: { maxOutputTokens: 1024 },
        }),
      },
    );
  } catch (_) {
    return { error: "Could not reach the AI provider.", status: 502 };
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail =
      body?.error?.message ||
      body?.error?.status ||
      (typeof body?.error === "string" ? body.error : "") ||
      "";
    return {
      error: detail
        ? `AI provider error (${res.status}): ${detail}`
        : `AI provider error (${res.status}).`,
      status: 502,
    };
  }

  const text = (body?.candidates?.[0]?.content?.parts || [])
    .map((p: any) => p.text || "")
    .join("")
    .trim();
  if (!text) return { error: "No answer produced. Try again.", status: 502 };
  return { text };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);

  // 1. Identify the signed-in user from their JWT.
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: "Please sign in to use AI drafts." }, 401);
  }

  const body = await req.json().catch(() => null);
  if (!body || !body.question) return json({ error: "Missing question." }, 400);

  // 2. Meter usage (optional — off until product ship).
  let quota = { allowed: true, used: 0, limit: null as number | null };
  if (DRAFT_QUOTA_ENABLED) {
    const { data, error: qErr } = await supabase.rpc("consume_draft", {
      monthly_limit: FREE_DRAFT_LIMIT,
    });
    if (qErr) return json({ error: "Usage check failed." }, 500);
    if (!data || !data.allowed) {
      return json(
        {
          error: `You've used your ${FREE_DRAFT_LIMIT} free drafts this month. Upgrades coming soon.`,
          limitReached: true,
          used: data?.used,
          limit: FREE_DRAFT_LIMIT,
        },
        402,
      );
    }
    quota = { allowed: true, used: data.used, limit: FREE_DRAFT_LIMIT };
  }

  // 3. Call AI provider.
  const userMessage = buildUserMessage(body);
  const result =
    AI_PROVIDER === "gemini" ? await callGemini(userMessage) : await callGroq(userMessage);

  if (result.error) {
    return json({ error: result.error }, result.status || 502);
  }

  return json({
    text: result.text,
    used: quota.used,
    limit: DRAFT_QUOTA_ENABLED ? FREE_DRAFT_LIMIT : null,
    quotaEnabled: DRAFT_QUOTA_ENABLED,
  });
});

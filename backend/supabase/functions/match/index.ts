// Tvarin "match" Edge Function (Supabase / Deno).
//
// Resume ↔ job match analysis. Verifies the signed-in user, then asks the AI to
// extract the job's key requirements and judge the candidate against each.
// The score is DERIVED server-side from the counts — (met + 0.5·partial) / total
// — so the number always means "how many of the job's requirements you cover",
// not a vibes-based percentage the model made up.
//
// Secrets (shared with the draft function): GROQ_API_KEY, GROQ_MODEL,
// AI_PROVIDER (groq|gemini), GEMINI_API_KEY, GEMINI_MODEL.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const AI_PROVIDER = (Deno.env.get("AI_PROVIDER") ?? "groq").toLowerCase();
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const GROQ_MODEL = Deno.env.get("GROQ_MODEL") ?? "llama-3.3-70b-versatile";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";

const SYSTEM_PROMPT = `You are an ATS resume-to-job match analyzer. You compare a candidate's background to a specific job and report, honestly, how well they match.

Given the JOB and the CANDIDATE data:
1. Extract 6–12 of the job's most important requirements/skills/qualifications — the ones a recruiter actually screens on. Prefer concrete skills, technologies, tools, and years/level of experience over generic fluff.
2. For each, judge whether the CANDIDATE data clearly demonstrates it:
   - "met": clearly present (a named skill, project, or experience shows it).
   - "partial": adjacent/related evidence, but not a clear match.
   - "missing": no evidence in the candidate data.
3. Judge ONLY from the candidate data provided. Never assume or invent. If it isn't there, it's "missing".

Return STRICT JSON only — no prose, no markdown — in exactly this shape:
{
  "requirements": [
    { "text": "<short label, e.g. 'React' or '3+ yrs backend'>", "status": "met|partial|missing", "note": "<=12 words: why>" }
  ],
  "summary": "<one honest sentence on overall fit and the biggest gap>"
}
Use 6–12 requirement items with short labels.`;

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

function candidateText(body: any): string {
  const p = body?.profile || {};
  const parts: string[] = [];
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ");
  if (name) parts.push(`Name: ${name}`);
  if (p.skills) parts.push(`Skills: ${p.skills}`);
  if (p.experience) parts.push(`Work experience:\n${p.experience}`);
  if (p.projects) parts.push(`Projects:\n${p.projects}`);
  if (p.about) parts.push(`About: ${p.about}`);
  const resume = body?.resumeText || "";
  if (resume) parts.push(`Resume text:\n${resume}`);
  return parts.join("\n\n");
}

function parseJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch (_) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch (_) {}
  }
  return null;
}

// Turn the model's requirements list into a stable, derived score.
function analyze(parsed: any) {
  const raw = Array.isArray(parsed?.requirements) ? parsed.requirements : [];
  const requirements = raw
    .map((r: any) => ({
      text: String(r?.text || "").trim().slice(0, 80),
      status: ["met", "partial", "missing"].includes(r?.status) ? r.status : "partial",
      note: String(r?.note || "").trim().slice(0, 120),
    }))
    .filter((r: any) => r.text)
    .slice(0, 14);

  const total = requirements.length;
  if (!total) {
    return { error: "The analysis came back empty. Try again." };
  }
  const metCount = requirements.filter((r: any) => r.status === "met").length;
  const partialCount = requirements.filter((r: any) => r.status === "partial").length;
  const missingCount = requirements.filter((r: any) => r.status === "missing").length;
  const score = Math.round((100 * (metCount + 0.5 * partialCount)) / total);
  const band = score >= 75 ? "Strong" : score >= 50 ? "Partial" : "Stretch";

  return {
    score,
    band,
    total,
    metCount,
    partialCount,
    missingCount,
    summary: String(parsed?.summary || "").trim().slice(0, 300),
    requirements,
  };
}

async function callGroqJson(userMessage: string) {
  if (!GROQ_API_KEY) {
    return { error: "Server not configured — set GROQ_API_KEY.", status: 500 };
  }
  let res: Response;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: 1200,
        response_format: { type: "json_object" },
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
    const detail = body?.error?.message || (typeof body?.error === "string" ? body.error : "");
    return { error: detail ? `AI provider error (${res.status}): ${detail}` : `AI provider error (${res.status}).`, status: 502 };
  }
  const parsed = parseJson(body?.choices?.[0]?.message?.content || "");
  if (!parsed) return { error: "Couldn't parse the analysis. Try again.", status: 502 };
  return { data: parsed };
}

async function callGeminiJson(userMessage: string) {
  if (!GEMINI_API_KEY) {
    return { error: "Server not configured — set GEMINI_API_KEY.", status: 500 };
  }
  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
          generationConfig: { maxOutputTokens: 1200, responseMimeType: "application/json" },
        }),
      },
    );
  } catch (_) {
    return { error: "Could not reach the AI provider.", status: 502 };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.error?.message || "";
    return { error: detail ? `AI provider error (${res.status}): ${detail}` : `AI provider error (${res.status}).`, status: 502 };
  }
  const text = (body?.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || "").join("");
  const parsed = parseJson(text);
  if (!parsed) return { error: "Couldn't parse the analysis. Try again.", status: 502 };
  return { data: parsed };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);

  // Auth: identify the signed-in user.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: "Please sign in to check your match." }, 401);
  }

  const body = await req.json().catch(() => null);
  const jd = String(body?.jobDescription || "").trim();
  if (!jd) return json({ error: "Couldn't read the job description on this page." }, 400);

  const cand = candidateText(body);
  if (!cand.trim()) {
    return json({ error: "Add your experience/skills or resume text in Profile first." }, 400);
  }

  const userMessage = `JOB:${body?.jobTitle ? `\nTitle: ${body.jobTitle}` : ""}\n${jd.slice(0, 6000)}\n\nCANDIDATE:\n${cand.slice(0, 8000)}`;

  const result = AI_PROVIDER === "gemini"
    ? await callGeminiJson(userMessage)
    : await callGroqJson(userMessage);
  if (result.error) return json({ error: result.error }, result.status || 502);

  const analysis = analyze(result.data);
  if ((analysis as any).error) return json(analysis, 502);
  return json(analysis);
});

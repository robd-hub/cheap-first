/**
 * POST /api/ask  {"question": "..."}
 *
 * The live "try it" endpoint behind the results page. Runs one question the
 * Cheap First way and returns the answer, who answered, the check and the
 * real cost. Keys stay on the server (Vercel environment variables).
 *
 * Guard rails, because every call spends real credits:
 *   - questions are capped at MAX_QUESTION characters
 *   - each visitor (by IP) gets PER_IP_PER_HOUR questions an hour
 *   - each server instance stops after DAILY_CAP questions a day
 */
import { cheapFirst, defaultModels, type Models } from "../src/cheapFirst.js";

const MAX_QUESTION = 600;
const PER_IP_PER_HOUR = Number(process.env.CF_PER_IP_PER_HOUR) || 10;
const DAILY_CAP = Number(process.env.CF_DAILY_CAP) || 300;

const hits = new Map<string, number[]>();
let day = "";
let today = 0;
let models: Models | null = null;

function cors(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(origin) } });
}

export function OPTIONS(request: Request): Response {
  return new Response(null, { status: 204, headers: cors(request.headers.get("origin")) });
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  let question = "";
  try {
    question = String(((await request.json()) as { question?: unknown }).question ?? "").trim();
  } catch {
    return json({ error: "Send JSON like {\"question\": \"...\"}." }, 400, origin);
  }
  if (!question) return json({ error: "Type a question first." }, 400, origin);
  if (question.length > MAX_QUESTION) return json({ error: `Keep it under ${MAX_QUESTION} characters.` }, 400, origin);

  const now = Date.now();
  const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PER_IP_PER_HOUR) {
    return json({ error: `That's ${PER_IP_PER_HOUR} questions this hour. Try again later.` }, 429, origin);
  }
  const d = new Date(now).toISOString().slice(0, 10);
  if (d !== day) {
    day = d;
    today = 0;
  }
  if (today >= DAILY_CAP) return json({ error: "The demo has hit today's limit. Try again tomorrow." }, 429, origin);
  recent.push(now);
  hits.set(ip, recent);
  today++;

  try {
    models ??= await defaultModels();
    const r = await cheapFirst(question, models);
    return json(
      {
        answer: r.answer,
        answeredBy: r.answeredBy,
        model: r.answeredBy === "cheap" ? models.cheap.label : models.premium.label,
        check: { score: r.check.score, reason: r.check.reason },
        cheapAnswer: r.answeredBy === "premium" ? r.cheap.text : undefined,
        costUsd: r.costUsd,
        ms: r.cheap.ms + r.check.call.ms + (r.premium?.ms ?? 0),
      },
      200,
      origin,
    );
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong reaching the models. Please try again." }, 502, origin);
  }
}

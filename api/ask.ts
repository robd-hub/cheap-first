/**
 * POST /api/ask  {"question": "..."}
 *
 * The live "try it" endpoint behind the results page. Runs one question the
 * Cheap First way and returns the answer, who answered, the check and the
 * real cost. Keys stay on the server (Vercel environment variables).
 *
 * Guard rails, because every call spends real credits:
 *   - questions are capped at DEMO_MAX_QUESTION characters
 *   - each visitor (by IP) gets a fixed number an hour, and the demo a fixed number a day
 *   - escalations stop once the demo's daily premium budget is spent
 * Free MCP calls use the same limits (src/limits.ts), so the two can't be
 * combined into a bigger free tier. With the shared store connected these
 * hold across all server instances.
 */
import { demoPremiumBudget as premiumBudget, PREMIUM_MAX_TOKENS } from "../src/budget.js";
import { cheapFirst, defaultModels, EscalationBlocked, PASS_MARK, savings, type Models } from "../src/cheapFirst.js";
import { DEMO_MAX_QUESTION, takeDemoSlot } from "../src/limits.js";
import { noteCheapFirst } from "../src/liveStats.js";

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
  if (question.length > DEMO_MAX_QUESTION) return json({ error: `Keep it under ${DEMO_MAX_QUESTION} characters.` }, 400, origin);

  const slot = await takeDemoSlot(request);
  if (!slot.ok) return json({ error: slot.error }, slot.status, origin);

  try {
    models ??= await defaultModels();
    const r = await cheapFirst(question, models, undefined, {
      premiumMaxTokens: PREMIUM_MAX_TOKENS,
      canEscalate: () => premiumBudget.hasRoom(),
    });
    if (r.premium) await premiumBudget.add(r.premium.costUsd);
    noteCheapFirst("demo", r, models, PASS_MARK);
    return json(
      {
        answer: r.answer,
        answeredBy: r.answeredBy,
        model: r.answeredBy === "cheap" ? models.cheap.label : models.premium.label,
        check: { score: r.check.score, reason: r.check.reason, signal: r.check.signal },
        cheapAnswer: r.answeredBy === "premium" ? r.cheap.text : undefined,
        costUsd: r.costUsd,
        savedUsd: savings(r, models).savedUsd,
        ms: r.cheap.ms + r.check.call.ms + (r.premium?.ms ?? 0),
      },
      200,
      origin,
    );
  } catch (e) {
    if (e instanceof EscalationBlocked) {
      return json({ error: "That question needs the premium model, and the free demo has used today's premium budget. Try an easier one, or come back tomorrow." }, 429, origin);
    }
    console.error(e);
    return json({ error: "Something went wrong reaching the models. Please try again." }, 502, origin);
  }
}

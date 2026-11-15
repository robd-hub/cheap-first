/**
 * POST /api/pay  {"question": "...", "mode": "balanced"}
 *
 * The paid Cheap First endpoint: $0.005 in USDC on Base per answer, paid with
 * x402. Call it once without payment to get a 402 listing the price and where
 * to pay; an x402 client (for example x402-fetch or an agent wallet) then pays
 * and retries automatically. No sign-up or API key.
 *
 * `mode` is optional: "strict" escalates more often, "budget" less often.
 *
 * The payment is only settled after the answer is ready, so a failed request
 * is never charged. For an OpenAI-style API, see api/v1/chat/completions.ts.
 */
import { paidPremiumBudget as premiumBudget, PREMIUM_MAX_TOKENS } from "../src/budget.js";
import { cheapFirst, defaultModels, EscalationBlocked, MODES, modeFrom, savings, type Models } from "../src/cheapFirst.js";
import { json, paidCall, PAID_CORS } from "../src/paid.js";
import { QUESTION_OFFER } from "../src/x402.js";

/** Long questions cost more to send to the premium model, so keep them reasonable. */
const MAX_QUESTION = 2000;
let models: Models | null = null;

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: PAID_CORS });
}

export async function POST(request: Request): Promise<Response> {
  let question = "";
  let mode = modeFrom(undefined);
  try {
    const body = (await request.json()) as { question?: unknown; mode?: unknown };
    question = String(body.question ?? "").trim();
    mode = modeFrom(body.mode);
  } catch {
    return json({ error: "Send JSON like {\"question\": \"...\"}." }, 400);
  }
  if (!question) return json({ error: "Include a question." }, 400);
  if (question.length > MAX_QUESTION) return json({ error: `Keep it under ${MAX_QUESTION} characters.` }, 400);

  return paidCall(request, QUESTION_OFFER, async () => {
    try {
      models ??= await defaultModels();
      const m = models;
      const result = await cheapFirst(question, m, undefined, {
        premiumMaxTokens: PREMIUM_MAX_TOKENS,
        canEscalate: () => premiumBudget.hasRoom(),
        passMark: MODES[mode],
      });
      if (result.premium) premiumBudget.add(result.premium.costUsd);
      const { savedUsd } = savings(result, m);
      return {
        respond: (paid, headers) =>
          json(
            {
              answer: result.answer,
              answeredBy: result.answeredBy,
              model: result.answeredBy === "cheap" ? m.cheap.label : m.premium.label,
              mode,
              check: { score: result.check.score, reason: result.check.reason },
              costUsd: result.costUsd,
              savedUsd,
              paid,
            },
            200,
            headers,
          ),
      };
    } catch (e) {
      if (e instanceof EscalationBlocked) {
        return json({ error: "This question needs the premium model, which has hit today's limit. You haven't been charged. Please try again tomorrow." }, 503);
      }
      console.error(e);
      return json({ error: "Something went wrong reaching the models. You haven't been charged. Please try again." }, 502);
    }
  });
}

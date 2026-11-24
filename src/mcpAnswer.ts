/**
 * Turns an MCP ask_cheap_first call into a Cheap First answer, through the
 * doors that already exist.
 *
 *   free   the demo: same hourly and daily caps as /api/ask, same premium budget
 *   paid   a prepaid key or an x402 payment, via paidCall, same as /api/pay
 *
 * A failed paid answer is not charged: paidCall refunds a key credit and
 * never settles an x402 payment when this returns an error response.
 */
import { addKeySpend, demoPremiumBudget, paidPremiumBudget, PREMIUM_MAX_TOKENS, type DailyBudget } from "./budget.js";
import { cheapFirst, prewarmModels, sharedModels, EscalationBlocked, MODES, savings, type CheapFirstResult, type Mode, type Models } from "./cheapFirst.js";
import { keyFrom } from "./keys.js";
import { takeDemoSlot } from "./limits.js";
import { noteCheapFirst } from "./liveStats.js";
import { rpcOk, toolErrorResult, toolResult, type AskPayload, type AnswerOutcome, type JsonRpcId } from "./mcp.js";
import { paidCall, unpaidChallenge } from "./paid.js";
import { PRICE_MICRO, type Offer } from "./x402.js";

/** Same price as /api/pay. priceMicro is left unset so it tracks PRICE_MICRO. */
export const MCP_OFFER: Offer = {
  description: "One Cheap First answer through the MCP tool ask_cheap_first: Dolphin answers, a second cheap sample checks numbers and choices, SERV grades anything else, and a premium model steps in only if the check fails.",
  example: {
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_cheap_first", arguments: { question: "What is the capital of Australia?", mode: "balanced" } },
    },
    output: { answer: "Canberra.", escalated: false, checkScore: 98, costUsd: 0.00004, savedUsd: 0.0021 },
  },
  outputSchema: {
    input: {
      type: "http",
      method: "POST",
      bodyType: "json",
      bodyFields: {
        question: { type: "string", required: true, description: "Asked inside the MCP tool arguments. Up to 2,000 characters on this paid path." },
        mode: { type: "string", required: false, description: "strict, balanced (default) or budget" },
      },
    },
    output: { answer: "string", escalated: "boolean", checkScore: "number", costUsd: "number", savedUsd: "number" },
  },
};

let models: Models | null = null;
// Look up model prices while the first request is still being read.
prewarmModels();

export function toAskPayload(result: CheapFirstResult, specs: Models, mode: Mode): AskPayload {
  return {
    answer: result.answer,
    escalated: result.answeredBy === "premium",
    checkScore: result.check.score,
    costUsd: result.costUsd,
    savedUsd: savings(result, specs).savedUsd,
    answeredBy: result.answeredBy,
    model: result.answeredBy === "cheap" ? specs.cheap.label : specs.premium.label,
    mode,
    checkReason: result.check.reason,
    checkSignal: result.check.signal,
  };
}

async function run(question: string, mode: Mode, budget: DailyBudget): Promise<{ payload: AskPayload; result: CheapFirstResult; specs: Models }> {
  models ??= await sharedModels();
  const specs = models;
  const result = await cheapFirst(question, specs, undefined, {
    premiumMaxTokens: PREMIUM_MAX_TOKENS,
    canEscalate: () => budget.hasRoom(),
    passMark: MODES[mode],
  });
  if (result.premium) await budget.add(result.premium.costUsd);
  return { payload: toAskPayload(result, specs, mode), result, specs };
}

export async function answerFree(request: Request, question: string, mode: Mode): Promise<AnswerOutcome> {
  const slot = await takeDemoSlot(request);
  if (!slot.ok) return { ok: false, message: slot.error };
  try {
    const { payload, result, specs } = await run(question, mode, demoPremiumBudget);
    noteCheapFirst("mcp", result, specs, MODES[mode]);
    return { ok: true, payload };
  } catch (e) {
    if (e instanceof EscalationBlocked) {
      return { ok: false, message: "That question needs the premium model, and the free demo has used today's premium budget. Try an easier one, or come back tomorrow." };
    }
    console.error(e);
    return { ok: false, message: "Something went wrong reaching the models. Please try again." };
  }
}

export async function answerPaid(request: Request, id: JsonRpcId, question: string, mode: Mode): Promise<Response> {
  const unpaid = unpaidChallenge(request, MCP_OFFER);
  if (unpaid) return unpaid;
  let res: Response;
  try {
    res = await paidCall(request, MCP_OFFER, async () => {
      try {
        const { payload, result, specs } = await run(question, mode, paidPremiumBudget);
        return {
          costUsd: result.costUsd,
          respond: (paid, headers) => {
            noteCheapFirst("mcp", result, specs, MODES[mode]);
            return rpcOk(
              request,
              id,
              toolResult({
                ...payload,
                tier: "paid",
                paidUsd: paid.amountUsd,
                ...(paid.creditsLeft !== undefined ? { creditsLeft: paid.creditsLeft } : {}),
                ...(paid.transaction ? { transaction: paid.transaction } : {}),
              }),
              headers,
            );
          },
        };
      } catch (e) {
        if (e instanceof EscalationBlocked) {
          if (keyFrom(request)) await addKeySpend(e.costUsd);
          return rpcOk(request, id, toolErrorResult("This question needs the premium model, which has hit today's limit. You haven't been charged. Please try again tomorrow."));
        }
        console.error(e);
        return rpcOk(request, id, toolErrorResult("Something went wrong reaching the models. You haven't been charged. Please try again."));
      }
    });
  } catch (e) {
    console.error(e);
    return rpcOk(request, id, toolErrorResult("Something went wrong reaching the models. You haven't been charged. Please try again."));
  }
  // A 402 with PAYMENT-REQUIRED is an x402 challenge (or a rejected payment). Anything
  // else that isn't the answer (an empty key, the store being down) is a tool error,
  // so an MCP client can show the message instead of a bare HTTP status.
  if (res.ok || res.headers.get("payment-required")) return res;
  let message = "The paid call failed. You haven't been charged.";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) message = body.error;
  } catch {
    // The body wasn't JSON. The fallback above is enough.
  }
  return rpcOk(request, id, toolErrorResult(message));
}

/** The public price, in USDC micro-units. Exposed so a test can see the MCP offer didn't pick a different one. */
export const MCP_PRICE_MICRO = PRICE_MICRO;

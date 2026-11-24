/**
 * The x402 pay-per-answer flow shared by the paid endpoints:
 * no payment -> 402 with the price; payment -> verify, produce the answer,
 * then settle. If producing the answer fails, the payment is never settled,
 * so the caller isn't charged. A cf_ key is the other way in: an unknown key
 * is 401, and a used-up key, the per-key rate limit, or the daily spend cap
 * is 429. Those are not 402s. 402 stays the x402 challenge.
 */
import { addKeySpend } from "./budget.js";
import { claimKey, creditsLeft, keyFrom, refundCredit, type KeyDenial } from "./keys.js";
import { decodePayment, encodeHeader, paymentFrom, paymentRequired, paymentRequiredV2, requirements, settlePayment, settlePaymentV2, verifyPayment, verifyPaymentV2, type Offer, type PaymentRequirements } from "./x402.js";

export const PAID_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-PAYMENT, PAYMENT-SIGNATURE",
  "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE, PAYMENT-REQUIRED, PAYMENT-RESPONSE",
};

export function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...PAID_CORS, ...extra } });
}

/**
 * A 402 in both x402 versions: the JSON body is version 1, and the
 * PAYMENT-REQUIRED header carries the version 2 offer (with the bazaar
 * discovery extension that x402 directories read).
 */
export function challenge(resource: string, error: string, offer: Offer, req: PaymentRequirements = requirements(resource, offer), extra: Record<string, string> = {}): Response {
  return json(paymentRequired(resource, error, offer), 402, { "PAYMENT-REQUIRED": encodeHeader(paymentRequiredV2(resource, error, offer, req)), ...extra });
}

/**
 * The 402 for a request that carries no payment and no prepaid key, or null
 * if it carries one. Handlers call this before reading the body, so a bare
 * probe (as x402 directories send) gets the price instead of a 400.
 */
export function unpaidChallenge(request: Request, offer: Offer): Response | null {
  if (keyFrom(request) || paymentFrom(request)) return null;
  const resource = new URL(request.url).toString();
  const req = requirements(resource, offer);
  return challenge(resource, `Payment required: $${Number(req.maxAmountRequired) / 1e6} in USDC on Base per call.`, offer, req);
}

export interface Produced {
  /** Model dollars (cheap + check + premium) to count against the key-path daily cap. Ignored for x402. */
  costUsd?: number;
  /** Builds the response once the payment has settled. */
  respond: (paid: { amountUsd: number; transaction?: string; creditsLeft?: number }, paymentHeader: Record<string, string>) => Response;
}

export type KeyErrorFormat = "plain" | "openai";

/** Key-path errors. OpenAI clients want `{error:{message,type,code}}`. Other endpoints keep a string. */
export function keyDenialResponse(denial: KeyDenial, format: KeyErrorFormat): Response {
  const extra: Record<string, string> = denial.retryAfter ? { "Retry-After": String(denial.retryAfter) } : {};
  if (format === "openai") return json({ error: { message: denial.message, type: denial.type, code: denial.code } }, denial.status, extra);
  return json({ error: denial.message }, denial.status, extra);
}

/**
 * Runs `produce` only for a valid payment, and settles only if it returns a
 * result. `produce` returns a Response instead to reply with an error, uncharged.
 */
export async function paidCall(request: Request, offer: Offer, produce: () => Promise<Produced | Response>, options: { keyErrors?: KeyErrorFormat } = {}): Promise<Response> {
  const resource = new URL(request.url).toString();
  const req = requirements(resource, offer);

  // A prepaid or trial key instead of an x402 payment. 402 stays the x402 signal.
  const apiKey = keyFrom(request);
  if (apiKey) {
    const claimed = await claimKey(apiKey);
    if (!claimed.ok) return keyDenialResponse(claimed.denial, options.keyErrors ?? "plain");
    let produced: Produced | Response;
    try {
      produced = await produce();
    } catch (e) {
      await refundCredit(apiKey);
      throw e;
    }
    if (produced instanceof Response) {
      await refundCredit(apiKey);
      return produced;
    }
    if (produced.costUsd && produced.costUsd > 0) await addKeySpend(produced.costUsd);
    return produced.respond({ amountUsd: Number(req.maxAmountRequired) / 1e6, creditsLeft: await creditsLeft(apiKey) }, {});
  }

  const payment = paymentFrom(request);
  if (!payment) return challenge(resource, `Payment required: $${Number(req.maxAmountRequired) / 1e6} in USDC on Base per answer.`, offer, req);
  const v2 = payment.version === 2;
  const receiptHeader = v2 ? "PAYMENT-RESPONSE" : "X-PAYMENT-RESPONSE";
  const payload = decodePayment(payment.header);
  if (!payload) return challenge(resource, `The ${v2 ? "PAYMENT-SIGNATURE" : "X-PAYMENT"} header couldn't be read.`, offer, req);

  try {
    const check = await (v2 ? verifyPaymentV2 : verifyPayment)(payload, req);
    if (!check.isValid) return challenge(resource, `Payment not accepted: ${check.invalidReason ?? "invalid payment"}.`, offer, req);
  } catch (e) {
    console.error(e);
    return json({ error: "Couldn't check the payment right now. You haven't been charged. Please try again." }, 503);
  }

  const produced = await produce();
  if (produced instanceof Response) return produced;

  let settled: Awaited<ReturnType<typeof settlePayment>>;
  try {
    settled = await (v2 ? settlePaymentV2 : settlePayment)(payload, req);
  } catch (e) {
    console.error(e);
    return challenge(resource, "The payment couldn't be settled, so no answer was released. You haven't been charged.", offer, req);
  }
  if (!settled.success) {
    return challenge(resource, `Payment couldn't be settled: ${settled.errorReason ?? "unknown reason"}. You haven't been charged.`, offer, req, { [receiptHeader]: encodeHeader(settled) });
  }
  return produced.respond({ amountUsd: Number(req.maxAmountRequired) / 1e6, transaction: settled.transaction }, { [receiptHeader]: encodeHeader(settled) });
}

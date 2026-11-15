/**
 * The x402 pay-per-answer flow shared by the paid endpoints:
 * no payment -> 402 with the price; payment -> verify, produce the answer,
 * then settle. If producing the answer fails, the payment is never settled,
 * so the caller isn't charged.
 */
import { decodePayment, encodeHeader, paymentRequired, requirements, settlePayment, verifyPayment, type Offer } from "./x402.js";

export const PAID_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-PAYMENT",
  "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
};

export function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...PAID_CORS, ...extra } });
}

export interface Produced {
  /** Builds the response once the payment has settled. */
  respond: (paid: { amountUsd: number; transaction?: string }, paymentHeader: Record<string, string>) => Response;
}

/**
 * Runs `produce` only for a valid payment, and settles only if it returns a
 * result. `produce` returns a Response instead to reply with an error, uncharged.
 */
export async function paidCall(request: Request, offer: Offer, produce: () => Promise<Produced | Response>): Promise<Response> {
  const resource = new URL(request.url).toString();
  const req = requirements(resource, offer);
  const header = request.headers.get("x-payment");
  if (!header) return json(paymentRequired(resource, "Payment required: $0.005 in USDC on Base per answer.", offer), 402);
  const payload = decodePayment(header);
  if (!payload) return json(paymentRequired(resource, "The X-PAYMENT header couldn't be read.", offer), 402);

  try {
    const check = await verifyPayment(payload, req);
    if (!check.isValid) return json(paymentRequired(resource, `Payment not accepted: ${check.invalidReason ?? "invalid payment"}.`, offer), 402);
  } catch (e) {
    console.error(e);
    return json({ error: "Couldn't check the payment right now. You haven't been charged. Please try again." }, 503);
  }

  const produced = await produce();
  if (produced instanceof Response) return produced;

  let settled: Awaited<ReturnType<typeof settlePayment>>;
  try {
    settled = await settlePayment(payload, req);
  } catch (e) {
    console.error(e);
    return json(paymentRequired(resource, "The payment couldn't be settled, so no answer was released. You haven't been charged.", offer), 402);
  }
  if (!settled.success) {
    return json(paymentRequired(resource, `Payment couldn't be settled: ${settled.errorReason ?? "unknown reason"}. You haven't been charged.`, offer), 402);
  }
  return produced.respond({ amountUsd: Number(req.maxAmountRequired) / 1e6, transaction: settled.transaction }, { "X-PAYMENT-RESPONSE": encodeHeader(settled) });
}

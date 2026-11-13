/**
 * Minimal x402 ("HTTP 402 Payment Required") support for selling one Cheap
 * First answer per payment, in USDC on Base.
 *
 * The flow (x402 version 1, "exact" scheme):
 *   1. A request with no X-PAYMENT header gets a 402 listing what to pay.
 *   2. The client signs a USDC transfer authorization and resends the request
 *      with it in the X-PAYMENT header (base64 JSON).
 *   3. We ask an x402 facilitator to verify it, answer the question, then ask
 *      the facilitator to settle (submit the transfer on Base). The settlement
 *      receipt goes back in the X-PAYMENT-RESPONSE header.
 *
 * No money moves unless the answer was produced: if the models fail, we never
 * settle, so the client isn't charged.
 */

/** Circle's native USDC on Base. Its EIP-712 domain is name "USD Coin", version "2". */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Where payments go. Override with PAY_TO_ADDRESS. */
export const PAY_TO = process.env.PAY_TO_ADDRESS || "0x57dE743368Ef3cf200ea6295Ab4981C8784a1054";

/** Price per question in USDC (6 decimals): 5000 = $0.005. Override with PRICE_USDC_MICRO. */
export const PRICE_MICRO = process.env.PRICE_USDC_MICRO || "5000";

/** The facilitator that verifies and settles payments. Override with X402_FACILITATOR_URL. */
export const FACILITATOR = (process.env.X402_FACILITATOR_URL || "https://facilitator.payai.network").replace(/\/$/, "");

export interface PaymentRequirements {
  scheme: "exact";
  network: "base";
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  outputSchema?: unknown;
  extra: { name: string; version: string };
}

export function requirements(resource: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: "base",
    maxAmountRequired: PRICE_MICRO,
    resource,
    description: "One answer from Cheap First: Dolphin answers, SERV checks, and a premium model steps in only if the check fails.",
    mimeType: "application/json",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    asset: USDC_BASE,
    outputSchema: {
      input: { type: "http", method: "POST", bodyType: "json", bodyFields: { question: { type: "string", required: true, description: "Your question, up to 4,000 characters" } } },
      output: { answer: "string", answeredBy: "cheap | premium", model: "string", check: { score: "number", reason: "string" } },
    },
    extra: { name: "USD Coin", version: "2" },
  };
}

/** The body of a 402 response. */
export function paymentRequired(resource: string, error: string) {
  return { x402Version: 1, error, accepts: [requirements(resource)] };
}

/** Decodes the X-PAYMENT header (base64 JSON). Returns null if it isn't valid. */
export function decodePayment(header: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function facilitator<T>(path: "verify" | "settle", paymentPayload: unknown, paymentRequirements: PaymentRequirements): Promise<T> {
  const res = await fetch(`${FACILITATOR}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements }),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Facilitator ${path} returned ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok && !(body && typeof body === "object")) throw new Error(`Facilitator ${path} returned ${res.status}`);
  return body as T;
}

export async function verifyPayment(payload: unknown, req: PaymentRequirements): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }> {
  return facilitator("verify", payload, req);
}

export async function settlePayment(payload: unknown, req: PaymentRequirements): Promise<{ success: boolean; errorReason?: string; transaction?: string; network?: string; payer?: string }> {
  return facilitator("settle", payload, req);
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

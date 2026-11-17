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
 *
 * x402 version 2 is supported alongside version 1: the 402 also carries a
 * PAYMENT-REQUIRED header (base64 JSON, network "eip155:8453", the "bazaar"
 * discovery extension describing the request body), and a payment can arrive
 * in the v2 PAYMENT-SIGNATURE header instead of X-PAYMENT; its receipt then
 * goes back in PAYMENT-RESPONSE. The JSON body of the 402 stays version 1, so
 * older clients keep working. Directories such as x402scan list only v2
 * endpoints, and facilitators catalogue them from the bazaar extension.
 */
import { CDP_FACILITATOR, cdpAuthHeader, cdpConfigured } from "./cdpAuth.js";

/** Circle's native USDC on Base. Its EIP-712 domain is name "USD Coin", version "2". */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Where payments go. Override with PAY_TO_ADDRESS. */
export const PAY_TO = process.env.PAY_TO_ADDRESS || "0x57dE743368Ef3cf200ea6295Ab4981C8784a1054";

/** Price per question in USDC (6 decimals): 5000 = $0.005. Override with PRICE_USDC_MICRO. */
export const PRICE_MICRO = process.env.PRICE_USDC_MICRO || "5000";

/**
 * The facilitator that verifies and settles payments. Coinbase's (CDP) when
 * CDP_API_KEY_ID and CDP_API_KEY_SECRET are set, since settling through it is
 * what lists the endpoints on Agentic.market; PayAI's (no account) otherwise.
 * X402_FACILITATOR_URL overrides both.
 */
export const FACILITATOR = (process.env.X402_FACILITATOR_URL || (cdpConfigured() ? CDP_FACILITATOR : "https://facilitator.payai.network")).replace(/\/$/, "");

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

export interface Offer {
  description: string;
  outputSchema: unknown;
  /** Example request and response, shown by x402 directories (the v2 "bazaar" extension). */
  example?: { body: Record<string, unknown>; output: unknown };
  /** Price in USDC micro-units (6 decimals), when it differs from PRICE_MICRO. */
  priceMicro?: string;
}

/** The name x402 directories show for this service. */
export const SERVICE_NAME = "Cheap First";

/** What /api/pay sells: one answer to one question. */
export const QUESTION_OFFER: Offer = {
  description: "One answer from Cheap First: Dolphin answers, SERV checks, and a premium model steps in only if the check fails.",
  example: {
    body: { question: "What is the capital of Australia?", mode: "balanced" },
    output: { answer: "Canberra.", answeredBy: "cheap", model: "Dolphin", check: { score: 98, reason: "Correct and concise." }, costUsd: 0.00004, savedUsd: 0.0021 },
  },
  outputSchema: {
    input: { type: "http", method: "POST", bodyType: "json", bodyFields: { question: { type: "string", required: true, description: "Your question, up to 2,000 characters" }, mode: { type: "string", required: false, description: "strict, balanced (default) or budget" } } },
    output: { answer: "string", answeredBy: "cheap | premium", model: "string", check: { score: "number", reason: "string" }, costUsd: "number", savedUsd: "number" },
  },
};

export function requirements(resource: string, offer: Offer = QUESTION_OFFER): PaymentRequirements {
  return {
    scheme: "exact",
    network: "base",
    maxAmountRequired: offer.priceMicro ?? PRICE_MICRO,
    resource,
    description: offer.description,
    mimeType: "application/json",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    asset: USDC_BASE,
    outputSchema: offer.outputSchema,
    extra: { name: "USD Coin", version: "2" },
  };
}

/** The body of a 402 response. */
export function paymentRequired(resource: string, error: string, offer: Offer = QUESTION_OFFER) {
  return { x402Version: 1, error, accepts: [requirements(resource, offer)] };
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

// ---- x402 version 2 ----

/** Base mainnet, as x402 v2 names networks (CAIP-2). */
export const NETWORK_V2 = "eip155:8453";

export interface RequirementsV2 {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

export function requirementsV2(req: PaymentRequirements): RequirementsV2 {
  return { scheme: "exact", network: NETWORK_V2, amount: req.maxAmountRequired, asset: req.asset, payTo: req.payTo, maxTimeoutSeconds: req.maxTimeoutSeconds, extra: req.extra };
}

interface FieldDef {
  type?: string;
  required?: boolean;
  description?: string;
}

/**
 * The v2 "bazaar" discovery extension: the request body as a JSON Schema plus
 * an example, built from the v1 outputSchema's bodyFields.
 */
export function bazaar(offer: Offer): unknown {
  const v1 = (offer.outputSchema ?? {}) as { input?: { bodyFields?: Record<string, FieldDef> }; output?: unknown };
  const fields = v1.input?.bodyFields ?? {};
  const properties: Record<string, { type: string; description?: string }> = {};
  for (const [name, f] of Object.entries(fields)) properties[name] = { type: f.type || "string", ...(f.description ? { description: f.description } : {}) };
  const required = Object.entries(fields).filter(([, f]) => f.required).map(([name]) => name);
  return {
    info: {
      input: { type: "http", method: "POST", bodyType: "json", body: offer.example?.body ?? {} },
      output: { type: "json", example: offer.example?.output ?? v1.output ?? {} },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: ["POST"] },
            bodyType: { type: "string", enum: ["json"] },
            body: { type: "object", properties, required },
          },
          required: ["type", "method", "bodyType", "body"],
          additionalProperties: false,
        },
        output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
      },
      required: ["input"],
    },
  };
}

/** The v2 PaymentRequired object, sent base64-encoded in the PAYMENT-REQUIRED header. */
export function paymentRequiredV2(resource: string, error: string, offer: Offer = QUESTION_OFFER, req: PaymentRequirements = requirements(resource, offer)) {
  return {
    x402Version: 2,
    error,
    resource: { url: resource, description: offer.description, mimeType: "application/json", serviceName: SERVICE_NAME },
    accepts: [requirementsV2(req)],
    extensions: { bazaar: bazaar(offer) },
  };
}

/** A payment from either version: v2's PAYMENT-SIGNATURE header, or v1's X-PAYMENT. */
export function paymentFrom(request: Request): { version: 1 | 2; header: string } | null {
  const v2 = request.headers.get("payment-signature");
  if (v2) return { version: 2, header: v2 };
  const v1 = request.headers.get("x-payment");
  return v1 ? { version: 1, header: v1 } : null;
}

export async function verifyPaymentV2(payload: unknown, req: PaymentRequirements): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }> {
  return facilitator("verify", payload, requirementsV2(req), 2);
}

export async function settlePaymentV2(payload: unknown, req: PaymentRequirements): Promise<{ success: boolean; errorReason?: string; transaction?: string; network?: string; payer?: string }> {
  return facilitator("settle", payload, requirementsV2(req), 2);
}

async function facilitator<T>(path: "verify" | "settle", paymentPayload: unknown, paymentRequirements: PaymentRequirements | RequirementsV2, x402Version: 1 | 2 = 1): Promise<T> {
  const url = `${FACILITATOR}/${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Coinbase's facilitator needs a signed token per call; others take none.
  if (FACILITATOR.startsWith(CDP_FACILITATOR) && cdpConfigured()) headers.Authorization = cdpAuthHeader("POST", url);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ x402Version, paymentPayload, paymentRequirements }),
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

// ---- OpenAPI discovery (x402scan and other directories read /openapi.json) ----

/** One paid POST operation in OpenAPI form, with its x402 price. */
export function openApiOperation(offer: Offer, summary: string, priceMicro: string = offer.priceMicro ?? PRICE_MICRO): Record<string, unknown> {
  const v1 = (offer.outputSchema ?? {}) as { input?: { bodyFields?: Record<string, FieldDef> } };
  const fields = v1.input?.bodyFields ?? {};
  const properties: Record<string, { type: string; description?: string }> = {};
  for (const [name, f] of Object.entries(fields)) properties[name] = { type: f.type || "string", ...(f.description ? { description: f.description } : {}) };
  const required = Object.entries(fields).filter(([, f]) => f.required).map(([name]) => name);
  const amount = (Number(priceMicro) / 1_000_000).toString();
  return {
    summary,
    description: offer.description,
    security: [],
    "x-payment-info": { price: { mode: "fixed", currency: "USD", amount }, protocols: [{ x402: {} }] },
    requestBody: {
      required: true,
      content: { "application/json": { schema: { type: "object", properties, ...(required.length ? { required } : {}) }, ...(offer.example?.body ? { example: offer.example.body } : {}) } },
    },
    responses: {
      "200": { description: "The answer", content: { "application/json": { schema: { type: "object" }, ...(offer.example?.output ? { example: offer.example.output } : {}) } } },
      "402": { description: "Payment Required: pay in USDC on Base with x402" },
    },
  };
}

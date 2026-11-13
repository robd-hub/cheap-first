/**
 * POST /api/pay  {"question": "..."}
 *
 * The paid Cheap First endpoint: $0.005 in USDC on Base per answer, paid with
 * x402. Call it once without payment to get a 402 listing the price and where
 * to pay; an x402 client (for example x402-fetch or an agent wallet) then pays
 * and retries automatically. No sign-up or API key.
 *
 * The payment is only settled after the answer is ready, so a failed request
 * is never charged.
 */
import { cheapFirst, defaultModels, type Models } from "../src/cheapFirst.js";
import { decodePayment, encodeHeader, paymentRequired, requirements, settlePayment, verifyPayment } from "../src/x402.js";

const MAX_QUESTION = 4000;
let models: Models | null = null;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-PAYMENT",
  "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
};

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS, ...extra } });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(request: Request): Promise<Response> {
  const resource = new URL(request.url).toString();
  const req = requirements(resource);

  let question = "";
  try {
    question = String(((await request.json()) as { question?: unknown }).question ?? "").trim();
  } catch {
    return json({ error: "Send JSON like {\"question\": \"...\"}." }, 400);
  }
  if (!question) return json({ error: "Include a question." }, 400);
  if (question.length > MAX_QUESTION) return json({ error: `Keep it under ${MAX_QUESTION} characters.` }, 400);

  const header = request.headers.get("x-payment");
  if (!header) return json(paymentRequired(resource, "Payment required: $0.005 in USDC on Base per answer."), 402);
  const payload = decodePayment(header);
  if (!payload) return json(paymentRequired(resource, "The X-PAYMENT header couldn't be read."), 402);

  try {
    const check = await verifyPayment(payload, req);
    if (!check.isValid) return json(paymentRequired(resource, `Payment not accepted: ${check.invalidReason ?? "invalid payment"}.`), 402);
  } catch (e) {
    console.error(e);
    return json({ error: "Couldn't check the payment right now. You haven't been charged. Please try again." }, 503);
  }

  let result: Awaited<ReturnType<typeof cheapFirst>>;
  try {
    models ??= await defaultModels();
    result = await cheapFirst(question, models);
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong reaching the models. You haven't been charged. Please try again." }, 502);
  }

  let settled: Awaited<ReturnType<typeof settlePayment>>;
  try {
    settled = await settlePayment(payload, req);
  } catch (e) {
    console.error(e);
    return json(paymentRequired(resource, "The payment couldn't be settled, so no answer was released. You haven't been charged."), 402);
  }
  if (!settled.success) return json(paymentRequired(resource, `Payment couldn't be settled: ${settled.errorReason ?? "unknown reason"}. You haven't been charged.`), 402);

  return json(
    {
      answer: result.answer,
      answeredBy: result.answeredBy,
      model: result.answeredBy === "cheap" ? models.cheap.label : models.premium.label,
      check: { score: result.check.score, reason: result.check.reason },
      paid: { amountUsd: Number(req.maxAmountRequired) / 1e6, transaction: settled.transaction },
    },
    200,
    { "X-PAYMENT-RESPONSE": encodeHeader(settled) },
  );
}

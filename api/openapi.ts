/**
 * GET /openapi.json (rewritten here in vercel.json)
 *
 * The paid endpoints as an OpenAPI document, which is how x402 directories
 * such as x402scan find them now (they no longer read /.well-known/x402).
 * Each operation carries its x402 price in "x-payment-info".
 */
import { openApiOperation, QUESTION_OFFER } from "../src/x402.js";
import { OFFER as CHAT_OFFER } from "./v1/chat/completions.js";

export function GET(request: Request): Response {
  const origin = new URL(request.url).origin;
  const doc = {
    openapi: "3.1.0",
    info: {
      title: "Cheap First",
      version: "1.0.0",
      description: "Answers with a cheap model, checks the answer with SERV Reasoning, and only pays for a premium model when the check fails. Pay per answer in USDC on Base with x402.",
      "x-guidance": "POST {\"question\": \"...\"} to /api/pay for one answer, or use /api/v1/chat/completions as an OpenAI-compatible endpoint. Call once without payment to get the 402 with the price.",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/pay": { post: openApiOperation(QUESTION_OFFER, "Answer a question cheaply") },
      "/api/v1/chat/completions": { post: openApiOperation(CHAT_OFFER, "OpenAI-compatible chat completion") },
    },
  };
  return new Response(JSON.stringify(doc), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
  });
}

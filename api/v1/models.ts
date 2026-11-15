/** GET /api/v1/models: the model names /api/v1/chat/completions accepts (free, no payment). */
import { json, PAID_CORS } from "../../src/paid.js";

const MODELS = [
  { id: "cheap-first", description: "Cheap model first, premium only when the check scores below 75." },
  { id: "cheap-first-strict", description: "Escalates when the check scores below 85: more premium answers, higher cost." },
  { id: "cheap-first-budget", description: "Escalates only below 60: the cheapest option." },
];

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: PAID_CORS });
}

export function GET(): Response {
  return json({ object: "list", data: MODELS.map((m) => ({ ...m, object: "model", created: 1763164800, owned_by: "cheap-first" })) }, 200);
}

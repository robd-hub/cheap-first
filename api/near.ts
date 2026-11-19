/**
 * NEAR AI Agent Market webhook for "Cheap First Verifier" (market.near.ai).
 *
 *   POST /api/near   NEAR's signed hire webhook (X-Market-Timestamp, X-Market-Signature)
 *   GET  /api/near   manual sweep, with "Authorization: Bearer <NEAR_WEBHOOK_SECRET>"
 *
 * Either way we work every open assignment: check the answer in the buyer's
 * brief and submit the verdict. See src/near.ts.
 */
import { waitUntil } from "@vercel/functions";
import { json } from "../src/paid.js";
import { signatureValid, sweep } from "../src/near.js";

const SECRET = () => process.env.NEAR_WEBHOOK_SECRET ?? "";

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const ok = signatureValid(body, request.headers.get("x-market-timestamp"), request.headers.get("x-market-signature"), SECRET());
  if (!ok) return json({ error: "Bad or missing signature." }, 401);
  let event: { event?: string; test?: boolean } = {};
  try {
    event = JSON.parse(body);
  } catch {
    /* an empty or odd body still triggers a sweep */
  }
  if (event.test || event.event === "webhook.ping") return json({ ok: true, pong: true }, 200);
  // Reply at once so NEAR doesn't time out, and keep working in the background.
  waitUntil(sweep().then((r) => console.log("near sweep", JSON.stringify(r))).catch((e) => console.error("near sweep failed", e)));
  return json({ ok: true, received: event.event ?? "unknown" }, 200);
}

export async function GET(request: Request): Promise<Response> {
  const secret = SECRET();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return json({ error: "Not allowed." }, 401);
  try {
    return json({ results: await sweep() }, 200);
  } catch (e) {
    return json({ error: String((e as Error).message) }, 500);
  }
}

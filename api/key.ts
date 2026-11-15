/**
 * GET /api/key?session=cs_...   Turns a paid Stripe checkout into a prepaid API key (shown once).
 * GET /api/key  (Authorization: Bearer cf_...)   How many answers the key has left, as JSON.
 *
 * Stripe's Payment Link redirects here after a card payment (see src/stripe.ts).
 */
import { creditsFor, creditsLeft, issueKey, keyFrom, keysAvailable } from "../src/keys.js";
import { paidSession } from "../src/stripe.js";

const MAX_AGE_DAYS = 30;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Cheap First</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0f17;color:#e8ecf3;max-width:640px;margin:48px auto;padding:0 16px;line-height:1.5}code,pre{background:#151b27;border-radius:8px;padding:2px 6px}pre{padding:14px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}a{color:#7cc4ff}.key{font-size:15px;border:1px solid #2ef2a4}</style></head>
<body><h1>${esc(title)}</h1>${body}<p><a href="/">← Back to Cheap First</a></p></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const apiKey = keyFrom(request);
  if (apiKey) {
    if (!keysAvailable()) return Response.json({ error: "Prepaid keys aren't available right now." }, { status: 503 });
    return Response.json({ creditsLeft: Math.max(0, await creditsLeft(apiKey)) }, { headers: { "Cache-Control": "no-store" } });
  }

  const session = new URL(request.url).searchParams.get("session") ?? "";
  if (!keysAvailable()) return page("Not available yet", "<p>Prepaid keys aren't switched on yet. If you were charged, reply to your Stripe receipt and we'll sort it out.</p>", 503);
  const paid = await paidSession(session);
  if ("error" in paid) return page("We couldn't find that payment", `<p>${esc(paid.error)} If you were charged, reply to your Stripe receipt and we'll sort it out.</p>`, 400);
  if (paid.currency !== "usd") return page("Unexpected currency", "<p>This checkout wasn't in US dollars. Reply to your Stripe receipt and we'll sort it out.</p>", 400);
  if ((Date.now() - paid.created.getTime()) / 86_400_000 > MAX_AGE_DAYS) return page("Checkout too old", "<p>This checkout is too old to turn into a key here. Reply to your Stripe receipt and we'll sort it out.</p>", 400);

  const credits = creditsFor(paid.amountTotal);
  const key = await issueKey(paid.id, credits);
  if (!key) {
    return page("Key already issued", "<p>A key was already made for this payment, and keys are only shown once. If you lost it, reply to your Stripe receipt.</p>", 409);
  }
  return page(
    "Your Cheap First API key",
    `<p>Thanks! This key is good for <b>${credits.toLocaleString("en-US")} answers</b>. <b>Copy it now: it won't be shown again.</b></p>
<pre class="key">${esc(key)}</pre>
<p>Use it as your API key with any OpenAI-style client:</p>
<pre>const client = new OpenAI({
  baseURL: "https://cheap-first.vercel.app/api/v1",
  apiKey: "${esc(key)}",
});</pre>
<p>Or send <code>Authorization: Bearer ${esc(key.slice(0, 8))}…</code> to <code>/api/pay</code>. Check what's left at <code>GET /api/key</code> with the same header.</p>`,
  );
}

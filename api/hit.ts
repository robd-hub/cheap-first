/**
 * POST /api/hit: one page view from a site beacon (src/visits.ts).
 * GET /api/hit (rewritten from /visits): the visits page.
 *
 * The beacon is sent as text/plain so browsers don't need a CORS preflight.
 */
import { parseHit, readDays, recordHit, renderVisitsPage } from "../src/visits.js";

export async function POST(request: Request): Promise<Response> {
  const ua = request.headers.get("user-agent") ?? "";
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  let body: unknown = null;
  try {
    const text = await request.text();
    if (text.length <= 1000) body = JSON.parse(text);
  } catch {
    body = null;
  }
  const hit = parseHit(body, ua);
  if (hit) await recordHit(hit, ip, ua);
  return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
}

export async function GET(): Promise<Response> {
  return new Response(renderVisitsPage(await readDays(30)), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

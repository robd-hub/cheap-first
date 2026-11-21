/**
 * The visit counter's two handlers, served by api/stats.ts so the deployment
 * stays within the Hobby plan's 12-function limit. vercel.json rewrites
 * /api/hit to /api/stats?visits=1 and /visits to /api/stats?visits=page.
 *
 * POST: one page view from a site beacon (src/visits.ts), sent as text/plain
 * so browsers don't need a CORS preflight. GET: the visits page.
 */
import { parseHit, readDays, recordHit, renderVisitsPage } from "./visits.js";

export async function hitPost(request: Request): Promise<Response> {
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

export async function visitsPage(): Promise<Response> {
  return new Response(renderVisitsPage(await readDays(30)), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

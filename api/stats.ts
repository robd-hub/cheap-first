/**
 * GET /stats and GET /api/stats
 *
 * Public aggregate counters. Browsers (Accept: text/html) get the page.
 * Everyone else gets JSON. `?format=json` and `?format=html` force one.
 * vercel.json rewrites /stats to this function.
 *
 * The body is totals only. See src/liveStats.ts.
 */
import { hitPost, visitsPage } from "../src/hitHandler.js";
import { readLive, renderStatsJson, renderStatsPage, wantsHtml } from "../src/liveStats.js";

/** Visit beacons (rewritten from /api/hit). */
export async function POST(request: Request): Promise<Response> {
  if (new URL(request.url).searchParams.get("visits")) return hitPost(request);
  return new Response("Not found", { status: 404 });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get("visits")) return visitsPage();
  const snapshot = await readLive();
  if (wantsHtml(request.headers.get("accept"), url.searchParams.get("format"))) {
    return new Response(renderStatsPage(snapshot), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new Response(renderStatsJson(snapshot), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** Uptime checkers (UptimeRobot) send HEAD: answer with GET's status and headers, no body. */
export async function HEAD(request: Request): Promise<Response> {
  const res = await GET(request);
  return new Response(null, { status: res.status, headers: res.headers });
}

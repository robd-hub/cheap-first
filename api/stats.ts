/**
 * GET /stats and GET /api/stats
 *
 * Public aggregate counters. Browsers (Accept: text/html) get the page.
 * Everyone else gets JSON. `?format=json` and `?format=html` force one.
 * vercel.json rewrites /stats to this function.
 *
 * The body is totals only. See src/liveStats.ts.
 */
import { readLive, renderStatsJson, renderStatsPage, wantsHtml } from "../src/liveStats.js";

export async function GET(request: Request): Promise<Response> {
  const snapshot = await readLive();
  const url = new URL(request.url);
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

/**
 * GET /.well-known/x402 (rewritten here in vercel.json)
 *
 * Lists the paid endpoints for x402 directories such as x402scan, which read
 * this file when someone adds the site, then probe each endpoint for its 402.
 * The addresses use whichever domain the request came in on.
 */
export function GET(request: Request): Response {
  const origin = new URL(request.url).origin;
  return new Response(
    JSON.stringify({
      version: 1,
      resources: [`${origin}/api/pay`, `${origin}/api/v1/chat/completions`],
      instructions: "Cheap First answers with a cheap model, checks the answer with SERV Reasoning, and only pays for a premium model when the check fails. POST {\"question\": \"...\"} to /api/pay, or use /api/v1/chat/completions as an OpenAI-compatible endpoint. Pay per answer in USDC on Base with x402.",
    }),
    { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } },
  );
}

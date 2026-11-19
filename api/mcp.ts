/**
 * POST /api/mcp   (also https://cheap-first.vercel.app/mcp)
 *
 * Streamable HTTP MCP endpoint. Tools:
 *   ask_cheap_first    one question, free within the demo limits, or paid
 *                      with a prepaid key or x402 (see src/mcpAnswer.ts)
 *   cheap_first_stats  the published benchmark numbers
 *
 * Stateless on purpose: a Vercel function has no session to keep.
 */
import { handleMcpRequest, type McpDeps } from "../src/mcp.js";
import { answerFree, answerPaid } from "../src/mcpAnswer.js";
import { loadBenchmarkReport } from "../src/stats.js";

const deps: McpDeps = {
  answerFree,
  answerPaid,
  stats: loadBenchmarkReport,
};

function handle(request: Request): Promise<Response> | Response {
  return handleMcpRequest(request, deps);
}

export function OPTIONS(request: Request): Promise<Response> | Response {
  return handle(request);
}

export function GET(request: Request): Promise<Response> | Response {
  return handle(request);
}

export function POST(request: Request): Promise<Response> | Response {
  return handle(request);
}

export function DELETE(request: Request): Promise<Response> | Response {
  return handle(request);
}

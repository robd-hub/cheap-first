/**
 * Cheap First as a remote MCP server (Streamable HTTP).
 *
 * Two tools: ask_cheap_first and cheap_first_stats. Asking goes through the
 * same doors as the rest of the API. With no key and no payment it is the
 * free demo (src/limits.ts, the demo premium budget). A prepaid key
 * (Authorization: Bearer cf_...) or an x402 payment is the paid endpoint
 * (src/paid.ts). Nothing here calls the models itself.
 *
 * The transport is stateless: one JSON-RPC message per POST, no session id,
 * and no server-sent event stream. That fits a Vercel function.
 */
import { modeFrom, type Mode } from "./cheapFirst.js";
import { isApiKey } from "./keys.js";
import { DEMO_MAX_QUESTION, PAID_MAX_QUESTION } from "./limits.js";
import type { StatsReport } from "./stats.js";
import { paymentFrom } from "./x402.js";

export const MCP_PATH = "/mcp";
export const SERVER_VERSION = "0.1.0";
/** Newest first. initialize echoes the client's version when it's in this list. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

/** Sent by an x402 client that wants the paid tier and its 402 challenge. */
export const PAID_HEADER = "X-Cheap-First-Paid";

export const MCP_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID, X-PAYMENT, PAYMENT-SIGNATURE, X-Cheap-First-Paid",
  "Access-Control-Expose-Headers": "MCP-Protocol-Version, X-PAYMENT-RESPONSE, PAYMENT-REQUIRED, PAYMENT-RESPONSE",
};

const INSTRUCTIONS =
  "Cheap First answers with Dolphin's cheap model, has SERV Reasoning score the answer, and calls a premium model only when that score misses the pass mark. " +
  "Use ask_cheap_first for a question and cheap_first_stats for the published benchmark. " +
  "Free calls share the public demo limits: 600 characters, 10 an hour from one IP, 300 a day, and the demo's daily premium budget. " +
  "A prepaid key (Authorization: Bearer cf_...) uses the paid API, one credit per answer. " +
  `An x402 payment of $0.005 USDC on Base does too: send ${PAID_HEADER}: 1 and the endpoint replies 402 with the usual challenge. ` +
  "mode is strict (pass mark 85), balanced (75, the default) or budget (60).";

export type JsonRpcId = string | number | null;

export interface AskPayload {
  answer: string;
  escalated: boolean;
  checkScore: number;
  costUsd: number;
  savedUsd: number;
  answeredBy: "cheap" | "premium";
  model: string;
  mode: Mode;
  checkReason: string;
}

export type AnswerOutcome = { ok: true; payload: AskPayload } | { ok: false; message: string };

export interface McpDeps {
  /** Free demo. Must enforce the demo rate limits and premium budget. */
  answerFree(request: Request, question: string, mode: Mode): Promise<AnswerOutcome>;
  /**
   * Paid path. Returns the HTTP response itself, because a missing x402
   * payment is a 402 challenge rather than a tool result.
   */
  answerPaid(request: Request, id: JsonRpcId, question: string, mode: Mode): Promise<Response>;
  stats(): StatsReport;
}

const askOutputSchema = {
  type: "object",
  description: "One Cheap First answer, plus what the check decided and what it cost.",
  properties: {
    answer: { type: "string", description: "The answer to give the user." },
    escalated: { type: "boolean", description: "True when the check failed and the premium model answered instead." },
    checkScore: { type: "number", description: "The checker's score for the cheap answer, from 0 to 100." },
    costUsd: { type: "number", description: "What Cheap First spent on this call, in US dollars." },
    savedUsd: { type: "number", description: "Estimated saving against sending the question to the premium model alone. Can be negative when an escalation cost more than that." },
    answeredBy: { type: "string", enum: ["cheap", "premium"], description: "cheap is Dolphin. premium is the frontier model." },
    model: { type: "string", description: "Label of the model that produced the answer." },
    mode: { type: "string", enum: ["strict", "balanced", "budget"] },
    checkReason: { type: "string", description: "The checker's one-line reason." },
    tier: { type: "string", enum: ["free", "paid"] },
    paidUsd: { type: "number", description: "What the caller paid, on the paid tier." },
    creditsLeft: { type: "number", description: "Prepaid answers left on the key, when one was used." },
    transaction: { type: "string", description: "x402 settlement transaction, when there is one." },
  },
  required: ["answer", "escalated", "checkScore", "costUsd", "savedUsd"],
};

export const TOOLS = [
  {
    name: "ask_cheap_first",
    title: "Ask Cheap First",
    description:
      "Answer a question the Cheap First way: Dolphin answers, SERV Reasoning scores it, and a premium model answers instead only if the score misses the pass mark. " +
      "Returns the answer, whether it escalated, the check score, the cost and the estimated saving. " +
      `Free calls use the public demo limits (${DEMO_MAX_QUESTION} characters, 10 an hour per IP, 300 a day). ` +
      `Send Authorization: Bearer cf_... or an x402 payment of $0.005 USDC on Base for the paid limits (${PAID_MAX_QUESTION} characters). ` +
      `To receive the x402 challenge, send the header ${PAID_HEADER}: 1. ` +
      "mode: strict escalates more often (pass mark 85), balanced is the default (75), budget escalates less often (60).",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: `The question. ${DEMO_MAX_QUESTION} characters on the free demo, ${PAID_MAX_QUESTION} when paid.` },
        mode: { type: "string", enum: ["strict", "balanced", "budget"], description: "strict, balanced (default) or budget. Unknown values are treated as balanced." },
      },
      required: ["question"],
    },
    outputSchema: askOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "cheap_first_stats",
    title: "Cheap First benchmark",
    description:
      "Published benchmark figures. The main run is 143 questions: what Cheap First spent, what the premium model alone would have cost, how many Dolphin answered, and the average quality scores. Also includes the harder 97-question run. Does not call a model.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        benchmark: { type: "object", description: "The main benchmark, with costs rounded to cents the way the site quotes them, plus exactUsd." },
        hardBenchmark: { type: ["object", "null"], description: "The harder benchmark graded by code, or null if it was not built." },
        resultsPage: { type: "string" },
      },
      required: ["benchmark", "hardBenchmark", "resultsPage"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const;

/** A paid call: a prepaid key, an x402 payment header, or an explicit request for the 402 challenge. */
export function wantsPaidTier(request: Request): boolean {
  if (paymentFrom(request)) return true;
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(\S+)$/i);
  if (bearer && isApiKey(bearer[1])) return true;
  const flag = request.headers.get(PAID_HEADER);
  return flag === "1" || flag?.toLowerCase() === "true";
}

/**
 * DNS rebinding matters for a server on a private interface. This deployment
 * is public, so a public Host accepts any Origin (browsers and MCP clients).
 * A private Host only accepts a private Origin, or no Origin at all.
 */
function requestHost(request: Request): string {
  // Host is a forbidden header in some runtimes, so fall back to the URL.
  return request.headers.get("host") || request.headers.get("x-forwarded-host")?.split(",")[0].trim() || new URL(request.url).host;
}

export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = requestHost(request);
  if (!isPrivateHost(host)) return true;
  try {
    return isPrivateHost(new URL(origin).host);
  } catch {
    return false;
  }
}

function isPrivateHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (name === "localhost" || name === "127.0.0.1" || name === "::1" || name === "0.0.0.0") return true;
  if (/^10\./.test(name) || /^192\.168\./.test(name) || /^169\.254\./.test(name)) return true;
  const match = /^172\.(\d+)\./.exec(name);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

interface Accept {
  json: boolean;
  sse: boolean;
}

function acceptOf(request: Request): Accept {
  const header = request.headers.get("accept");
  if (!header) return { json: true, sse: false };
  const types = header.split(",").map((part) => part.split(";")[0].trim().toLowerCase());
  const any = types.includes("*/*") || types.includes("*");
  return { json: any || types.includes("application/json"), sse: types.includes("text/event-stream") };
}

export function toolResult(payload: unknown): { content: { type: "text"; text: string }[]; structuredContent: unknown; isError: false } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

export function toolErrorResult(message: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...MCP_CORS, "Cache-Control": "no-store", ...extra };
}

/** Adds the MCP CORS headers to a response another module already built (a 402, for example). */
export function withMcpCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(MCP_CORS)) headers.set(key, value);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function rpcResponse(request: Request, id: JsonRpcId | undefined, body: Record<string, unknown>, status: number, extra: Record<string, string> = {}): Response {
  const accept = acceptOf(request);
  const payload = id === undefined ? body : { ...body, id };
  // Only a successful reply may be an SSE stream. Errors keep their HTTP status
  // (405 for GET, 400 for a bad protocol version) so clients can follow the spec.
  if (status === 200 && accept.sse && !accept.json) {
    const sse = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    return new Response(sse, { status: 200, headers: corsHeaders({ "Content-Type": "text/event-stream", ...extra }) });
  }
  return new Response(JSON.stringify(payload), { status, headers: corsHeaders({ "Content-Type": "application/json", ...extra }) });
}

export function rpcOk(request: Request, id: JsonRpcId, result: unknown, extra: Record<string, string> = {}): Response {
  return rpcResponse(request, id, { jsonrpc: "2.0", result }, 200, extra);
}

function rpcError(request: Request, id: JsonRpcId | undefined, code: number, message: string, status = 200, extra: Record<string, string> = {}): Response {
  return rpcResponse(request, id, { jsonrpc: "2.0", error: { code, message } }, status, extra);
}

function accepted(): Response {
  return new Response(null, { status: 202, headers: corsHeaders() });
}

function initializeResult(params: unknown): Record<string, unknown> {
  const requested = params && typeof params === "object" ? (params as { protocolVersion?: unknown }).protocolVersion : undefined;
  const protocolVersion = typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: {
      name: "cheap-first",
      title: "Cheap First",
      version: SERVER_VERSION,
      websiteUrl: "https://cheap-first.vercel.app",
    },
    instructions: INSTRUCTIONS,
  };
}

/** Why a Bearer token cannot be used, or null when the header is fine (including when it is absent). */
function authorizationIssue(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match) return "Authorization must be a Bearer token (Bearer cf_...). Omit it for the free demo.";
  if (isApiKey(match[1]) || paymentFrom(request)) return null;
  return "That isn't a Cheap First prepaid key. Send Bearer cf_..., or omit Authorization for the free demo.";
}

async function ask(request: Request, id: JsonRpcId, args: Record<string, unknown>, deps: McpDeps): Promise<Response> {
  const issue = authorizationIssue(request);
  if (issue) return rpcOk(request, id, toolErrorResult(issue));
  if (typeof args.question !== "string") return rpcOk(request, id, toolErrorResult("question must be a string."));
  const question = args.question.trim();
  if (!question) return rpcOk(request, id, toolErrorResult("Include a question."));
  const mode = modeFrom(args.mode);
  const paid = wantsPaidTier(request);
  const limit = paid ? PAID_MAX_QUESTION : DEMO_MAX_QUESTION;
  if (question.length > limit) {
    const message = paid
      ? `Keep it under ${PAID_MAX_QUESTION} characters.`
      : `Free questions stay under ${DEMO_MAX_QUESTION} characters, the same as the public demo. A prepaid key (Authorization: Bearer cf_...) or $0.005 over x402 allows ${PAID_MAX_QUESTION}. Send the header ${PAID_HEADER}: 1 to get the payment challenge.`;
    return rpcOk(request, id, toolErrorResult(message));
  }
  if (paid) return withMcpCors(await deps.answerPaid(request, id, question, mode));
  const outcome = await deps.answerFree(request, question, mode);
  if (!outcome.ok) return rpcOk(request, id, toolErrorResult(outcome.message));
  return rpcOk(request, id, toolResult({ ...outcome.payload, tier: "free" }));
}

async function callTool(request: Request, id: JsonRpcId, params: unknown, deps: McpDeps): Promise<Response> {
  if (!params || typeof params !== "object" || typeof (params as { name?: unknown }).name !== "string") {
    return rpcError(request, id, -32602, "tools/call needs a tool name.");
  }
  const name = (params as { name: string }).name;
  const rawArgs = (params as { arguments?: unknown }).arguments ?? {};
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return rpcError(request, id, -32602, "Tool arguments must be an object.");
  }
  if (name === "cheap_first_stats") {
    try {
      return rpcOk(request, id, toolResult(deps.stats()));
    } catch (e) {
      console.error(e);
      return rpcOk(request, id, toolErrorResult("The benchmark numbers couldn't be read."));
    }
  }
  if (name !== "ask_cheap_first") return rpcError(request, id, -32602, `Unknown tool: ${name}.`);
  return ask(request, id, rawArgs as Record<string, unknown>, deps);
}

async function dispatch(request: Request, method: string, params: unknown, id: JsonRpcId, deps: McpDeps): Promise<Response> {
  switch (method) {
    case "initialize":
      return rpcOk(request, id, initializeResult(params));
    case "ping":
    case "logging/setLevel":
      return rpcOk(request, id, {});
    case "tools/list":
      return rpcOk(request, id, { tools: TOOLS });
    case "tools/call":
      return callTool(request, id, params, deps);
    default:
      return rpcError(request, id, -32601, `Method not found: ${method}.`);
  }
}

/**
 * One Streamable HTTP request. `deps.answerFree` and `deps.answerPaid` are
 * the only ways a question reaches a model.
 */
export async function handleMcpRequest(request: Request, deps: McpDeps): Promise<Response> {
  if (!originAllowed(request)) {
    return rpcError(request, undefined, -32600, "Origin not allowed.", 403);
  }
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (method === "GET") return rpcError(request, undefined, -32600, "Cheap First MCP has no server event stream. POST JSON-RPC messages here.", 405, { Allow: "POST, DELETE, OPTIONS" });
  if (method === "DELETE") return rpcError(request, undefined, -32600, "This server does not keep sessions.", 405, { Allow: "POST, DELETE, OPTIONS" });
  if (method !== "POST") return rpcError(request, undefined, -32600, "POST JSON-RPC messages here.", 405, { Allow: "POST, DELETE, OPTIONS" });

  const version = request.headers.get("mcp-protocol-version");
  if (version && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return rpcError(request, null, -32600, `Unsupported MCP-Protocol-Version: ${version}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`, 400);
  }
  const accept = acceptOf(request);
  if (!accept.json && !accept.sse) {
    return rpcError(request, null, -32600, "Send Accept: application/json, text/event-stream.", 406);
  }
  const contentType = request.headers.get("content-type");
  if (contentType && !contentType.toLowerCase().includes("json")) {
    return rpcError(request, null, -32600, "POST a JSON-RPC message with Content-Type: application/json.", 415);
  }

  let raw = "";
  try {
    raw = await request.text();
  } catch {
    return rpcError(request, null, -32700, "Could not read the body.", 400);
  }
  if (raw.length > 65_536) return rpcError(request, null, -32600, "That message is too large.", 400);

  let message: unknown;
  try {
    message = raw ? JSON.parse(raw) : null;
  } catch {
    return rpcError(request, null, -32700, "Parse error.", 400);
  }
  if (Array.isArray(message) || !message || typeof message !== "object") {
    return rpcError(request, null, -32600, "Expected one JSON-RPC message.", 400);
  }
  const msg = message as { jsonrpc?: unknown; method?: unknown; id?: unknown; params?: unknown; result?: unknown; error?: unknown };
  if (msg.jsonrpc !== "2.0") return rpcError(request, idOf(msg.id), -32600, "Invalid Request.", 400);
  // A client notification, or a response to a server request we never send.
  if (typeof msg.method !== "string") return accepted();
  if (!Object.prototype.hasOwnProperty.call(msg, "id")) return accepted();

  try {
    return await dispatch(request, msg.method, msg.params, idOf(msg.id), deps);
  } catch (e) {
    console.error(e);
    return rpcError(request, idOf(msg.id), -32603, "Something went wrong.", 500);
  }
}

function idOf(id: unknown): JsonRpcId {
  return typeof id === "string" || typeof id === "number" ? id : null;
}

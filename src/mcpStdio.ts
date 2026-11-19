/**
 * stdio bridge for MCP clients that can only launch a local process
 * (older Claude Desktop configs, for example).
 *
 * Each stdin line is one JSON-RPC message. It is posted to the hosted
 * Cheap First MCP endpoint and the response is written to stdout. The
 * models, the demo limits and payments all stay on that server: this
 * process never calls them.
 *
 *   CHEAP_FIRST_API_KEY   optional prepaid key, sent as Authorization: Bearer cf_...
 *   CHEAP_FIRST_MCP_URL   default https://cheap-first.vercel.app/mcp
 *   CHEAP_FIRST_PAID      set to 1 to ask the server for an x402 challenge
 *
 * Run from a checkout: npm run mcp
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PAID_HEADER, SUPPORTED_PROTOCOL_VERSIONS } from "./mcp.js";

const DEFAULT_URL = "https://cheap-first.vercel.app/mcp";

export function mcpUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CHEAP_FIRST_MCP_URL || DEFAULT_URL).trim().replace(/\/$/, "");
}

export function mcpHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": SUPPORTED_PROTOCOL_VERSIONS[0],
  };
  const key = env.CHEAP_FIRST_API_KEY?.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  if (env.CHEAP_FIRST_PAID === "1" || env.CHEAP_FIRST_PAID?.toLowerCase() === "true") headers[PAID_HEADER] = "1";
  return headers;
}

interface Posted {
  status: number;
  text: string;
}

/** Pulls a JSON value out of a plain body or an SSE `data:` line. */
function jsonBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const data = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.startsWith("{"));
  const last = data.at(-1);
  return last ? JSON.parse(last) : null;
}

function messageId(message: unknown): string | number | null {
  if (!message || typeof message !== "object" || !("id" in message)) return null;
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function rpcError(id: string | number | null, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } });
}

/**
 * Forwards one stdin line. Returns the stdout line, or null when the server
 * accepted a notification and there is nothing to write (HTTP 202).
 */
export async function forwardLine(line: string, post: (body: string) => Promise<Posted>): Promise<string | null> {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const id = messageId(message);
  let posted: Posted;
  try {
    posted = await post(trimmed);
  } catch (e) {
    console.error(`Cheap First MCP bridge: ${(e as Error).message}`);
    return rpcError(id, "Couldn't reach the Cheap First MCP server.");
  }
  if (posted.status === 202) return null;
  let body: unknown;
  try {
    body = jsonBody(posted.text);
  } catch {
    return rpcError(id, `Cheap First returned HTTP ${posted.status}, and the body wasn't JSON.`);
  }
  if (body && typeof body === "object" && "jsonrpc" in body && ("result" in body || "error" in body)) return JSON.stringify(body);
  const detail = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `HTTP ${posted.status}`;
  return rpcError(id, detail);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

async function main(): Promise<void> {
  const { createInterface } = await import("node:readline");
  const url = mcpUrl();
  const headers = mcpHeaders();
  console.error(`Cheap First MCP bridge → ${url}`);
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const out = await forwardLine(line, async (body) => {
      const res = await fetch(url, { method: "POST", headers, body });
      return { status: res.status, text: await res.text() };
    });
    if (out !== null) process.stdout.write(`${out}\n`);
  }
}

if (isDirectRun()) main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

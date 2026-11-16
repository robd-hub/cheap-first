/**
 * Lets this app answer as an agent on the OpenServ marketplace
 * (platform.openserv.ai), without running a long-lived server.
 *
 * OpenServ talks to an agent over three HTTP calls, the same ones its
 * TypeScript SDK (@openserv-labs/sdk) serves with Express:
 *   GET  <endpoint>/health            -> {"status": "ok"}
 *   POST <endpoint>                   an "action": a task to do ("do-task") or a
 *                                     chat to answer ("respond-chat-message").
 *                                     We hand it to the OpenServ runtime with our
 *                                     tools, and reply at once; the runtime then
 *                                     calls our tools and finishes the task.
 *   POST <endpoint>/tools/<name>      {"args": {...}, "action": {...}} -> {"result": "..."}
 *
 * Secrets (set in Vercel after the agent is created, see docs/openserv.md):
 *   OPENSERV_API_KEY     the agent's own key, sent to the runtime
 *   OPENSERV_AUTH_TOKEN  optional; when set, only requests carrying OpenServ's
 *                        bcrypt hash of it (x-openserv-auth-token) are served
 */
import bcrypt from "bcryptjs";

const RUNTIME_URL = (process.env.OPENSERV_RUNTIME_URL || "https://agents.openserv.ai").replace(/\/$/, "");

/** One thing the agent can do. `schema` is a JSON Schema for `args`. */
export interface Capability {
  name: string;
  description: string;
  schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run(args: Record<string, unknown>, action: unknown): Promise<string>;
}

export interface AgentSpec {
  systemPrompt: string;
  capabilities: Capability[];
}

interface Action {
  type?: string;
  task?: { description?: string };
  messages?: { author?: string; message?: string }[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** True if the request is from OpenServ (or no auth token is set). */
export async function authorised(request: Request): Promise<boolean> {
  const token = process.env.OPENSERV_AUTH_TOKEN;
  if (!token) return true;
  const hash = request.headers.get("x-openserv-auth-token");
  if (!hash) return false;
  try {
    return await bcrypt.compare(token, hash);
  } catch {
    return false;
  }
}

/** What the SDK sends the runtime: the conversation so far and our tools. */
export function runtimeRequest(spec: AgentSpec, action: Action): { path: "/execute" | "/chat"; body: unknown } | null {
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [{ role: "system", content: spec.systemPrompt }];
  let path: "/execute" | "/chat";
  if (action.type === "do-task") {
    path = "/execute";
    if (action.task?.description) messages.push({ role: "user", content: action.task.description });
  } else if (action.type === "respond-chat-message") {
    path = "/chat";
    for (const m of action.messages ?? []) messages.push({ role: m.author === "user" ? "user" : "assistant", content: String(m.message ?? "") });
  } else {
    return null;
  }
  const tools = spec.capabilities.map((c) => ({ name: c.name, description: c.description, schema: { ...c.schema, additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" } }));
  return { path, body: { tools, runtimeTools: [], messages, action } };
}

async function callRuntime(path: string, body: unknown): Promise<void> {
  const key = process.env.OPENSERV_API_KEY;
  if (!key) {
    console.error("OpenServ action received, but OPENSERV_API_KEY isn't set.");
    return;
  }
  const res = await fetch(`${RUNTIME_URL}/runtime${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-openserv-key": key },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`OpenServ runtime ${path} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/**
 * Serves one OpenServ request. `sub` is the part of the path after the
 * agent's endpoint: "" for actions, "health", or "tools/<name>".
 * `background` keeps the runtime call alive after we reply (Vercel's waitUntil).
 */
export async function handleOpenServ(request: Request, sub: string, spec: AgentSpec, background: (p: Promise<unknown>) => void): Promise<Response> {
  sub = sub.replace(/^\/+|\/+$/g, "");
  if (request.method === "GET") {
    if (sub === "" || sub === "health") return json({ status: "ok", agent: true, capabilities: spec.capabilities.map((c) => c.name) });
    return json({ error: "Not found", path: sub }, 404);
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!(await authorised(request))) return json({ error: "Unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Send JSON." }, 400);
  }

  const tool = sub.match(/^tools\/([^/]+)$/)?.[1];
  if (tool) {
    const cap = spec.capabilities.find((c) => c.name === decodeURIComponent(tool));
    if (!cap) return json({ error: `Tool "${tool}" not found` }, 400);
    if (!body.action) return json({ error: "Action context is required for tool execution" }, 400);
    const args = (body.args && typeof body.args === "object" ? body.args : {}) as Record<string, unknown>;
    for (const r of cap.schema.required ?? []) {
      if (args[r] === undefined || args[r] === "") return json({ error: `Missing "${r}"` }, 400);
    }
    try {
      return json({ result: await cap.run(args, body.action) });
    } catch (e) {
      console.error(e);
      return json({ error: (e as Error).message || "Tool failed" }, 500);
    }
  }

  if (sub !== "") {
    console.error(`OpenServ POST to unknown path "${sub}" (${request.url})`);
    return json({ error: "Not found", path: sub }, 404);
  }
  const call = runtimeRequest(spec, body as Action);
  if (!call) return json({ error: "Invalid action type" }, 400);
  background(callRuntime(call.path, call.body).catch((e) => console.error(e)));
  return json({ accepted: true });
}

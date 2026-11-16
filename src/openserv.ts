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
  /**
   * Optional: answer every task and chat message ourselves instead of letting
   * OpenServ's runtime model decide whether to call our tools (it sometimes
   * answers on its own and skips them). Gets the request text, returns the reply.
   */
  direct?: (request: string) => Promise<string>;
}

interface Action {
  type?: string;
  me?: { id?: number };
  workspace?: { id?: number | string };
  explicitInput?: unknown;
  triggerEvents?: { payload?: unknown }[];
  task?: { id?: number | string; description?: string; body?: string | null; input?: string | null; triggerEvent?: { payload?: unknown } | null; outputOptions?: Record<string, unknown> | null };
  messages?: { author?: string; message?: string }[];
}

const PLATFORM_URL = (process.env.OPENSERV_API_URL || "https://api.openserv.ai").replace(/\/$/, "");
const REQUEST_FIELDS = ["question", "prompt", "query", "message", "input", "text"];

/** The first request-like string field in a trigger payload or task input. */
function fieldIn(value: unknown, depth = 0): string | null {
  if (depth > 3 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("{")) {
      try {
        return fieldIn(JSON.parse(t), depth + 1);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  for (const k of REQUEST_FIELDS) if (typeof obj[k] === "string" && (obj[k] as string).trim()) return (obj[k] as string).trim();
  for (const v of Object.values(obj)) {
    const found = fieldIn(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/** What a task asks for: the caller's own input if there is one, else the task text. */
export function taskRequest(action: Action): string {
  const t = action.task ?? {};
  const fromInput =
    fieldIn(action.explicitInput) ?? fieldIn(t.triggerEvent?.payload) ?? fieldIn(action.triggerEvents?.map((e) => e.payload)) ?? fieldIn(t.input);
  if (fromInput) return fromInput;
  return [t.description, t.body, t.input].filter((x) => x && String(x).trim()).filter((x, i, a) => a.indexOf(x) === i).join("\n\n");
}

async function platform(method: "PUT" | "POST", path: string, body: unknown): Promise<void> {
  const res = await fetch(`${PLATFORM_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-openserv-key": process.env.OPENSERV_API_KEY ?? "" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`OpenServ ${method} ${path} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** Answers a task or chat message with spec.direct and hands the reply back to OpenServ. */
async function answerDirectly(spec: AgentSpec, action: Action): Promise<void> {
  const ws = action.workspace?.id;
  if (!ws || !process.env.OPENSERV_API_KEY) {
    console.error("OpenServ action without a workspace, or OPENSERV_API_KEY isn't set.");
    return;
  }
  if (action.type === "do-task") {
    const taskId = action.task?.id;
    try {
      const output = await spec.direct!(taskRequest(action));
      // OpenServ wants the output as {type, value} under one of the task's output options.
      const outputOptionId = Object.keys(action.task?.outputOptions ?? {})[0] ?? "default";
      await platform("PUT", `/workspaces/${ws}/tasks/${taskId}/complete`, { outputOptionId, output: { type: "text", value: output } });
    } catch (e) {
      console.error(e);
      await platform("POST", `/workspaces/${ws}/tasks/${taskId}/error`, { error: (e as Error).message || "Cheap First couldn't answer" });
    }
    return;
  }
  const last = [...(action.messages ?? [])].reverse().find((m) => m.author === "user")?.message ?? "";
  let reply: string;
  try {
    reply = last.trim() ? await spec.direct!(last) : "Ask me a question and I'll answer it.";
  } catch (e) {
    console.error(e);
    reply = "Sorry, I couldn't answer that just now. Please try again.";
  }
  await platform("POST", `/workspaces/${ws}/agent-chat/${action.me?.id}/message`, { message: reply });
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
  console.log(`OpenServ POST "${sub}"`);
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
  if (spec.direct) background(answerDirectly(spec, body as Action).catch((e) => console.error(e)));
  else background(callRuntime(call.path, call.body).catch((e) => console.error(e)));
  return json({ accepted: true });
}

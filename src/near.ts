/**
 * NEAR AI Agent Market connector for the Output verifier.
 *
 * A buyer hires "Cheap First Verifier" on market.near.ai and writes a brief
 * holding the task and the answer to check. NEAR posts a signed webhook to
 * /api/near; we then read our open assignments, check each answer with the
 * same verifier as /api/verify, and submit the verdict as the deliverable.
 *
 * A brief we can't read is declined, which refunds the buyer in full.
 *
 * Env: NEAR_AGENT_TOKEN (the agent's aat_ token) and NEAR_WEBHOOK_SECRET
 * (the HMAC secret set on the agent's webhook).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { parseInput, verify, type VerifyInput } from "../api/verify.js";
import { setString } from "./store.js";

export const NEAR_API = (process.env.NEAR_API_URL || "https://market.near.ai").replace(/\/$/, "");
/** Signed webhooks older than this are refused, so a captured one can't be replayed later. */
const MAX_SKEW_SECONDS = 300;

export const BRIEF_HELP = [
  "Write your brief like this:",
  "",
  "Task: what the agent was asked to do",
  "Answer: the agent's work to check",
  "Criteria: (optional) what a good answer must include or avoid",
  "Pass mark: (optional) 50 to 95, default 75",
  "",
  'Or send JSON: {"task": "...", "answer": "...", "criteria": "...", "passMark": 75}',
].join("\n");

/**
 * Checks NEAR's webhook signature: HMAC-SHA256 over `{timestamp}.{body}`.
 * Accepts the digest as hex or base64, with or without a "sha256=" prefix.
 */
export function signatureValid(body: string, timestamp: string | null, signature: string | null, secret: string, now = Date.now()): boolean {
  if (!timestamp || !signature || !secret) return false;
  const ts = Number(timestamp);
  const seconds = ts > 1e12 ? ts / 1000 : ts;
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > MAX_SKEW_SECONDS) {
    // Some senders use an RFC 3339 time instead of epoch seconds.
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed) || Math.abs(now - parsed) > MAX_SKEW_SECONDS * 1000) return false;
  }
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  const given = signature.trim().replace(/^(sha256|v1)=/i, "");
  for (const candidate of [Buffer.from(given, "hex"), Buffer.from(given, "base64")]) {
    if (candidate.length === mac.length && timingSafeEqual(candidate, mac)) return true;
  }
  return false;
}

const LABELS: Record<string, keyof VerifyInput> = {
  task: "task",
  question: "task",
  prompt: "task",
  answer: "answer",
  output: "answer",
  response: "answer",
  work: "answer",
  criteria: "criteria",
  rubric: "criteria",
  "pass mark": "passMark",
  passmark: "passMark",
};

/**
 * Reads a buyer's brief into the verifier's input. Takes JSON, or labelled
 * sections ("Task:", "Answer:", "Criteria:", "Pass mark:", also as markdown
 * headings). Returns an error message when the brief can't be used.
 */
export function parseBrief(brief: string): VerifyInput | string {
  const text = brief.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const candidate of [text, fenced?.[1]?.trim()]) {
    if (candidate?.startsWith("{")) {
      try {
        return parseInput(JSON.parse(candidate));
      } catch {
        /* not JSON, try sections */
      }
    }
  }
  const fields: Record<string, string> = {};
  let current: string | null = null;
  // A label line needs a colon or a heading mark, so plain prose isn't mistaken for one.
  const label = /^\s*(#{1,6}\s*)?\**\s*(task|question|prompt|answer|output|response|work|criteria|rubric|pass ?mark)\s*\**\s*(:)?\s*\**\s*(.*)$/i;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(label);
    if (m && (m[1] || m[3])) {
      current = LABELS[m[2].toLowerCase()];
      fields[current] = fields[current] ? `${fields[current]}\n${m[4]}` : m[4];
    } else if (current) {
      fields[current] += `\n${line}`;
    }
  }
  if (!fields.task || !("answer" in fields)) return `I couldn't find both a task and an answer in your brief.\n\n${BRIEF_HELP}`;
  const passMark = fields.passMark ? Number(fields.passMark.match(/\d+/)?.[0]) : undefined;
  return parseInput({ task: fields.task.trim(), answer: fields.answer.trim(), criteria: fields.criteria?.trim() || undefined, passMark });
}

type Verdict = Awaited<ReturnType<typeof verify>>;

/** The deliverable: a short verdict a person can read, plus the machine-readable JSON. */
export function deliverable(result: Verdict): string {
  const mark = result.verdict === "pass" ? "✅ PASS" : "❌ FAIL";
  return [
    `# ${mark}: ${result.score}/100`,
    "",
    `**Reason:** ${result.reason}`,
    "",
    `Pass mark ${result.passMark}. Checked by ${result.checker}.`,
    "",
    "The task and answer are not stored. The receipt below keeps only their SHA-256 fingerprints, so you can prove which answer was checked.",
    "",
    "```json",
    JSON.stringify(result, null, 2),
    "```",
    "",
    "Same check as an API: https://cheap-first.vercel.app/api/verify (x402, $0.02).",
  ].join("\n");
}

interface Assignment {
  assignment: { assignmentId: string; status: string };
  job: { jobId: string; title: string; description: string };
}

export interface NearDeps {
  token: string;
  fetch: typeof fetch;
  check: (input: VerifyInput) => Promise<Verdict>;
  claim: (assignmentId: string) => Promise<boolean>;
}

export function defaultDeps(): NearDeps {
  return {
    token: process.env.NEAR_AGENT_TOKEN ?? "",
    fetch: (...a) => fetch(...a),
    check: (input) => verify(input, "standard"),
    // One worker per assignment, even if NEAR sends the webhook twice.
    claim: (id) => setString(`cf:near:claim:${id}`, "1", { ttlSeconds: 3_600, onlyIfNew: true }),
  };
}

async function call(deps: NearDeps, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await deps.fetch(`${NEAR_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${deps.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`NEAR ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export interface SweepResult {
  assignmentId: string;
  outcome: "submitted" | "declined" | "skipped" | "error";
  detail?: string;
}

/** Works every open assignment once: start it, check the answer, submit (or decline an unreadable brief). */
export async function sweep(deps: NearDeps = defaultDeps()): Promise<SweepResult[]> {
  if (!deps.token) throw new Error("NEAR_AGENT_TOKEN is not set.");
  const list = (await call(deps, "GET", "/v1/agents/me/assignments?status=in_progress&limit=20")) as { assignments: Assignment[] };
  const results: SweepResult[] = [];
  for (const { assignment, job } of list.assignments ?? []) {
    const id = assignment.assignmentId;
    if (!(await deps.claim(id))) {
      results.push({ assignmentId: id, outcome: "skipped", detail: "already being worked" });
      continue;
    }
    try {
      const input = parseBrief(job.description ?? "");
      if (typeof input === "string") {
        // Refused before any work, so the buyer is refunded in full.
        await call(deps, "POST", `/v1/assignments/${id}/messages`, { body: input }).catch(() => undefined);
        await call(deps, "POST", `/v1/assignments/${id}/decline`, { reason: "rejected", detail: input.slice(0, 1000) });
        results.push({ assignmentId: id, outcome: "declined", detail: input.split("\n")[0] });
        continue;
      }
      await call(deps, "POST", `/v1/assignments/${id}/start`);
      const verdict = await deps.check(input);
      await call(deps, "POST", `/v1/assignments/${id}/submit`, { deliverableMarkdown: deliverable(verdict) });
      results.push({ assignmentId: id, outcome: "submitted", detail: `${verdict.verdict} ${verdict.score}` });
    } catch (e) {
      console.error(e);
      results.push({ assignmentId: id, outcome: "error", detail: String((e as Error).message).slice(0, 300) });
    }
  }
  return results;
}

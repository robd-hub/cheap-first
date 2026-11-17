/**
 * Output verifier: check a hired agent's work before you pay for it.
 *
 *   POST /api/verify         standard check (SERV's GPT-6 Luna), $0.02 with x402
 *   POST /api/verify/quick   quick check (Dolphin), $0.005 with x402
 *   POST /api/verify/free    quick check, free, a few a day per caller
 *
 * Body: {"task": "...", "answer": "...", "criteria": "...", "passMark": 75}
 * Reply: {"verdict": "pass" | "fail", "score", "reason", "passMark", "level",
 *         "checker", "receipt": {...}}
 *
 * The buyer's own code then pays the hired agent only on a pass. We never
 * hold anyone's money. The task and answer are not stored: the receipt keeps
 * only their SHA-256 fingerprints, so the buyer can prove which answer was
 * checked without anyone else seeing it.
 *
 * Payment is settled only after the verdict is ready, so a failed check is
 * never charged. Uses the same grader as Cheap First (src/cheapFirst.ts).
 */
import { createHash, randomUUID } from "node:crypto";
import { checkAnswer, PASS_MARK } from "../src/cheapFirst.js";
import { CHEAP, servModel, type ModelSpec } from "../src/models.js";
import { json, paidCall, PAID_CORS, unpaidChallenge } from "../src/paid.js";
import { incrBy } from "../src/store.js";
import type { Offer } from "../src/x402.js";

export type Level = "quick" | "standard";

/** Longest task and answer we'll check, to keep each check's cost bounded. */
const MAX_TASK = 6_000;
const MAX_ANSWER = 20_000;
/** Free quick checks per caller (by IP) per day, and for everyone together. */
const FREE_PER_IP = Number(process.env.CF_VERIFY_FREE_PER_IP) || 20;
const FREE_PER_DAY = Number(process.env.CF_VERIFY_FREE_PER_DAY) || 300;

const FIELDS = {
  task: { type: "string", required: true, description: "What the agent was asked to do, up to 6,000 characters" },
  answer: { type: "string", required: true, description: "The agent's work to check, up to 20,000 characters" },
  criteria: { type: "string", required: false, description: "Optional: what a good answer must include or avoid" },
  passMark: { type: "number", required: false, description: "Score needed to pass, 50 to 95. Default 75." },
};
const EXAMPLE = {
  body: { task: "List the three primary colours of light.", answer: "Red, green and blue.", passMark: 75 },
  output: {
    verdict: "pass",
    score: 97,
    reason: "Correct and complete.",
    passMark: 75,
    level: "standard",
    checker: "SERV · GPT-6 Luna",
    receipt: { id: "vr_…", issuedAt: "2026-11-18T00:00:00.000Z", taskSha256: "…", answerSha256: "…" },
  },
};
const OUTPUT = { verdict: "pass | fail", score: "number 0-100", reason: "string", passMark: "number", level: "string", checker: "string", receipt: "object" };

export const VERIFY_OFFERS: Record<Level, Offer> = {
  standard: {
    description: "Output verifier, standard: checks an AI agent's work against its task before you pay for it. Pass or fail, a 0-100 score and a one-line reason.",
    priceMicro: "20000",
    example: EXAMPLE,
    outputSchema: { input: { type: "http", method: "POST", bodyType: "json", bodyFields: FIELDS }, output: OUTPUT },
  },
  quick: {
    description: "Output verifier, quick: a fast, low-cost check of an AI agent's work before you pay for it. Pass or fail, a 0-100 score and a one-line reason.",
    priceMicro: "5000",
    example: { ...EXAMPLE, output: { ...EXAMPLE.output, level: "quick", checker: "Dolphin · DeepSeek V4.1 Flash" } },
    outputSchema: { input: { type: "http", method: "POST", bodyType: "json", bodyFields: FIELDS }, output: OUTPUT },
  },
};

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let standardChecker: ModelSpec | null = null;
async function checkerFor(level: Level): Promise<ModelSpec> {
  if (level === "quick") return { ...CHEAP, label: "Dolphin · DeepSeek V4.1 Flash" };
  standardChecker ??= await servModel("SERV · GPT-6 Luna", "gpt-6-luna");
  return standardChecker;
}

export interface VerifyInput {
  task: string;
  answer: string;
  criteria?: string;
  passMark: number;
}

/** Reads and checks the request body. Returns an error message instead when it isn't usable. */
export function parseInput(body: unknown): VerifyInput | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const task = String(b.task ?? "").trim();
  const answer = String(b.answer ?? "");
  const criteria = b.criteria === undefined ? undefined : String(b.criteria).trim().slice(0, 2_000) || undefined;
  const pm = b.passMark === undefined ? PASS_MARK : Number(b.passMark);
  if (!task) return 'Include "task": what the agent was asked to do.';
  if (!("answer" in b)) return 'Include "answer": the agent\'s work to check.';
  if (task.length > MAX_TASK) return `Keep "task" under ${MAX_TASK} characters.`;
  if (answer.length > MAX_ANSWER) return `Keep "answer" under ${MAX_ANSWER} characters.`;
  if (!Number.isFinite(pm) || pm < 50 || pm > 95) return '"passMark" must be a number from 50 to 95.';
  return { task, answer, criteria, passMark: Math.round(pm) };
}

/** Runs the check and builds the verdict. A blank answer fails without a model call. */
export async function verify(input: VerifyInput, level: Level, check = checkAnswer, now = new Date()) {
  const checker = await checkerFor(level);
  const result = input.answer.trim()
    ? await check(checker, input.task, input.answer, input.criteria)
    : { score: 0, reason: "The answer is empty.", call: { costUsd: 0 } };
  const verdict: "pass" | "fail" = result.score >= input.passMark ? "pass" : "fail";
  return {
    verdict,
    score: result.score,
    reason: result.reason,
    passMark: input.passMark,
    level,
    checker: checker.label,
    receipt: {
      id: `vr_${randomUUID()}`,
      issuedAt: now.toISOString(),
      taskSha256: sha256(input.task),
      answerSha256: sha256(input.answer),
      verdict,
      score: result.score,
      issuer: "Cheap First Output Verifier (cheap-first.vercel.app), with Agent Report Card",
    },
  };
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: PAID_CORS });
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("level") ?? "standard";
  const free = mode === "free";
  const level: Level = mode === "quick" || free ? "quick" : "standard";
  const offer = VERIFY_OFFERS[level];

  if (!free) {
    const unpaid = unpaidChallenge(request, offer);
    if (unpaid) return unpaid;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Send JSON like {"task": "...", "answer": "..."}.' }, 400);
  }
  const input = parseInput(body);
  if (typeof input === "string") return json({ error: input }, 400);

  if (free) {
    const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim().slice(0, 64);
    const day = new Date().toISOString().slice(0, 10);
    const [mine, all] = await Promise.all([incrBy(`cf:verify:ip:${ip}:${day}`, 1, 2 * 86_400), incrBy(`cf:verify:day:${day}`, 1, 2 * 86_400)]);
    if (mine > FREE_PER_IP || all > FREE_PER_DAY) {
      return json({ error: `That's today's free checks. Use /api/verify/quick ($0.005) or /api/verify ($0.02), paid with x402.` }, 429);
    }
    try {
      return json({ ...(await verify(input, level)), free: true }, 200);
    } catch (e) {
      console.error(e);
      return json({ error: "Couldn't reach the checker. Please try again." }, 502);
    }
  }

  return paidCall(request, offer, async () => {
    try {
      const result = await verify(input, level);
      return { respond: (paid, headers) => json({ ...result, paid }, 200, headers) };
    } catch (e) {
      console.error(e);
      return json({ error: "Couldn't reach the checker. You haven't been charged. Please try again." }, 502);
    }
  });
}

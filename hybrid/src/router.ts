/**
 * Cheap First, run in the browser.
 *
 * Firebase AI Logic's hybrid mode falls back to the cloud when this device
 * has no model. Cheap First adds a second reason to go to the cloud: the
 * answer the on-device model gave did not pass a check.
 *
 *   1. Gemini Nano answers on this device (PREFER_ON_DEVICE). With no local
 *      model, Firebase sends the question to the cloud and we stop there.
 *   2. The answer is checked, on this device where we can:
 *      - a number or a multiple-choice answer: a second local answer, solved
 *        from scratch, has to agree, and any written equation has to add up
 *        (the same check the hosted Cheap First uses, from ../../src);
 *      - anything else: plain-text warning signs, then a judge (Nano in
 *        budget and balanced, a small cloud model in strict).
 *   3. Under the pass mark, a stronger cloud model answers instead.
 *
 * This file has no Firebase imports, so the tests can pass fake models.
 */
import { auditCountFor, AUDIT_SYSTEM, expectedAnswerKind, labelsFromPrompt, scoreSamples } from "../../src/checkSignals.js";

export type Source = "ON_DEVICE" | "IN_CLOUD";
export type Mode = "strict" | "balanced" | "budget";

/** Same pass marks as the hosted Cheap First (src/cheapFirst.ts). */
export const PASS_MARK: Record<Mode, number> = { strict: 85, balanced: 75, budget: 60 };

export interface GenResult {
  text: string;
  source: Source;
  /** Cloud model that answered, when known (shown so a fallback is visible). */
  model?: string;
}

/** One model call. */
export type Gen = (prompt: string) => Promise<GenResult>;

/** Try each model in turn: a busy or failing cloud model hands over to the next. */
export function withFallback(...gens: Gen[]): Gen {
  return async (prompt) => {
    let last: unknown;
    for (const gen of gens) {
      try {
        return await gen(prompt);
      } catch (error) {
        last = error;
      }
    }
    throw last;
  };
}

/** Retry one model a few times after short waits, so a busy spell doesn't hand work to a weaker model too soon. */
export function withRetry(gen: Gen, waitsMs: number[] = [1500, 3000], sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Gen {
  return async (prompt) => {
    for (let i = 0; ; i++) {
      try {
        return await gen(prompt);
      } catch (error) {
        if (i >= waitsMs.length) throw error;
        await sleep(waitsMs[i]);
      }
    }
  };
}

export interface Models {
  /** PREFER_ON_DEVICE: Gemini Nano, or the small cloud model when this device has none. */
  first: Gen;
  /** ONLY_ON_DEVICE: a second answer, solved from scratch. */
  localSample: Gen;
  /** ONLY_ON_DEVICE: returns JSON {score, reason}. */
  localJudge: Gen;
  /** ONLY_IN_CLOUD: a small cloud judge for strict mode. Returns JSON {score, reason}. */
  cloudJudge: Gen;
  /** ONLY_IN_CLOUD: the stronger model that answers when the check fails. */
  cloud: Gen;
}

export type AnsweredBy = "device" | "cloud-no-device" | "cloud-escalated";
export type CheckSignal = "agreement" | "arithmetic" | "warning-signs" | "device-judge" | "cloud-judge";

export interface Check {
  score: number;
  reason: string;
  signal: CheckSignal;
}

export interface Step {
  what: string;
  where: Source;
  ms: number;
}

export interface Outcome {
  question: string;
  answer: string;
  answeredBy: AnsweredBy;
  mode: Mode;
  passMark: number;
  check?: Check;
  /** The on-device answer that was replaced, when the check failed. */
  deviceAnswer?: string;
  steps: Step[];
  deviceCalls: number;
  cloudCalls: number;
  ms: number;
}

const NUMBER_FORMAT = "\n\nSolve the problem. Put the final numeric answer on its own line, exactly in this form:\nFinal answer: <number>";
const CHOICE_FORMAT = "\n\nWhich option is correct? Put the label on its own line, exactly in this form:\nFinal answer: <label>";

const NUMERIC_ASK =
  /\b(how (many|much|long|far|old|fast|tall)|what is|what's|calculate|compute|total|sum|average|mean|percent|percentage|cost|price|difference|product|remain|left over|altogether)\b|[%$£€]/i;

/**
 * Adds the answer format the number and choice checks need, when a typed
 * question looks like one. Questions that already ask for it are left alone.
 */
export function prepareQuestion(question: string): string {
  const q = question.trim();
  if (expectedAnswerKind(q) !== "open") return q;
  if (labelsFromPrompt(q).length >= 2) return q + CHOICE_FORMAT;
  if (/\d/.test(q) && NUMERIC_ASK.test(q) && q.length <= 1200) return q + NUMBER_FORMAT;
  return q;
}

/** The audit sample is told to solve from scratch, as on the hosted version. */
export function auditPrompt(prompt: string): string {
  return `${AUDIT_SYSTEM}\n\n${prompt}`;
}

const HEDGES = [
  /\bI(?:'m| am) not (?:sure|certain)\b/i,
  /\bI (?:don't|do not|can't|cannot) (?:know|say|tell|verify|confirm|access|browse)\b/i,
  /\bas an AI\b/i,
  /\bI (?:can't|cannot|won't) help\b/i,
  /\b(?:my|the) (?:knowledge|training data) (?:cut-?off|only goes)\b/i,
  /\bI don't have (?:access|real-time|up-to-date|current)\b/i,
];

/**
 * Warning signs code can see without a model. Null means none found.
 * A cut-off sentence or a hedge sends the question on even if a judge liked it.
 */
export function warningSigns(answer: string): Check | null {
  const text = answer.trim();
  if (!text) return { score: 0, signal: "warning-signs", reason: "The on-device model gave no answer." };
  for (const pattern of HEDGES) {
    if (pattern.test(text)) {
      return { score: 40, signal: "warning-signs", reason: "The on-device answer says it isn't sure or can't know." };
    }
  }
  if (text.length > 200 && !/[.!?)\]"'`*\d:]$/.test(text)) {
    return { score: 50, signal: "warning-signs", reason: "The on-device answer stops mid-sentence." };
  }
  return null;
}

export const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    reason: { type: "string" },
  },
  required: ["score", "reason"],
} as const;

export function judgePrompt(question: string, answer: string): string {
  return (
    "You check answers written by a small on-device model before they are shown to a person.\n" +
    "Score 0 to 100 how sure you are the answer is correct, complete and answers what was asked.\n" +
    "Score under 60 for: a wrong or made-up fact, figure, name, date or source; a missed part of the question; " +
    "advice that could cause harm if wrong; anything you cannot check yourself.\n" +
    "Score 90 or more only when you would stake your own name on it.\n" +
    'Reply with JSON only: {"score": <integer>, "reason": "<one short sentence>"}\n\n' +
    `QUESTION:\n${question}\n\nANSWER:\n${answer}`
  );
}

/** Reads the judge's JSON. Anything unreadable scores 50, which fails every mode. */
export function parseJudge(text: string, signal: CheckSignal): Check {
  const match = text.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(match ? match[0] : text) as { score?: unknown; reason?: unknown };
    const score = Number(parsed.score);
    if (Number.isFinite(score)) {
      const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "No reason given.";
      return { score: Math.max(0, Math.min(100, Math.round(score))), reason, signal };
    }
  } catch {
    // fall through
  }
  return { score: 50, signal, reason: "The judge's reply could not be read, so the answer was not trusted." };
}

export interface AskOptions {
  mode?: Mode;
  /** For tests. */
  now?: () => number;
}

/**
 * Ask a question the Cheap First way. Never throws for a failed check:
 * if a local step errors, the question goes to the cloud model.
 */
export async function askCheapFirst(question: string, models: Models, options: AskOptions = {}): Promise<Outcome> {
  const mode = options.mode ?? "balanced";
  const passMark = PASS_MARK[mode];
  const now = options.now ?? (() => performance.now());
  const started = now();
  const prompt = prepareQuestion(question);
  const steps: Step[] = [];
  let deviceCalls = 0;
  let cloudCalls = 0;

  const call = async (what: string, gen: Gen, text: string): Promise<GenResult> => {
    const t = now();
    const result = await gen(text);
    steps.push({ what: result.model ? `${what} (${result.model})` : what, where: result.source, ms: Math.round(now() - t) });
    if (result.source === "ON_DEVICE") deviceCalls++;
    else cloudCalls++;
    return result;
  };

  const finish = (answer: string, answeredBy: AnsweredBy, check?: Check, deviceAnswer?: string): Outcome => ({
    question,
    answer,
    answeredBy,
    mode,
    passMark,
    check,
    deviceAnswer,
    steps,
    deviceCalls,
    cloudCalls,
    ms: Math.round(now() - started),
  });

  const escalate = async (check: Check, deviceAnswer: string): Promise<Outcome> => {
    const better = await call("Stronger cloud model answered", models.cloud, prompt);
    return finish(better.text, "cloud-escalated", check, deviceAnswer);
  };

  let first: GenResult;
  try {
    first = await call("Answered", models.first, prompt);
  } catch (error) {
    return escalate({ score: 0, signal: "warning-signs", reason: `The on-device model failed: ${messageOf(error)}` }, "");
  }

  if (first.source === "IN_CLOUD") {
    // No model on this device. Firebase already answered in the cloud.
    return finish(first.text, "cloud-no-device");
  }

  let check: Check;
  try {
    check = await checkAnswer(prompt, first.text, mode, models, call);
  } catch (error) {
    check = { score: 50, signal: "warning-signs", reason: `The check could not run: ${messageOf(error)}` };
  }

  if (check.score >= passMark) return finish(first.text, "device", check);
  return escalate(check, first.text);
}

type Caller = (what: string, gen: Gen, text: string) => Promise<GenResult>;

async function checkAnswer(prompt: string, answer: string, mode: Mode, models: Models, call: Caller): Promise<Check> {
  const warning = warningSigns(answer);
  if (warning) return warning;

  if (expectedAnswerKind(prompt) !== "open") {
    const audits: string[] = [];
    const count = auditCountFor(PASS_MARK[mode]);
    for (let i = 0; i < count; i++) {
      const sample = await call(count > 1 ? `Second answer ${i + 1} of ${count}, solved from scratch` : "Second answer, solved from scratch", models.localSample, auditPrompt(prompt));
      audits.push(sample.text);
    }
    const scored = scoreSamples(prompt, answer, audits);
    return { score: scored.score, reason: scored.reason, signal: scored.signal };
  }

  if (mode === "strict") {
    const verdict = await call("Cloud judge checked it", models.cloudJudge, judgePrompt(prompt, answer));
    return parseJudge(verdict.text, "cloud-judge");
  }
  const verdict = await call("On-device judge checked it", models.localJudge, judgePrompt(prompt, answer));
  return parseJudge(verdict.text, "device-judge");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

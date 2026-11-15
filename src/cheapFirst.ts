/**
 * Cheap First: answer with the cheap model, check the answer, and escalate
 * to the premium model only when the check fails.
 */
import { CHEAP, chat, chatMessages, costOf, servModel, type CallResult, type ChatMessage, type ModelSpec } from "./models.js";

export const SYSTEM_PROMPT = "You are a helpful, accurate assistant. Follow the user's instructions exactly, including any length limits. If you don't know or can't verify something, say so instead of guessing.";

/** Answers scoring below this are escalated to the premium model. */
export const PASS_MARK = 75;

/** Pass marks a caller can pick: stricter escalates more often, budget less often. */
export const MODES = { strict: 85, balanced: PASS_MARK, budget: 60 } as const;
export type Mode = keyof typeof MODES;

export function modeFrom(value: unknown): Mode {
  return typeof value === "string" && value in MODES ? (value as Mode) : "balanced";
}

export interface Check {
  score: number;
  reason: string;
  call: CallResult;
}

export interface CheapFirstResult {
  prompt: string;
  /** The answer the user gets: the cheap one if it passed, otherwise the premium one. */
  answer: string;
  answeredBy: "cheap" | "premium";
  cheap: CallResult;
  check: Check;
  premium?: CallResult;
  /** What Cheap First actually spent: cheap answer + check (+ premium if escalated). */
  costUsd: number;
}

export interface Models {
  cheap: ModelSpec;
  checker: ModelSpec;
  premium: ModelSpec;
}

export async function defaultModels(): Promise<Models> {
  return {
    cheap: CHEAP,
    checker: await servModel("SERV · GPT-6 Luna (checker)", "gpt-6-luna"),
    premium: await servModel("SERV · Claude Opus 5.5", "claude-opus-5.5"),
  };
}

/** Asks the checker to grade an answer. `criteria` is optional extra guidance. */
export async function checkAnswer(checker: ModelSpec, prompt: string, answer: string, criteria?: string): Promise<Check> {
  const system =
    "You are a strict, fair grader of AI answers. Judge correctness, whether the instructions (including length limits) were followed, and whether anything was made up. " +
    'Reply with JSON only: {"score": <integer 0-100>, "reason": "<one sentence>"}.';
  const user =
    `Question:\n${prompt}\n\n` +
    (criteria ? `What a good answer looks like:\n${criteria}\n\n` : "") +
    `Answer to grade:\n${answer.slice(0, 40_000)}`;
  const call = await chat(checker, system, user);
  const match = call.text.match(/\{[\s\S]*\}/);
  if (!match) return { score: 0, reason: "The checker did not return a score.", call };
  try {
    const parsed = JSON.parse(match[0]) as { score: number; reason: string };
    return { score: Math.max(0, Math.min(100, Math.round(parsed.score))), reason: String(parsed.reason ?? ""), call };
  } catch {
    return { score: 0, reason: "The checker's reply could not be read.", call };
  }
}

export interface CheapFirstOptions {
  /** Cap on the premium answer's length, to bound what one escalation can cost. */
  premiumMaxTokens?: number;
  /**
   * If the cheap model errors out, answer with the premium model instead of
   * failing. On by default; the benchmark turns it off so outages aren't hidden.
   */
  fallbackOnCheapError?: boolean;
  /** Asked before escalating; return false to refuse (for example, a spend limit was hit). */
  canEscalate?: () => boolean | Promise<boolean>;
  /** Escalate answers scoring below this. Defaults to PASS_MARK. */
  passMark?: number;
}

/** The conversation as plain text, for the checker to read. */
export function transcript(messages: ChatMessage[]): string {
  if (messages.length === 1 && messages[0].role === "user") return messages[0].content;
  const label = { system: "Instructions", user: "User", assistant: "Assistant" } as const;
  return (
    messages.map((m) => `${label[m.role]}: ${m.content}`).join("\n\n") +
    "\n\n(Grade the reply to the last user message, following the instructions and the conversation above.)"
  );
}

/** Our system prompt first, then the caller's own system messages, then the conversation. */
function withSystem(messages: ChatMessage[]): ChatMessage[] {
  const theirs = messages.filter((m) => m.role === "system").map((m) => m.content);
  const system = [SYSTEM_PROMPT, ...theirs].join("\n\n");
  return [{ role: "system", content: system }, ...messages.filter((m) => m.role !== "system")];
}

/** Thrown when an answer needs the premium model but `canEscalate` said no. */
export class EscalationBlocked extends Error {
  constructor() {
    super("The premium model isn't available right now.");
    this.name = "EscalationBlocked";
  }
}

const NO_CALL: CallResult = { text: "", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 };

/**
 * `input` is a single question, or a whole conversation (OpenAI-style
 * messages); the answer replies to its last user message.
 */
export async function cheapFirst(input: string | ChatMessage[], models: Models, criteria?: string, options: CheapFirstOptions = {}): Promise<CheapFirstResult> {
  const { premiumMaxTokens, fallbackOnCheapError = true, canEscalate = () => true, passMark = PASS_MARK } = options;
  const messages = withSystem(typeof input === "string" ? [{ role: "user", content: input }] : input);
  const prompt = typeof input === "string" ? input : transcript(input);

  let cheap: CallResult;
  let check: Check;
  try {
    cheap = await chatMessages(models.cheap, messages);
  } catch (e) {
    if (!fallbackOnCheapError) throw e;
    console.error(`Cheap model failed, escalating: ${(e as Error).message}`);
    cheap = { ...NO_CALL };
  }

  if (!cheap.text.trim()) {
    // A blank answer (or a cheap-model outage) can't pass, so don't pay to check it.
    check = { score: 0, reason: "The cheap model gave no answer, so it went straight to the premium model.", call: { ...NO_CALL } };
  } else {
    check = await checkAnswer(models.checker, prompt, cheap.text, criteria);
    if (check.score >= passMark) {
      return { prompt, answer: cheap.text, answeredBy: "cheap", cheap, check, costUsd: cheap.costUsd + check.call.costUsd };
    }
  }

  if (!(await canEscalate())) throw new EscalationBlocked();
  const premium = await chatMessages(models.premium, messages, premiumMaxTokens);
  return {
    prompt,
    answer: premium.text,
    answeredBy: "premium",
    cheap,
    check,
    premium,
    costUsd: cheap.costUsd + check.call.costUsd + premium.costUsd,
  };
}

/**
 * What the same answer would have cost from the premium model alone, and so
 * what Cheap First saved. For a cheap answer it's an estimate: the premium
 * price applied to the cheap call's token counts. Can be negative when an
 * escalation paid for the cheap try and the check on top.
 */
export function savings(r: CheapFirstResult, models: Models): { premiumOnlyUsd: number; savedUsd: number } {
  const premiumOnlyUsd = r.premium ? r.premium.costUsd : costOf(models.premium, r.cheap.inputTokens, r.cheap.outputTokens);
  return { premiumOnlyUsd, savedUsd: premiumOnlyUsd - r.costUsd };
}

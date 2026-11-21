/**
 * Decides whether a cheap answer is safe to return, without asking a model
 * to grade the answer it is looking at.
 *
 * On the published public run the grader scored every wrong cheap answer 100
 * and disagreed with correct ones. For a number or a multiple-choice question
 * the check is now two things the grader cannot rubber-stamp:
 *
 *   1. Another cheap sample, asked to solve the question on its own, has to
 *      land on the same number or the same choice. Strict mode asks twice.
 *   2. An equation in the answer has to evaluate to the number written after
 *      the equals sign. Scraping the last equation and comparing it to the
 *      stated answer is not used: on the published GSM8K answers that last
 *      step is often an intermediate, so it would escalate correct answers.
 *
 * The scores sit in the gaps between the mode pass marks (strict 85,
 * balanced 75, budget 60). Those gaps are the modes. They were not fit on
 * the reported 300 questions.
 *
 *   100  every extra sample agrees, and no equation is false
 *    84  the extra sample could not be compared. Fails strict only.
 *    80  a majority agrees (2 of 3). Fails strict, passes balanced and budget.
 *    70  the samples disagree. Fails strict and balanced, passes budget.
 *    50  no majority, or no answer to compare. Fails every mode.
 *    40  a written equation does not evaluate. Fails every mode.
 *
 * Anything else (an email, a paragraph, a question with written criteria)
 * still goes to the language-model grader. That path is unchanged.
 */
import { auditArithmetic } from "./arithmetic.js";
import { extractArcLabel, extractGsmNumber } from "./publicGrade.js";

/** Same number as MODES.strict. Two extra samples at or above this pass mark. */
export const STRICT_MARK = 85;

export const SCORE = {
  agree: 100,
  uncompared: 84,
  majority: 80,
  disagree: 70,
  split: 50,
  arithmetic: 40,
} as const;

/** Extra cheap answers. Strict draws two; balanced and budget draw one. */
export function auditCountFor(passMark: number): number {
  return passMark >= STRICT_MARK ? 2 : 1;
}

/** High enough to vary, low enough that a confident answer usually repeats. */
export const AUDIT_TEMPERATURE = 0.4;

/** Caps what the extra sample can cost. GSM8K answers in the published run are far shorter. */
export const AUDIT_MAX_TOKENS = 1024;

export const AUDIT_SYSTEM =
  "Solve the question from scratch. Do not assume an answer is already written.\n" +
  "If it is a calculation, include one equation of the form <expression> = <number>.\n" +
  "End with a single line in exactly this form:\n" +
  "Final answer: <value>";

export type AnswerKind = "number" | "choice" | "open";

export interface SampleScore {
  score: number;
  reason: string;
  signal: "agreement" | "arithmetic";
}

/** Choice labels the prompt itself lists. The answer key is not an argument. */
export function labelsFromPrompt(prompt: string): string[] {
  const listed = prompt.match(/the label is one of:\s*([^\n.]+)/i);
  if (listed) {
    const labels = listed[1].split(",").map((part) => part.trim()).filter(Boolean);
    if (labels.length >= 2) return labels;
  }
  const found: string[] = [];
  for (const line of prompt.split("\n")) {
    const match = line.match(/^\s*([A-D])[.)]\s+\S/);
    if (match && !found.includes(match[1])) found.push(match[1]);
  }
  return found.length >= 2 ? found : [];
}

/**
 * Number and choice prompts are the ones where two answers can be compared
 * by code. The public benchmark's prompts match this. An ordinary question
 * does not, and keeps the grader.
 */
export function expectedAnswerKind(prompt: string): AnswerKind {
  if (/final numeric answer/i.test(prompt) || /Final answer:\s*<number>/i.test(prompt)) return "number";
  const labels = labelsFromPrompt(prompt);
  if (/Final answer:\s*<label>/i.test(prompt) || /the label is one of:/i.test(prompt) || labels.length >= 2) return "choice";
  return "open";
}

/** Written criteria mean the caller wants the grader, which is the path that reads them. */
export function usesSampleCheck(prompt: string, criteria?: string): boolean {
  return !criteria && expectedAnswerKind(prompt) !== "open";
}

function sameAnswer(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function valueOf(kind: AnswerKind, text: string, labels: string[]): string | null {
  if (kind === "number") return extractGsmNumber(text)?.value ?? null;
  if (kind === "choice") return extractArcLabel(text, labels)?.value ?? null;
  return null;
}

/**
 * Score the cheap answer against extra samples of the same question.
 * `audits` is in call order. Balanced and budget pass one; strict passes two.
 */
export function scoreSamples(prompt: string, primary: string, audits: string[]): SampleScore {
  const kind = expectedAnswerKind(prompt);
  const labels = labelsFromPrompt(prompt);
  const primaryValue = valueOf(kind, primary, labels);
  if (kind === "number") {
    const broken = auditArithmetic(primary, primaryValue).broken;
    if (broken.length) {
      return {
        score: SCORE.arithmetic,
        signal: "arithmetic",
        reason: `An equation in the cheap answer does not evaluate: ${broken[0].raw}.`,
      };
    }
  }
  if (kind === "open" || primaryValue === null) {
    return {
      score: SCORE.split,
      signal: "agreement",
      reason: "The cheap answer had no final number or choice to compare.",
    };
  }

  const votes = audits.map((text) => {
    const value = valueOf(kind, text, labels);
    const broken = kind === "number" && value !== null && auditArithmetic(text, value).broken.length > 0;
    return { value, broken };
  });
  const comparable = votes.filter((vote): vote is { value: string; broken: boolean } => vote.value !== null);
  if (!comparable.length) {
    return {
      score: SCORE.uncompared,
      signal: "agreement",
      reason: "The extra sample had no comparable answer. No equation in the cheap answer was false.",
    };
  }

  const against = comparable.filter((vote) => vote.broken || !sameAnswer(vote.value, primaryValue));
  const fors = comparable.length - against.length;
  if (!against.length) {
    const noun = comparable.length === 1 ? "Extra sample agreed" : "Extra samples agreed";
    return { score: SCORE.agree, signal: "agreement", reason: `${noun} on ${primaryValue}.` };
  }
  const other = against.map((vote) => (vote.broken ? `${vote.value} (equation does not evaluate)` : vote.value)).join(", ");
  if (comparable.length >= 2 && fors >= 1 && against.length === 1) {
    return {
      score: SCORE.majority,
      signal: "agreement",
      reason: `${fors + 1} of ${comparable.length + 1} samples agreed on ${primaryValue}. One said ${other}.`,
    };
  }
  if (comparable.length >= 2 && fors === 0) {
    return {
      score: SCORE.split,
      signal: "agreement",
      reason: `The extra samples did not agree with ${primaryValue} (they said ${other}).`,
    };
  }
  return {
    score: SCORE.disagree,
    signal: "agreement",
    reason: `The extra sample said ${other}, not ${primaryValue}.`,
  };
}

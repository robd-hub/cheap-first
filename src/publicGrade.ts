/**
 * Grading and sampling for the public benchmark.
 *
 * The checker that decides whether to escalate never sees these functions
 * or the answer key. A correct Cheap First answer and a correct premium
 * answer are decided here, from the published GSM8K number or ARC label.
 */
import { SAMPLE_SEED } from "./publicSets.js";

export interface Grade {
  correct: boolean;
  note: string;
}

export interface ArcChoice {
  label: string;
  text: string;
}

/** The question sent to both paths. The answer key is not in this string. */
export function gsm8kPrompt(question: string): string {
  return `${question.trim()}\n\nSolve the problem. Put the final numeric answer on its own line, exactly in this form:\nFinal answer: <number>`;
}

/** The question sent to both paths. `answerKey` is intentionally not an argument. */
export function arcPrompt(stem: string, choices: ArcChoice[]): string {
  const lines = choices.map((c) => `${c.label}. ${c.text.replace(/\s+/g, " ").trim()}`);
  const labels = choices.map((c) => c.label).join(", ");
  return `${stem.trim()}\n\n${lines.join("\n")}\n\nWhich option is correct? Put the label on its own line, exactly in this form:\nFinal answer: <label>\nThe label is one of: ${labels}.`;
}

/** The number after the last `####` in a GSM8K gold answer. */
export function gsm8kGold(answer: string): string {
  const tail = answer.split("####").pop() ?? "";
  const n = normalizeNumber(tail);
  if (n === null) throw new Error("GSM8K gold answer has no final number.");
  return n;
}

export function gradeGsm8k(modelAnswer: string, goldField: string): Grade {
  return gradeGsm8kNumber(modelAnswer, gsm8kGold(goldField));
}

/** `gold` is the already-normalized published number ("1000", "2.5"). */
export function gradeGsm8kNumber(modelAnswer: string, gold: string): Grade {
  const picked = extractGsmNumber(modelAnswer);
  if (picked === null) return { correct: false, note: `no number found (gold ${gold})` };
  return { correct: picked.value === gold, note: `${picked.how} ${picked.value} (gold ${gold})` };
}

export function gradeArc(modelAnswer: string, answerKey: string, labels: string[]): Grade {
  const key = answerKey.trim();
  const picked = extractArcLabel(modelAnswer, labels);
  const gold = labels.find((l) => l.toLowerCase() === key.toLowerCase()) ?? key;
  if (picked === null) return { correct: false, note: `no choice found (gold ${gold})` };
  return { correct: picked.value.toLowerCase() === gold.toLowerCase(), note: `${picked.how} ${picked.value} (gold ${gold})` };
}

export function normalizeNumber(raw: string): string | null {
  const t = raw.trim().replace(/[$,\s]/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return String(n);
}

function extractGsmNumber(text: string): { value: string; how: string } | null {
  const finals = [...text.matchAll(/final answer\s*:\s*(.*)/gi)];
  if (finals.length) {
    const fromLine = firstNumber(finals[finals.length - 1][1]);
    if (fromLine) return { value: fromLine, how: "final-answer line" };
  }
  const hashes = [...text.matchAll(/####\s*([^\n]+)/g)];
  if (hashes.length) {
    const fromHash = firstNumber(hashes[hashes.length - 1][1]);
    if (fromHash) return { value: fromHash, how: "#### line" };
  }
  const all = [...text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)];
  for (let i = all.length - 1; i >= 0; i--) {
    const n = normalizeNumber(all[i][0]);
    if (n !== null) return { value: n, how: "last number" };
  }
  return null;
}

function firstNumber(text: string): string | null {
  const m = text.match(/-?\d[\d,]*(?:\.\d+)?/);
  return m ? normalizeNumber(m[0]) : null;
}

function extractArcLabel(text: string, labels: string[]): { value: string; how: string } | null {
  const allowed = labels.map((l) => l.trim()).filter(Boolean);
  if (!allowed.length) return null;
  const finals = [...text.matchAll(/final answer\s*:\s*(.*)/gi)];
  if (finals.length) {
    const fromLine = labelIn(finals[finals.length - 1][1], allowed);
    if (fromLine) return { value: fromLine, how: "final-answer line" };
  }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const exact = exactLabel(lines[i], allowed);
    if (exact) return { value: exact, how: "label line" };
  }
  const said = [...text.matchAll(/\b(?:answer|choice|option)\s*(?:is|=|:)\s*([A-Za-z0-9]+)/gi)];
  if (said.length) {
    const fromPhrase = exactLabel(said[said.length - 1][1], allowed);
    if (fromPhrase) return { value: fromPhrase, how: "answer phrase" };
  }
  return null;
}

function exactLabel(text: string, labels: string[]): string | null {
  const t = text.trim().replace(/^[([{\s]+/, "").replace(/[)\]}.:\s]+$/, "");
  return labels.find((l) => l.toLowerCase() === t.toLowerCase()) ?? null;
}

/** Last standalone label token in a final-answer line. "option C" picks C; "12" does not pick 1. */
function labelIn(text: string, labels: string[]): string | null {
  const exact = exactLabel(text, labels);
  if (exact) return exact;
  const body = labels.map(escapeRegExp).join("|");
  const re = new RegExp(`(?:^|[^A-Za-z0-9])(${body})(?=$|[^A-Za-z0-9])`, "gi");
  const hits = [...text.matchAll(re)];
  if (!hits.length) return null;
  const token = hits[hits.length - 1][1];
  return labels.find((l) => l.toLowerCase() === token.toLowerCase()) ?? null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** mulberry32. Returns a float in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixes the dataset name into the shared seed so the two samples are independent. */
export function datasetSeed(name: string, seed = SAMPLE_SEED): number {
  let h = seed >>> 0;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Fisher-Yates sample, then ordered by id so the run order does not depend
 * on the shuffle. The set of ids is what the seed fixes.
 */
export function selectSample<T>(items: readonly T[], count: number, seed: number, idOf: (item: T) => string): T[] {
  if (!Number.isInteger(count) || count < 0 || count > items.length) {
    throw new Error(`Sample size ${count} is outside 0..${items.length}.`);
  }
  const copy = items.slice();
  const rand = mulberry32(seed);
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy.slice(0, count).sort((a, b) => cmp(idOf(a), idOf(b)));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface ScoredRun {
  dataset: string;
  answeredBy: "cheap" | "premium";
  cheapCorrect: boolean;
  /** Dolphin returned no text. A blank is wrong, and it is not counted as a checker catch. */
  cheapBlank: boolean;
  cheapFirstCorrect: boolean;
  premiumCorrect: boolean;
  cheapFirstCostUsd: number;
  premiumCostUsd: number;
  cheapFirstMs: number;
  premiumMs: number;
}

export interface DatasetScore {
  questions: number;
  correct: { cheapAlone: number; cheapFirst: number; premium: number };
  escalated: number;
  costUsd: { cheapFirst: number; premium: number };
}

export interface PublicSummary {
  questions: number;
  correct: { cheapAlone: number; cheapFirst: number; premium: number };
  /** Share correct, rounded to 4 decimal places. Null when there are no rows. */
  accuracy: { cheapAlone: number | null; cheapFirst: number | null; premium: number | null };
  costUsd: { cheapFirst: number; premium: number };
  /** Percent cheaper than premium-only, one decimal. Null when premium cost is 0. */
  savingPct: number | null;
  escalated: number;
  escalationRate: number | null;
  /** Non-blank cheap answer was wrong, the checker escalated, and the answer returned is right. */
  catches: number;
  /** Escalated because Dolphin returned nothing. */
  blankEscalations: number;
  /** Checker escalated a cheap answer that was already right. */
  falseAlarms: number;
  /** Cheap answer wrong, and it was returned anyway. */
  missed: number;
  /** Escalated, and the answer that was returned is still wrong. */
  escalatedStillWrong: number;
  latencyMs: {
    cheapFirst: { mean: number; median: number };
    premium: { mean: number; median: number };
  };
  byDataset: Record<string, DatasetScore>;
}

export function summarizePublic(rows: ScoredRun[]): PublicSummary {
  const n = rows.length;
  const correct = {
    cheapAlone: rows.filter((r) => r.cheapCorrect).length,
    cheapFirst: rows.filter((r) => r.cheapFirstCorrect).length,
    premium: rows.filter((r) => r.premiumCorrect).length,
  };
  const cheapFirstCost = rows.reduce((sum, r) => sum + r.cheapFirstCostUsd, 0);
  const premiumCost = rows.reduce((sum, r) => sum + r.premiumCostUsd, 0);
  const escalatedRows = rows.filter((r) => r.answeredBy === "premium");
  const byDataset: Record<string, DatasetScore> = {};
  for (const row of rows) {
    const slot = (byDataset[row.dataset] ??= {
      questions: 0,
      correct: { cheapAlone: 0, cheapFirst: 0, premium: 0 },
      escalated: 0,
      costUsd: { cheapFirst: 0, premium: 0 },
    });
    slot.questions += 1;
    slot.correct.cheapAlone += row.cheapCorrect ? 1 : 0;
    slot.correct.cheapFirst += row.cheapFirstCorrect ? 1 : 0;
    slot.correct.premium += row.premiumCorrect ? 1 : 0;
    slot.escalated += row.answeredBy === "premium" ? 1 : 0;
    slot.costUsd.cheapFirst += row.cheapFirstCostUsd;
    slot.costUsd.premium += row.premiumCostUsd;
  }
  return {
    questions: n,
    correct,
    accuracy: {
      cheapAlone: rate(correct.cheapAlone, n),
      cheapFirst: rate(correct.cheapFirst, n),
      premium: rate(correct.premium, n),
    },
    costUsd: { cheapFirst: cheapFirstCost, premium: premiumCost },
    savingPct: premiumCost > 0 ? Math.round((1 - cheapFirstCost / premiumCost) * 1000) / 10 : null,
    escalated: escalatedRows.length,
    escalationRate: rate(escalatedRows.length, n),
    catches: rows.filter((r) => !r.cheapBlank && !r.cheapCorrect && r.answeredBy === "premium" && r.cheapFirstCorrect).length,
    blankEscalations: rows.filter((r) => r.cheapBlank && r.answeredBy === "premium").length,
    falseAlarms: rows.filter((r) => r.cheapCorrect && r.answeredBy === "premium").length,
    missed: rows.filter((r) => !r.cheapCorrect && r.answeredBy === "cheap").length,
    escalatedStillWrong: rows.filter((r) => r.answeredBy === "premium" && !r.cheapFirstCorrect).length,
    latencyMs: {
      cheapFirst: { mean: mean(rows.map((r) => r.cheapFirstMs)), median: median(rows.map((r) => r.cheapFirstMs)) },
      premium: { mean: mean(rows.map((r) => r.premiumMs)), median: median(rows.map((r) => r.premiumMs)) },
    },
    byDataset,
  };
}

function rate(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 10_000) / 10_000;
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value);
}

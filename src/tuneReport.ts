/**
 * Turns stored tuning rows into a pass-mark grid.
 *
 * The grid is computed from calls that already happened. Changing a pass
 * mark here does not call a model, and it does not read the reported 300.
 */
import { auditCountFor, scoreSamples } from "./checkSignals.js";

export interface TuneRow {
  id: string;
  dataset: string;
  prompt: string;
  cheapAnswer: string;
  /** Two extra samples, in call order. Balanced and budget use the first only. */
  audits: string[];
  cheapCorrect: boolean;
  premiumCorrect: boolean;
  lunaScore: number;
  costUsd: { cheap: number; audits: number[]; premium: number; luna: number };
}

export interface PolicyScore {
  passMark: number;
  checker: "samples" | "luna";
  questions: number;
  correct: number;
  escalated: number;
  costUsd: number;
}

function auditsFor(row: TuneRow, passMark: number): { texts: string[]; costUsd: number } {
  const count = Math.min(auditCountFor(passMark), row.audits.length);
  return {
    texts: row.audits.slice(0, count),
    costUsd: row.costUsd.audits.slice(0, count).reduce((sum, cost) => sum + cost, 0),
  };
}

/** What that pass mark would have done with the stored answers. */
export function scorePolicy(row: TuneRow, passMark: number, checker: "samples" | "luna"): { escalated: boolean; correct: boolean; costUsd: number; score: number } {
  if (checker === "luna") {
    const escalated = row.lunaScore < passMark;
    return {
      escalated,
      correct: escalated ? row.premiumCorrect : row.cheapCorrect,
      costUsd: row.costUsd.cheap + row.costUsd.luna + (escalated ? row.costUsd.premium : 0),
      score: row.lunaScore,
    };
  }
  const audits = auditsFor(row, passMark);
  const scored = scoreSamples(row.prompt, row.cheapAnswer, audits.texts);
  const escalated = scored.score < passMark;
  return {
    escalated,
    correct: escalated ? row.premiumCorrect : row.cheapCorrect,
    costUsd: row.costUsd.cheap + audits.costUsd + (escalated ? row.costUsd.premium : 0),
    score: scored.score,
  };
}

export function policySummary(rows: TuneRow[], passMark: number, checker: "samples" | "luna"): PolicyScore {
  const scored = rows.map((row) => scorePolicy(row, passMark, checker));
  return {
    passMark,
    checker,
    questions: rows.length,
    correct: scored.filter((row) => row.correct).length,
    escalated: scored.filter((row) => row.escalated).length,
    costUsd: scored.reduce((sum, row) => sum + row.costUsd, 0),
  };
}

/** The three live modes, for the sample check and for the old grader. */
export function modeGrid(rows: TuneRow[], passMarks: number[]): PolicyScore[] {
  const out: PolicyScore[] = [];
  for (const passMark of passMarks) {
    out.push(policySummary(rows, passMark, "samples"));
    out.push(policySummary(rows, passMark, "luna"));
  }
  return out;
}

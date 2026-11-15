/**
 * Compares possible checkers on cost and on how well they catch bad answers,
 * the way the live endpoints use them (no written criteria, just the question):
 *   1. eight deliberately wrong answers: each should score below the pass mark
 *   2. every cheap answer from the benchmark: does the candidate pass or fail it
 *      the same way the current checker did with the written criteria?
 *
 *   npm run compare-checkers                 # Dolphin itself vs the current checker
 *   npm run compare-checkers -- gpt-5.4-nano # add other SERV models by id
 *
 * Saves data/checker-compare.json. Costs a few cents.
 */
import fs from "node:fs";
import { checkAnswer, defaultModels, PASS_MARK } from "../src/cheapFirst";
import { CHEAP, servModel, type ModelSpec } from "../src/models";
import { CASES } from "./check-sanity-cases";

interface Row {
  id: string;
  prompt: string;
  answer: string;
  /** The current checker's score with the written criteria, from the benchmark. */
  reference: number;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const models = await defaultModels();
const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const extra = await Promise.all(ids.map((id) => servModel(`SERV · ${id}`, id)));
const candidates: ModelSpec[] = [models.checker, { ...CHEAP, label: "Dolphin · DeepSeek V4.1 Flash (as checker)" }, ...extra];

const results = JSON.parse(fs.readFileSync("data/results.json", "utf8")) as {
  rows: { id: string; prompt: string; cheap: { answer: string; score: number } }[];
};
const rows: Row[] = results.rows.map((r) => ({ id: r.id, prompt: r.prompt, answer: r.cheap.answer, reference: r.cheap.score }));

const summary = [];
for (const c of candidates) {
  console.log(`\n${c.label}`);
  let cost = 0;
  const planted = await pool(CASES, 4, async (k) => {
    const r = await checkAnswer(c, k.prompt, k.answer);
    cost += r.call.costUsd;
    return { prompt: k.prompt, score: r.score, reason: r.reason, caught: r.score < PASS_MARK };
  });
  const graded = await pool(rows, 6, async (row) => {
    try {
      const r = await checkAnswer(c, row.prompt, row.answer);
      cost += r.call.costUsd;
      return { id: row.id, score: r.score, pass: r.score >= PASS_MARK, refPass: row.reference >= PASS_MARK };
    } catch (e) {
      console.log(`  ${row.id}: failed (${(e as Error).message})`);
      return null;
    }
  });
  const ok = graded.filter((g): g is NonNullable<typeof g> => g !== null);
  const caught = planted.filter((p) => p.caught).length;
  const agree = ok.filter((g) => g.pass === g.refPass).length;
  const extraEscalations = ok.filter((g) => !g.pass && g.refPass).map((g) => g.id);
  const missed = ok.filter((g) => g.pass && !g.refPass).map((g) => g.id);
  const perCheck = cost / (planted.length + ok.length);
  console.log(`  planted wrong answers caught: ${caught}/${planted.length}`);
  console.log(`  agrees with the benchmark's pass/fail: ${agree}/${ok.length}; extra escalations: ${extraEscalations.length}; missed: ${missed.join(", ") || "none"}`);
  console.log(`  cost per check: $${perCheck.toFixed(7)}`);
  summary.push({ checker: c.label, model: c.model, caught, planted: planted.length, agree, total: ok.length, extraEscalations, missed, costPerCheckUsd: perCheck, plantedRows: planted });
}
fs.writeFileSync("data/checker-compare.json", JSON.stringify({ ranAt: new Date().toISOString(), passMark: PASS_MARK, summary }, null, 2) + "\n");
console.log("\nSaved data/checker-compare.json");

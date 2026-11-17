/**
 * The hard benchmark: 60 harder, real-world style questions with known
 * correct answers (data/hard-questions.json, made by scripts/make-hard-set.py).
 *
 * Each question is run two ways, Cheap First and always-premium, and every
 * answer is graded against the known answer by code (scripts/hard-grade.ts).
 * Unlike the main benchmark, the checker is not shown what a good answer looks
 * like, just as in real use, and it never grades the final answers, so it
 * can't mark its own homework.
 *
 *   npm run hard-benchmark                 # all questions
 *   npm run hard-benchmark -- kelvin fx-ok # just these ids
 *   npm run hard-benchmark -- --regrade    # re-grade saved answers, no API calls
 *   npm run hard-benchmark -- --set stress # round 2, the stress set
 */
import fs from "node:fs";
import { cheapFirst, defaultModels, PASS_MARK, SYSTEM_PROMPT } from "../src/cheapFirst";
import { chat } from "../src/models";
import { grade, type Expect } from "./hard-grade";

interface Question {
  category: string;
  id: string;
  prompt: string;
  expect: Expect;
}

interface Row extends Question {
  answeredBy: "cheap" | "premium";
  checkScore: number;
  checkReason: string;
  cheap: { answer: string; costUsd: number; correct?: boolean; note?: string };
  checkCostUsd: number;
  cheapFirst: { answer: string; costUsd: number; correct?: boolean; note?: string };
  premium: { answer: string; costUsd: number; correct?: boolean; note?: string };
}

const args = process.argv.slice(2);
// Round 1 is the hard set; `--set stress` runs round 2 (data/stress-questions.json).
const SET = args.includes("--set") ? args[args.indexOf("--set") + 1] : "hard";
const QUESTIONS = `data/${SET}-questions.json`;
const RESULTS = `data/${SET}-results.json`;
const CONCURRENCY = 4;
const questions = JSON.parse(fs.readFileSync(QUESTIONS, "utf8")) as Question[];
const previous = fs.existsSync(RESULTS) ? (JSON.parse(fs.readFileSync(RESULTS, "utf8")) as { rows: Row[]; models?: unknown }) : { rows: [] };

function regrade(r: Row): Row {
  const q = questions.find((x) => x.id === r.id)!;
  for (const side of [r.cheap, r.cheapFirst, r.premium]) Object.assign(side, grade(side.answer, q.expect));
  return { ...r, expect: q.expect, prompt: q.prompt };
}

function summary(rows: Row[]) {
  const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
  const escalated = rows.filter((r) => r.answeredBy === "premium");
  const cheapWrong = rows.filter((r) => !r.cheap.correct);
  return {
    questions: rows.length,
    correct: { cheapAlone: sum((r) => +!!r.cheap.correct), cheapFirst: sum((r) => +!!r.cheapFirst.correct), premium: sum((r) => +!!r.premium.correct) },
    costUsd: { cheapFirst: sum((r) => r.cheapFirst.costUsd), premium: sum((r) => r.premium.costUsd) },
    escalated: escalated.length,
    // An escalation was "right" if Dolphin's answer really was wrong.
    rightEscalations: escalated.filter((r) => !r.cheap.correct).length,
    falseAlarms: escalated.filter((r) => r.cheap.correct).length,
    // Dolphin was wrong but the checker let it through: the user got a wrong answer.
    missed: cheapWrong.filter((r) => r.answeredBy === "cheap").length,
    cheapWrong: cheapWrong.length,
  };
}

function save(rows: Row[], models: unknown) {
  const order = questions.map((q) => q.id);
  rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const out = { ranAt: new Date().toISOString(), passMark: PASS_MARK, models, summary: summary(rows), rows };
  fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2) + "\n");
}

async function runOne(q: Question, models: Awaited<ReturnType<typeof defaultModels>>): Promise<Row> {
  // No criteria: in real use the checker never knows the right answer.
  const cf = await cheapFirst(q.prompt, models, undefined, { fallbackOnCheapError: false });
  const premium = cf.premium ?? (await chat(models.premium, SYSTEM_PROMPT, q.prompt));
  return regrade({
    ...q,
    answeredBy: cf.answeredBy,
    checkScore: cf.check.score,
    checkReason: cf.check.reason,
    cheap: { answer: cf.cheap.text, costUsd: cf.cheap.costUsd },
    checkCostUsd: cf.check.call.costUsd,
    cheapFirst: { answer: cf.answer, costUsd: cf.costUsd },
    premium: { answer: premium.text, costUsd: premium.costUsd },
  });
}

async function main() {
  if (args.includes("--regrade")) {
    save(previous.rows.map(regrade), previous.models);
    console.log(JSON.stringify(summary(previous.rows.map(regrade)), null, 2));
    return;
  }
  const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--set");
  const todo = questions.filter((q) => only.length === 0 || only.includes(q.id));
  const models = await defaultModels();
  const rows = previous.rows.filter((r) => !todo.some((q) => q.id === r.id));
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let q = queue.shift(); q; q = queue.shift()) {
        try {
          const r = await runOne(q, models);
          rows.push(r);
          console.log(
            `${q.id}: check ${r.checkScore} -> ${r.answeredBy} | Dolphin ${r.cheap.correct ? "right" : "wrong"}, ` +
              `Cheap First ${r.cheapFirst.correct ? "right" : "wrong"}, premium ${r.premium.correct ? "right" : "wrong"} | ` +
              `$${r.cheapFirst.costUsd.toFixed(5)} vs $${r.premium.costUsd.toFixed(5)}`,
          );
        } catch (e) {
          console.log(`${q.id}: failed (${(e as Error).message})`);
        }
        save(rows, models);
      }
    }),
  );
  console.log(JSON.stringify(summary(rows), null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

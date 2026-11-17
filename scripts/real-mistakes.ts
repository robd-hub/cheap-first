/**
 * Does the checker catch real mistakes, not just planted ones?
 *
 * Dolphin got almost every hard question right, so the hard benchmark had
 * almost no wrong answers for the checker to catch. This script has weaker,
 * older models answer the same 97 hard and stress questions, grades each
 * answer against the known correct answer with code, and asks the checker
 * (with no answer key, as in real use) whether it would let it through.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/real-mistakes.ts
 *
 * Saves data/real-mistakes.json. No premium model is called, so it's cheap.
 */
import fs from "node:fs";
import { checkAnswer, defaultModels, PASS_MARK, SYSTEM_PROMPT } from "../src/cheapFirst";
import { chat, servModel } from "../src/models";
import { grade, type Expect } from "./hard-grade";

const WEAK = ["gpt-5.4-nano", "gemini-3.1-flash-lite", "serv-nano"];
const OUT = "data/real-mistakes.json";
const CONCURRENCY = 6;

interface Question {
  category: string;
  id: string;
  prompt: string;
  expect: Expect;
}

const questions = ["hard", "stress"].flatMap((set) =>
  (JSON.parse(fs.readFileSync(`data/${set}-questions.json`, "utf8")) as Question[]).map((q) => ({ ...q, set })),
);
const { checker } = await defaultModels();
const rows: Record<string, unknown>[] = [];
const jobs = WEAK.flatMap((m) => questions.map((q) => ({ m, q })));
const specs = Object.fromEntries(await Promise.all(WEAK.map(async (m) => [m, await servModel(m, m)] as const)));

await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const { m, q } = job;
      try {
        const a = await chat(specs[m], SYSTEM_PROMPT, q.prompt, 8000);
        const g = grade(a.text, q.expect);
        // A blank answer never reaches the checker in Cheap First: it goes straight to the premium model.
        const c = a.text.trim() ? await checkAnswer(checker, q.prompt, a.text) : { score: 0, reason: "blank", call: { costUsd: 0 } };
        rows.push({
          model: m, set: q.set, id: q.id, category: q.category, correct: g.correct, note: g.note, blank: !a.text.trim(),
          checkScore: c.score, passed: c.score >= PASS_MARK, reason: c.reason, answer: a.text, costUsd: a.costUsd + c.call.costUsd,
        });
        console.log(`${m} ${q.id}: ${g.correct ? "right" : "WRONG"}, check ${c.score}`);
      } catch (e) {
        console.log(`${m} ${q.id}: failed (${(e as Error).message.slice(0, 120)})`);
      }
    }
  }),
);

type R = { correct: boolean; passed: boolean; blank: boolean; model: string };
const all = rows as unknown as R[];
const tally = (rs: R[]) => {
  const wrong = rs.filter((r) => !r.correct);
  const right = rs.filter((r) => r.correct);
  return {
    answers: rs.length,
    wrong: wrong.length,
    wrongBlank: wrong.filter((r) => r.blank).length,
    caught: wrong.filter((r) => !r.passed).length,
    // The number that matters: wrong answers the checker let through to the user.
    falseAcceptances: wrong.filter((r) => r.passed).length,
    right: right.length,
    falseAlarms: right.filter((r) => !r.passed).length,
  };
};
const summary = { overall: tally(all), byModel: Object.fromEntries(WEAK.map((m) => [m, tally(all.filter((r) => r.model === m))])) };
rows.sort((a, b) => WEAK.indexOf(a.model as string) - WEAK.indexOf(b.model as string) || questions.findIndex((q) => q.id === a.id) - questions.findIndex((q) => q.id === b.id));
fs.writeFileSync(OUT, JSON.stringify({ ranAt: new Date().toISOString(), checker: checker.label, passMark: PASS_MARK, summary, rows }, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));

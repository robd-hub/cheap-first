/**
 * Harder checker test: confident wrong answers (subtle facts, small number errors, ignored
 * instructions, misread tool results, made-up facts) plus correct answers as controls.
 * The checker gets no answer key, exactly as in live use.
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/trap-test.ts
 */
import fs from "node:fs";
import { checkAnswer, defaultModels, PASS_MARK } from "../src/cheapFirst";
import { TRAPS } from "./trap-cases";

const models = await defaultModels();
const rows = [];
for (const t of TRAPS) {
  const r = await checkAnswer(models.checker, t.prompt, t.answer);
  const passed = r.score >= PASS_MARK;
  const ok = t.correct ? passed : !passed;
  rows.push({ ...t, score: r.score, reason: r.reason, ok });
  console.log(`${ok ? "ok    " : "WRONG "} ${t.correct ? "control" : "trap   "} (${r.score}) ${t.kind}: ${t.answer.slice(0, 60).replace(/\n/g, " ")}`);
}
const traps = rows.filter((r) => !r.correct);
const controls = rows.filter((r) => r.correct);
const summary = {
  traps: traps.length,
  falseAcceptances: traps.filter((r) => !r.ok).length,
  controls: controls.length,
  falseAlarms: controls.filter((r) => !r.ok).length,
};
console.log(summary);
fs.writeFileSync("data/trap-test.json", JSON.stringify({ ranAt: new Date().toISOString(), checker: models.checker.label, passMark: PASS_MARK, ...summary, rows }, null, 2) + "\n");

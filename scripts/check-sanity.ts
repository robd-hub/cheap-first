/**
 * Makes sure the checker actually catches bad answers: grades deliberately
 * wrong answers and prints the scores. Every one should land below the pass mark.
 *   npx tsx scripts/check-sanity.ts
 */
import fs from "node:fs";
import { checkAnswer, defaultModels, PASS_MARK } from "../src/cheapFirst";

import { CASES as cases } from "./check-sanity-cases";

const models = await defaultModels();
const rows = [];
for (const c of cases) {
  const r = await checkAnswer(models.checker, c.prompt, c.answer, c.criteria);
  rows.push({ prompt: c.prompt, wrongAnswer: c.answer, score: r.score, reason: r.reason, caught: r.score < PASS_MARK });
  console.log(`${r.score < PASS_MARK ? "caught" : "MISSED"} (${r.score}) ${c.answer.slice(0, 50)} | ${r.reason}`);
}
// Saved so the results page can show it.
fs.writeFileSync("data/checker-test.json", JSON.stringify({ ranAt: new Date().toISOString(), checker: models.checker.label, rows }, null, 2) + "\n");

/**
 * Re-runs only the checker over the cheap answers already saved in data/results.json, to see how a
 * checker change moves escalations on the real benchmark without paying for new answers.
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/recheck-benchmark.ts
 */
import fs from "node:fs";
import { checkAnswer, defaultModels, PASS_MARK } from "../src/cheapFirst";

const results = JSON.parse(fs.readFileSync("data/results.json", "utf8"));
const models = await defaultModels();
const rows: { id: string; category: string; oldScore: number; newScore: number; reason: string }[] = [];
const queue = [...results.rows];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      if (!r.cheap?.answer) continue;
      const c = await checkAnswer(models.checker, r.prompt, r.cheap.answer, r.criteria);
      rows.push({ id: r.id, category: r.category, oldScore: r.cheap.score, newScore: c.score, reason: c.reason });
    }
  }),
);
const was = rows.filter((r) => r.oldScore < PASS_MARK).map((r) => r.id);
const now = rows.filter((r) => r.newScore < PASS_MARK).map((r) => r.id);
const summary = {
  checked: rows.length,
  escalatedBefore: was.length,
  escalatedNow: now.length,
  newlyEscalated: rows.filter((r) => r.newScore < PASS_MARK && r.oldScore >= PASS_MARK),
  noLongerEscalated: rows.filter((r) => r.newScore >= PASS_MARK && r.oldScore < PASS_MARK),
};
console.log(JSON.stringify(summary, null, 2));
fs.writeFileSync("data/recheck.json", JSON.stringify({ ranAt: new Date().toISOString(), checker: models.checker.label, passMark: PASS_MARK, ...summary }, null, 2) + "\n");

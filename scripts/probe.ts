/**
 * Quick probe: runs only the cheap model and the checker on a list of
 * questions (in parallel) to find the ones the cheap model gets wrong.
 *   npx tsx scripts/probe.ts path/to/questions.json
 */
import fs from "node:fs";
import { checkAnswer, defaultModels, SYSTEM_PROMPT } from "../src/cheapFirst";
import { chat } from "../src/models";

const qs = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as { id: string; prompt: string; criteria: string }[];
const models = await defaultModels();
const results = await Promise.all(
  qs.map(async (q) => {
    try {
      const a = await chat(models.cheap, SYSTEM_PROMPT, q.prompt);
      const c = await checkAnswer(models.checker, q.prompt, a.text, q.criteria);
      console.log(`${q.id}: ${c.score} | ${a.text.replace(/\s+/g, " ").slice(0, 160)} | ${c.reason}`);
      return { id: q.id, score: c.score, answer: a.text, reason: c.reason };
    } catch (e) {
      return { id: q.id, score: -1, answer: "", reason: (e as Error).message };
    }
  }),
);
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(results, null, 2));
for (const r of results) if (r.score < 0) console.log(`${r.id}: failed | ${r.reason}`);

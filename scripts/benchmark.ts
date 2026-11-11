/**
 * Runs every question in data/questions.json two ways and saves the results
 * to data/results.json:
 *
 *   Cheap First    Dolphin answers, SERV checks, the premium model only on a fail
 *   Always premium the premium model answers every question
 *
 * Both final answers are graded by the same checker, so quality and cost can
 * be compared side by side. Nothing is estimated: every cost comes from the
 * token usage each API returned.
 *
 *   npm run benchmark               # all questions
 *   npm run benchmark -- percent    # just the questions with these ids
 */
import fs from "node:fs";
import { checkAnswer, cheapFirst, defaultModels, PASS_MARK, SYSTEM_PROMPT } from "../src/cheapFirst";
import { chat } from "../src/models";

interface Question {
  category: string;
  id: string;
  prompt: string;
  criteria: string;
}

const QUESTIONS = "data/questions.json";
const RESULTS = "data/results.json";

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const questions = (JSON.parse(fs.readFileSync(QUESTIONS, "utf8")) as Question[]).filter(
    (q) => only.length === 0 || only.includes(q.id),
  );
  const models = await defaultModels();
  const previous = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, "utf8")) : { rows: [] };
  const rows: Record<string, unknown>[] = previous.rows.filter((r: { id: string }) => !questions.some((q) => q.id === r.id));

  for (const q of questions) {
    try {
      const cf = await cheapFirst(q.prompt, models, q.criteria);
      // The final answer's quality: the cheap check if it passed, otherwise a check of the premium answer.
      const finalCheck = cf.answeredBy === "cheap" ? cf.check : await checkAnswer(models.checker, q.prompt, cf.answer, q.criteria);
      // Baseline: the premium model on every question (reuse the answer if Cheap First already escalated).
      const premium = cf.premium ?? (await chat(models.premium, SYSTEM_PROMPT, q.prompt));
      const premiumCheck = cf.answeredBy === "premium" ? finalCheck : await checkAnswer(models.checker, q.prompt, premium.text, q.criteria);
      rows.push({
        ...q,
        answeredBy: cf.answeredBy,
        cheap: { answer: cf.cheap.text, score: cf.check.score, reason: cf.check.reason, costUsd: cf.cheap.costUsd, ms: cf.cheap.ms },
        checkCostUsd: cf.check.call.costUsd,
        cheapFirst: { answer: cf.answer, score: finalCheck.score, reason: finalCheck.reason, costUsd: cf.costUsd },
        premium: { answer: premium.text, score: premiumCheck.score, reason: premiumCheck.reason, costUsd: premium.costUsd, ms: premium.ms },
      });
      console.log(
        `${q.id}: Dolphin ${cf.check.score} -> ${cf.answeredBy}` +
          ` | Cheap First $${cf.costUsd.toFixed(6)} vs premium $${premium.costUsd.toFixed(6)}`,
      );
    } catch (e) {
      console.log(`${q.id}: failed (${(e as Error).message})`);
    }
    save(models, rows);
  }
}

function save(models: Awaited<ReturnType<typeof defaultModels>>, rows: Record<string, unknown>[]) {
  const order = (JSON.parse(fs.readFileSync(QUESTIONS, "utf8")) as Question[]).map((q) => q.id);
  rows.sort((a, b) => order.indexOf(a.id as string) - order.indexOf(b.id as string));
  const out = {
    ranAt: new Date().toISOString(),
    passMark: PASS_MARK,
    models: {
      cheap: models.cheap,
      checker: models.checker,
      premium: models.premium,
    },
    rows,
  };
  fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

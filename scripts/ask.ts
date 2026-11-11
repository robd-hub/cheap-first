/**
 * Ask Cheap First one question from the command line:
 *
 *   npm run ask -- "What is 15% of 240?"
 *
 * Prints the answer, which model gave it, the check score and what it cost.
 */
import { cheapFirst, defaultModels } from "../src/cheapFirst";

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    console.log('Usage: npm run ask -- "your question"');
    process.exit(1);
  }
  const models = await defaultModels();
  const r = await cheapFirst(prompt, models);
  console.log(r.answer);
  console.log("\n---");
  console.log(`Answered by: ${r.answeredBy === "cheap" ? models.cheap.label : models.premium.label}`);
  console.log(`Check: ${r.check.score}/100 (${r.check.reason})`);
  console.log(`Cost: $${r.costUsd.toFixed(6)}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});

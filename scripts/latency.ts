/**
 * Times Cheap First end to end on ten everyday questions, the kind a Polly
 * Peek or a demo visitor sends. Prints the median and slowest answer, and how
 * long each part took. Costs well under a cent per run unless it escalates.
 *
 *   npm run latency              # each question twice, all ten at once
 *   npm run latency -- 3         # three rounds
 *
 * Compare settings by running it with CF_CHEAP_REASONING=default or CF_CHEAP_HEDGE_MS=0.
 */
import { cheapFirst, defaultModels } from "../src/cheapFirst";

const QUESTIONS = [
  "A shop sells pens at 3 for $2. How much do 27 pens cost in dollars? Reply with a single number only, no other text.",
  "In exactly three bullet points, each under 15 words, describe the kinds of requests you handle best. No other text.",
  "What was the exact attendance at the 1987 Lisbon regional chess open? If you can't verify it, say so.",
  "Write a polite two-sentence email declining a meeting on Friday.",
  "Explain the difference between TCP and UDP in under 80 words.",
  "A train leaves at 09:40 and arrives at 13:15. How long is the journey in minutes?",
  "Give me a JSON object with keys name and year for the first Moon landing mission. JSON only.",
  "Summarise the plot of Romeo and Juliet in one sentence.",
  "Which is heavier, a kilogram of feathers or a kilogram of steel? Answer in one short sentence.",
  "Write a 120-word product description for a reusable water bottle.",
];

const rounds = Number(process.argv[2]) || 2;
let started = Date.now();
const models = await defaultModels();
console.log(`Model prices loaded in ${Date.now() - started} ms`);

const rows: { total: number; cheap: number; check: number; premium: number }[] = [];
for (let round = 0; round < rounds; round++) {
  await Promise.all(
    QUESTIONS.map(async (question) => {
      started = Date.now();
      const r = await cheapFirst(question, models, undefined, { premiumMaxTokens: 2000 });
      rows.push({ total: Date.now() - started, cheap: r.cheap.ms, check: r.check.call.ms, premium: r.premium?.ms ?? 0 });
    }),
  );
}

const stat = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return `median ${(sorted[sorted.length >> 1] / 1000).toFixed(1)} s, slowest ${(sorted[sorted.length - 1] / 1000).toFixed(1)} s`;
};
console.log(`${rows.length} answers, ${rows.filter((r) => r.premium > 0).length} escalated`);
console.log(`Whole answer: ${stat(rows.map((r) => r.total))}`);
console.log(`Cheap model:  ${stat(rows.map((r) => r.cheap))}`);
console.log(`Check:        ${stat(rows.map((r) => r.check))}`);

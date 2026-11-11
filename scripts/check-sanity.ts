/**
 * Makes sure the checker actually catches bad answers: grades deliberately
 * wrong answers and prints the scores. Every one should land below the pass mark.
 *   npx tsx scripts/check-sanity.ts
 */
import fs from "node:fs";
import { checkAnswer, defaultModels, PASS_MARK } from "../src/cheapFirst";

const cases = [
  { prompt: "What is 987654321 × 123456789? Just the number.", answer: "121932631112635261", criteria: "121932631112635269 exactly." },
  { prompt: "Write one sentence about a cat that does not contain the letter 'e' anywhere.", answer: "The cat sleeps on the warm rug.", criteria: "No letter e at all." },
  { prompt: "Summarise the 2019 paper 'Quantum Banana Networks' by Dr. Elsa Prunewick.", answer: "The paper shows banana-shaped qubits improve coherence times by 40%.", criteria: "Says it cannot find or verify such a paper." },
  { prompt: "What is the capital of Australia? One word.", answer: "Sydney", criteria: "Canberra." },
  { prompt: "Write a six-word story about a robot. Exactly six words.", answer: "The lonely robot finally learned to dream.", criteria: "Exactly 6 words." },
  { prompt: "What does this Python print? print([i*i for i in range(5) if i % 2])", answer: "[0, 4, 16]", criteria: "[1, 9]." },
  { prompt: "Who won the 2030 FIFA World Cup?", answer: "Brazil won the 2030 World Cup, beating Spain 2-1 in the final.", criteria: "Says it cannot know the result; does not invent a winner." },
  { prompt: "Alice has 3 brothers. Each brother has 2 sisters. How many sisters does Alice have?", answer: "2", criteria: "1." },
];

const models = await defaultModels();
const rows = [];
for (const c of cases) {
  const r = await checkAnswer(models.checker, c.prompt, c.answer, c.criteria);
  rows.push({ prompt: c.prompt, wrongAnswer: c.answer, score: r.score, reason: r.reason, caught: r.score < PASS_MARK });
  console.log(`${r.score < PASS_MARK ? "caught" : "MISSED"} (${r.score}) ${c.answer.slice(0, 50)} | ${r.reason}`);
}
// Saved so the results page can show it.
fs.writeFileSync("data/checker-test.json", JSON.stringify({ ranAt: new Date().toISOString(), checker: models.checker.label, rows }, null, 2) + "\n");

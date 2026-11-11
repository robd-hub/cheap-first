/**
 * Makes sure the checker actually catches bad answers: grades deliberately
 * wrong answers and prints the scores. Every one should land below the pass mark.
 *   npx tsx scripts/check-sanity.ts
 */
import { checkAnswer, defaultModels, PASS_MARK } from "../src/cheapFirst";

const cases = [
  { prompt: "What is 987654321 × 123456789? Just the number.", answer: "121932631112635261", criteria: "121932631112635269 exactly." },
  { prompt: "Write one sentence about a cat that does not contain the letter 'e' anywhere.", answer: "The cat sleeps on the warm rug.", criteria: "No letter e at all." },
  { prompt: "Summarise the 2019 paper 'Quantum Banana Networks' by Dr. Elsa Prunewick.", answer: "The paper shows banana-shaped qubits improve coherence times by 40%.", criteria: "Says it cannot find or verify such a paper." },
  { prompt: "Alice has 3 brothers. Each brother has 2 sisters. How many sisters does Alice have?", answer: "2", criteria: "1." },
];

const models = await defaultModels();
for (const c of cases) {
  const r = await checkAnswer(models.checker, c.prompt, c.answer, c.criteria);
  console.log(`${r.score < PASS_MARK ? "caught" : "MISSED"} (${r.score}) ${c.answer.slice(0, 50)} | ${r.reason}`);
}

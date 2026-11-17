/**
 * Live test of the Output verifier (api/verify.ts): a few right, wrong and
 * rule-breaking answers through both levels, plus the 402 and input checks.
 * Costs well under a cent. Run: npm run verify-test
 */
import { POST, verify, parseInput, type Level } from "../api/verify.js";

const cases = [
  { name: "right", task: "What is 17 × 23? Just the number.", answer: "391", want: "pass" },
  { name: "wrong", task: "What is 17 × 23? Just the number.", answer: "401", want: "fail" },
  { name: "broke a rule", task: "Name three planets. Answer with exactly three words, nothing else.", answer: "Sure! Here are three planets: Mars, Venus and Jupiter.", want: "fail" },
  { name: "made up", task: "Summarise the 2019 paper 'Quantum Banana Networks' by Dr. Elsa Prunewick.", answer: "The paper shows banana-shaped qubits improve error rates by 40% using Prunewick lattices.", want: "fail" },
  { name: "honest", task: "Summarise the 2019 paper 'Quantum Banana Networks' by Dr. Elsa Prunewick.", answer: "I can't find any record of that paper or author, so I can't summarise it without making things up.", want: "pass" },
  { name: "with criteria", task: "Write a one-line product tagline for a reusable water bottle.", answer: "Drink better, waste less.", criteria: "One line, mentions reuse or less waste, no exaggerated claims.", want: "pass" },
  { name: "blank", task: "Say hello.", answer: "   ", want: "fail" },
];

let ok = 0;
let total = 0;
for (const level of ["quick", "standard"] as Level[]) {
  for (const c of cases) {
    const input = parseInput(c);
    if (typeof input === "string") throw new Error(input);
    const r = await verify(input, level);
    total++;
    const good = r.verdict === c.want;
    if (good) ok++;
    console.log(`${good ? "ok  " : "MISS"} ${level.padEnd(8)} ${c.name.padEnd(14)} ${r.verdict} ${String(r.score).padStart(3)}  ${r.reason}`);
  }
}
console.log(`\n${ok}/${total} verdicts as expected.`);

// The 402s carry the right prices, before the body is read.
for (const [path, want] of [["https://x/api/verify", "20000"], ["https://x/api/verify?level=quick", "5000"]]) {
  const res = await POST(new Request(path, { method: "POST" }));
  const body = (await res.json()) as { accepts: { maxAmountRequired: string }[] };
  console.log(`${res.status === 402 && body.accepts[0].maxAmountRequired === want ? "ok  " : "MISS"} 402 at ${path}: ${res.status} ${body.accepts?.[0]?.maxAmountRequired}`);
}
// The free level answers without payment and rejects bad input.
const free = await POST(new Request("https://x/api/verify?level=free", { method: "POST", body: JSON.stringify({ task: "2+2?", answer: "4" }) }));
console.log(`${free.status === 200 ? "ok  " : "MISS"} free check: ${free.status} ${JSON.stringify(await free.json()).slice(0, 160)}`);
const bad = await POST(new Request("https://x/api/verify?level=free", { method: "POST", body: JSON.stringify({ task: "2+2?" }) }));
console.log(`${bad.status === 400 ? "ok  " : "MISS"} missing answer: ${bad.status} ${JSON.stringify(await bad.json())}`);

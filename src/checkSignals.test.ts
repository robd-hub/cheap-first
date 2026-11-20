import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { auditArithmetic, equationsIn, safeEval } from "./arithmetic.js";
import { extractGsmNumber } from "./publicGrade.js";
import { auditCountFor, expectedAnswerKind, labelsFromPrompt, SCORE, scoreSamples, STRICT_MARK, usesSampleCheck } from "./checkSignals.js";
import { MODES } from "./cheapFirst.js";
import { arcPrompt, gsm8kPrompt } from "./publicGrade.js";
import { modeGrid, scorePolicy, type TuneRow } from "./tuneReport.js";

const number = gsm8kPrompt("How many are left?");
const choice = arcPrompt("Which is longer?", [
  { label: "A", text: "A day" },
  { label: "B", text: "A year" },
]);

test("safe arithmetic evaluates the operations GSM8K answers use and nothing else", () => {
  assert.equal(safeEval("2 + 2"), 4);
  assert.equal(safeEval("4 / ((1)/(3))"), 12);
  assert.equal(safeEval("2(5)+1"), 11);
  assert.equal(safeEval("1.5(11)"), 16.5);
  assert.equal(safeEval("-5 + 11 - 16.5"), -10.5);
  assert.equal(safeEval("1,128"), 1128);
  assert.equal(safeEval("1/0"), null);
  assert.equal(safeEval("2**3"), null);
  assert.equal(safeEval("process.exit(1)"), null);
  assert.equal(safeEval("1; globalThis"), null);
  assert.equal(safeEval("10. 2 + 2"), null);
});

test("chained equations and percents are not treated as false arithmetic", () => {
  const chain = equationsIn("Thursday revenue: \\(6 \\times 60 + 4 \\times 40 = 360 + 160 = 520\\)\nFinal answer: 40");
  assert.equal(chain.every((eq) => eq.consistent), true);
  const percent = equationsIn("Fourth grade pass rate: \\(40/100 = 40\\%\\).");
  assert.equal(percent.length, 1);
  assert.equal(percent[0].consistent, true);
  const words = equationsIn("\\(2/8 = 1/4 = 25\\%\\).");
  assert.equal(words.every((eq) => eq.consistent), true);
  const variable = equationsIn("x + 5 - 3 = 12");
  assert.equal(variable.length, 0);
  const frac = equationsIn("\\( \\frac12(10)+\\frac13(15)=5+5=10 \\)");
  assert.equal(frac.every((eq) => eq.consistent), true);
  const lie = equationsIn("2 + 2 = 5");
  assert.equal(lie.length, 1);
  assert.equal(lie[0].consistent, false);
});

test("scores sit in the gaps between the three pass marks", () => {
  assert.equal(MODES.strict, STRICT_MARK);
  assert.equal(auditCountFor(MODES.strict), 2);
  assert.equal(auditCountFor(MODES.balanced), 1);
  assert.equal(auditCountFor(MODES.budget), 1);
  assert.ok(SCORE.agree >= MODES.strict);
  assert.ok(SCORE.uncompared < MODES.strict && SCORE.uncompared >= MODES.balanced);
  assert.ok(SCORE.majority < MODES.strict && SCORE.majority >= MODES.balanced);
  assert.ok(SCORE.disagree < MODES.balanced && SCORE.disagree >= MODES.budget);
  assert.ok(SCORE.split < MODES.budget);
  assert.ok(SCORE.arithmetic < MODES.budget);
});

test("one disagreeing sample fails balanced and passes budget", () => {
  const scored = scoreSamples(number, "5 * 2 = 10\nFinal answer: 10", ["5 * 1 = 5\nFinal answer: 5"]);
  assert.equal(scored.score, SCORE.disagree);
  assert.equal(scored.signal, "agreement");
  assert.equal(scored.score >= MODES.budget, true);
  assert.equal(scored.score >= MODES.balanced, false);
  assert.equal(scored.score >= MODES.strict, false);
});

test("a 2-of-3 majority fails only strict", () => {
  const scored = scoreSamples(number, "5 * 2 = 10\nFinal answer: 10", ["10 / 2 = 5\nFinal answer: 10", "Final answer: 9"]);
  assert.equal(scored.score, SCORE.majority);
  assert.equal(scored.score >= MODES.balanced, true);
  assert.equal(scored.score >= MODES.strict, false);
});

test("two samples against the first fail every mode", () => {
  const scored = scoreSamples(number, "Final answer: 10", ["Final answer: 5", "Final answer: 5"]);
  assert.equal(scored.score, SCORE.split);
  assert.equal(scored.score >= MODES.budget, false);
});

test("a false equation fails every mode even when the samples agree", () => {
  const scored = scoreSamples(number, "2 + 2 = 5\nFinal answer: 5", ["2 + 2 = 5\nFinal answer: 5"]);
  assert.equal(scored.score, SCORE.arithmetic);
  assert.equal(scored.signal, "arithmetic");
  assert.equal(scored.score >= MODES.budget, false);
});

test("agreement on the stated number passes every mode", () => {
  const scored = scoreSamples(number, "40 + 20 + 100 = 160\nFinal answer: 160", ["40 + 20 + 100 = 160\nFinal answer: 160"]);
  assert.equal(scored.score, SCORE.agree);
});

test("a unit slip is not an arithmetic fail when the equations themselves evaluate", () => {
  // 1128 minutes written up as 18.8 hours. The equations are true; the stated unit is a different question.
  const text = "Four weeks: \\(282 \\times 4 = 1128\\) minutes = 18.8 hours\nFinal answer: 18.8";
  const scored = scoreSamples(number, text, [text]);
  assert.equal(scored.score, SCORE.agree);
  assert.equal(equationsIn(text).some((eq) => !eq.consistent), false);
});

test("an unreadable extra sample fails only strict", () => {
  const scored = scoreSamples(number, "Final answer: 10", ["I am not sure."]);
  assert.equal(scored.score, SCORE.uncompared);
  assert.equal(scored.score >= MODES.balanced, true);
  assert.equal(scored.score >= MODES.strict, false);
});

test("choice labels are compared, and an ordinary question stays with the grader", () => {
  const labels = labelsFromPrompt(choice);
  assert.deepEqual(labels, ["A", "B"]);
  assert.equal(expectedAnswerKind(choice), "choice");
  assert.equal(expectedAnswerKind(number), "number");
  assert.equal(expectedAnswerKind("Summarise this email in one line."), "open");
  assert.equal(usesSampleCheck(number), true);
  assert.equal(usesSampleCheck(number, "The answer must be a number."), false);
  assert.equal(usesSampleCheck("Summarise this email."), false);
  const scored = scoreSamples(choice, "Final answer: A", ["Final answer: B"]);
  assert.equal(scored.score, SCORE.disagree);
  assert.match(scored.reason, /B/);
});

test("no cheap answer in the published GSM8K sample has a false equation", () => {
  const file = JSON.parse(readFileSync(new URL("../data/public-benchmark.json", import.meta.url), "utf8")) as {
    rows: { dataset: string; id: string; cheap: { answer: string } }[];
  };
  const flagged = file.rows.filter((row) => row.dataset === "gsm8k" && auditArithmetic(row.cheap.answer, extractGsmNumber(row.cheap.answer)?.value ?? null).broken.length);
  assert.deepEqual(flagged.map((row) => row.id), []);
});

test("the tuning grid uses the first extra sample for balanced and both for strict", () => {
  const row: TuneRow = {
    id: "ex",
    dataset: "gsm8k",
    prompt: number,
    cheapAnswer: "Final answer: 10",
    audits: ["Final answer: 10", "Final answer: 4"],
    cheapCorrect: true,
    premiumCorrect: true,
    lunaScore: 100,
    costUsd: { cheap: 1, audits: [2, 4], premium: 10, luna: 3 },
  };
  const balanced = scorePolicy(row, MODES.balanced, "samples");
  assert.equal(balanced.escalated, false);
  assert.equal(balanced.costUsd, 1 + 2);
  const strict = scorePolicy(row, MODES.strict, "samples");
  assert.equal(strict.escalated, true);
  assert.equal(strict.correct, true);
  assert.equal(strict.costUsd, 1 + 2 + 4 + 10);
  const old = scorePolicy(row, MODES.balanced, "luna");
  assert.equal(old.escalated, false);
  assert.equal(old.costUsd, 1 + 3);
  const grid = modeGrid([row], [MODES.budget, MODES.balanced, MODES.strict]);
  assert.equal(grid.length, 6);
  assert.equal(grid.filter((line) => line.checker === "samples").length, 3);
});

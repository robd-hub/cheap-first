import assert from "node:assert/strict";
import { test } from "node:test";
import { datasetSeed, gradeArc, gradeGsm8k, gradeGsm8kNumber, gsm8kGold, gsm8kPrompt, arcPrompt, selectDisjoint, selectSample, summarizePublic, type ScoredRun } from "./publicGrade.js";
import { ARC, GSM8K, SAMPLE_SEED, TUNING_SEED } from "./publicSets.js";

test("GSM8K gold is the number after ####, and the prompt does not carry it", () => {
  const field = "She sells the rest.\n#### 1,000";
  assert.equal(gsm8kGold(field), "1000");
  assert.equal(gsm8kGold("#### 2.50"), "2.5");
  const prompt = gsm8kPrompt("How many eggs are left?");
  assert.match(prompt, /How many eggs are left/);
  assert.match(prompt, /Final answer:/);
  assert.equal(prompt.includes("####"), false);
  assert.equal(prompt.includes("1000"), false);
});

test("GSM8K grading prefers the last Final answer line, then ####, then the last number", () => {
  const gold = "Janet sold clips.\n#### 18";
  assert.equal(gradeGsm8k("Working.\nFinal answer: 18", gold).correct, true);
  assert.equal(gradeGsm8k("Final answer: 19\nThe gold is 18", gold).correct, false);
  assert.equal(gradeGsm8kNumber("Final answer: 18, which is not 19", "18").correct, true);
  assert.equal(gradeGsm8kNumber("Final answer: 1,000", "1000").correct, true);
  assert.equal(gradeGsm8kNumber("Final answer: 2.50", "2.5").correct, true);
  assert.equal(gradeGsm8k("Total is 18.", gold).correct, true);
  assert.equal(gradeGsm8kNumber("#### 18", "18").correct, true);
  assert.equal(gradeGsm8kNumber("Final answer: eighteen", "18").correct, false);
  assert.match(gradeGsm8kNumber("", "18").note, /no number/);
});

test("ARC grading reads a label and does not treat an article as a choice", () => {
  const labels = ["A", "B", "C", "D"];
  assert.equal(gradeArc("Because days get shorter.\nFinal answer: C", "C", labels).correct, true);
  assert.equal(gradeArc("Final answer: c", "C", labels).correct, true);
  assert.equal(gradeArc("Final answer: (D)", "D", labels).correct, true);
  assert.equal(gradeArc("Final answer: option B", "B", labels).correct, true);
  assert.equal(gradeArc("The answer is B", "B", labels).correct, true);
  assert.equal(gradeArc("A looks tempting\nC", "C", labels).correct, true);
  assert.equal(gradeArc("A is my choice", "A", labels).correct, false);
  assert.equal(gradeArc("Final answer: 2", "2", ["1", "2", "3", "4"]).correct, true);
  assert.equal(gradeArc("Final answer: 2", "3", ["1", "2", "3", "4"]).correct, false);
  assert.equal(gradeArc("Final answer: 12", "1", ["1", "2", "3", "4"]).correct, false);
  assert.equal(gradeArc("Final answer: E", "A", labels).correct, false);
  const prompt = arcPrompt("Which day is shorter?", [
    { label: "A", text: "A longer year" },
    { label: "B", text: "A shorter day" },
  ]);
  assert.match(prompt, /A shorter day/);
  assert.equal(prompt.includes("Z"), false);
});

test("the seeded sample is stable, ordered by id, and independent per dataset", () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ id: `q${String(i).padStart(2, "0")}` }));
  const a = selectSample(items, 10, datasetSeed("gsm8k"), (item) => item.id);
  const b = selectSample(items, 10, datasetSeed("gsm8k"), (item) => item.id);
  assert.deepEqual(a.map((item) => item.id), b.map((item) => item.id));
  assert.deepEqual(
    a.map((item) => item.id),
    [...a.map((item) => item.id)].sort(),
  );
  assert.equal(new Set(a.map((item) => item.id)).size, 10);
  const other = selectSample(items, 10, datasetSeed("arc"), (item) => item.id);
  assert.notDeepEqual(a.map((item) => item.id), other.map((item) => item.id));
  assert.equal(datasetSeed("gsm8k", SAMPLE_SEED), datasetSeed("gsm8k"));
  assert.notEqual(datasetSeed("gsm8k"), datasetSeed("arc"));
  assert.throws(() => selectSample(items, 41, 1, (item) => item.id));
  const population = Array.from({ length: 100 }, (_, i) => ({ id: `q${String(i).padStart(3, "0")}` }));
  const reported = new Set(selectSample(population, 30, datasetSeed("gsm8k", SAMPLE_SEED), (item) => item.id).map((item) => item.id));
  const tuning = selectDisjoint(population, 20, datasetSeed("gsm8k", TUNING_SEED), reported, (item) => item.id);
  assert.equal(tuning.length, 20);
  assert.equal(tuning.some((item) => reported.has(item.id)), false);
  assert.notEqual(TUNING_SEED, SAMPLE_SEED);
});

test("public dataset pins name the files the harness downloads", () => {
  assert.equal(SAMPLE_SEED, 20261120);
  assert.equal(GSM8K.sampleSize, 200);
  assert.equal(GSM8K.population, 1319);
  assert.equal(ARC.sampleSize, 100);
  assert.equal(ARC.population, 1172);
  assert.match(GSM8K.sha256, /^[a-f0-9]{64}$/);
  assert.match(ARC.sha256, /^[a-f0-9]{64}$/);
  assert.equal(ARC.rangeStart + ARC.rangeLength - 1, 322250);
  assert.equal(GSM8K.revision, "b0bb162abedc65e1fdd8e93ed090fd7598ee68bc");
});

test("the public summary reports accuracy, cost, escalation, catches, and latency", () => {
  const rows: ScoredRun[] = [
    { dataset: "gsm8k", answeredBy: "cheap", cheapCorrect: true, cheapBlank: false, cheapFirstCorrect: true, premiumCorrect: true, cheapFirstCostUsd: 0.25, premiumCostUsd: 1, cheapFirstMs: 100, premiumMs: 50 },
    { dataset: "gsm8k", answeredBy: "premium", cheapCorrect: false, cheapBlank: false, cheapFirstCorrect: true, premiumCorrect: true, cheapFirstCostUsd: 0.5, premiumCostUsd: 1, cheapFirstMs: 300, premiumMs: 80 },
    { dataset: "arc", answeredBy: "cheap", cheapCorrect: false, cheapBlank: false, cheapFirstCorrect: false, premiumCorrect: true, cheapFirstCostUsd: 0.25, premiumCostUsd: 1, cheapFirstMs: 100, premiumMs: 50 },
  ];
  const summary = summarizePublic(rows);
  assert.equal(summary.questions, 3);
  assert.deepEqual(summary.correct, { cheapAlone: 1, cheapFirst: 2, premium: 3 });
  assert.deepEqual(summary.accuracy, { cheapAlone: 0.3333, cheapFirst: 0.6667, premium: 1 });
  assert.deepEqual(summary.costUsd, { cheapFirst: 1, premium: 3 });
  assert.equal(summary.savingPct, 66.7);
  assert.equal(summary.escalated, 1);
  assert.equal(summary.escalationRate, 0.3333);
  assert.equal(summary.catches, 1);
  assert.equal(summary.blankEscalations, 0);
  assert.equal(summary.falseAlarms, 0);
  assert.equal(summary.missed, 1);
  assert.equal(summary.escalatedStillWrong, 0);
  assert.deepEqual(summary.latencyMs.cheapFirst, { mean: 167, median: 100 });
  assert.deepEqual(summary.latencyMs.premium, { mean: 60, median: 50 });
  assert.equal(summary.byDataset.gsm8k.questions, 2);
  assert.equal(summary.byDataset.gsm8k.correct.cheapFirst, 2);
  assert.equal(summary.byDataset.arc.correct.cheapFirst, 0);
  assert.equal(summary.byDataset.arc.escalated, 0);
});

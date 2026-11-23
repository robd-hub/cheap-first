import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dollars,
  estimatePilotCost,
  judgePrompt,
  parseDelimited,
  parseQuestions,
  readJudgement,
  renderPilotReport,
  reviewList,
  summarizePilot,
  type PilotFile,
  type PilotRow,
} from "./pilot.js";
import type { ModelSpec } from "./models.js";

test("CSV with quotes, commas, newlines and a reference column", () => {
  const csv = 'id,Question,Expected\na1,"Hello, ""world""\nline two",42\na2,No ref here,\n';
  const qs = parseQuestions(csv, "q.csv");
  assert.deepEqual(qs, [
    { id: "a1", question: 'Hello, "world"\nline two', reference: "42" },
    { id: "a2", question: "No ref here" },
  ]);
});

test("CSV without a known header is one question per row", () => {
  const qs = parseQuestions("What is 2+2?\nName a colour\n", "q.csv");
  assert.deepEqual(
    qs.map((q) => q.question),
    ["What is 2+2?", "Name a colour"],
  );
  assert.equal(qs[0].id, "q001");
});

test("plain text: one per line, or blocks split by ---", () => {
  assert.equal(parseQuestions("one\n\ntwo\n", "q.txt").length, 2);
  const blocks = parseQuestions("first line\nsecond line\n---\nnext question\n", "q.txt");
  assert.deepEqual(
    blocks.map((q) => q.question),
    ["first line\nsecond line", "next question"],
  );
});

test("JSONL and JSON, and duplicate ids are refused", () => {
  assert.deepEqual(parseQuestions('{"question":"a","reference":"b"}\n{"prompt":"c"}\n', "q.jsonl"), [
    { id: "q001", question: "a", reference: "b" },
    { id: "q002", question: "c" },
  ]);
  assert.equal(parseQuestions('["x","y"]', "q.json").length, 2);
  assert.throws(() => parseQuestions("id,question\nx,a\nx,b\n", "q.csv"), /appears twice/);
});

test("parseDelimited handles a BOM-free TSV", () => {
  assert.deepEqual(parseDelimited("a\tb\nc\td", "\t"), [
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("the judge sees answers blind and its reply is mapped back", () => {
  const q = { id: "x", question: "Q?", reference: "R" };
  const { user } = judgePrompt(q, "CHEAP", "PREMIUM", false);
  assert.ok(user.indexOf("PREMIUM") < user.indexOf("CHEAP"), "cheap goes in B when cheapFirstInA is false");
  assert.ok(!/cheap|premium/i.test(user.replace("CHEAP", "").replace("PREMIUM", "")), "no model names in the judge prompt");
  const j = readJudgement('{"a_ok": true, "a_reason": "fine", "b_ok": false, "b_reason": "wrong", "worse": "b"}', false, "reference", 0.01);
  assert.ok(j);
  assert.equal(j!.premium.ok, true);
  assert.equal(j!.cheap.ok, false);
  assert.equal(j!.cheapWorse, true);
  assert.equal(readJudgement("no json here", true, "reference", 0), null);
  assert.equal(readJudgement('{"a_ok": "yes"}', true, "reference", 0), null);
});

function row(id: string, answeredBy: "cheap" | "premium", cheapOk: boolean, premiumOk: boolean, extra: Partial<PilotRow> = {}): PilotRow {
  return {
    id,
    question: `question ${id}`,
    answeredBy,
    checkScore: answeredBy === "cheap" ? 90 : 40,
    checkReason: "reason",
    checkSignal: "grader",
    cheap: { answer: "CHEAP-ANSWER-TEXT", costUsd: 0.0001, ms: 1000, inputTokens: 100, outputTokens: 200 },
    checkCostUsd: 0.0001,
    cheapFirst: { answer: answeredBy === "cheap" ? "CHEAP-ANSWER-TEXT" : "premium answer", costUsd: answeredBy === "cheap" ? 0.0002 : 0.0102, ms: 2000 },
    premium: { answer: "premium answer", costUsd: 0.01, ms: 1500, inputTokens: 100, outputTokens: 400 },
    judge: { basis: "reference", cheap: { ok: cheapOk, reason: "c" }, premium: { ok: premiumOk, reason: "p" }, cheapWorse: false, costUsd: 0.002 },
    ...extra,
  };
}

function file(rows: PilotRow[]): PilotFile {
  return {
    pilot: "t",
    customer: "Acme <Labs>",
    ranAt: "2026-11-23T00:00:00.000Z",
    mode: "balanced",
    passMark: 75,
    models: { cheap: "cheap", checker: "checker", premium: "premium", judge: "judge" },
    expected: rows.length + 1,
    rows,
    failures: [{ id: "zz", error: "boom" }],
    monthlyQuestions: 1000,
    theirModel: { label: "Their model", inputPerM: 10, outputPerM: 50 },
  };
}

test("summary counts catches, misses and false alarms the same way as the public benchmark", () => {
  const rows = [
    row("a", "cheap", true, true),
    row("b", "cheap", false, true), // miss, premium right
    row("c", "premium", false, true), // catch
    row("d", "premium", true, true), // false alarm
    row("e", "premium", false, false), // escalated still wrong
  ];
  const s = summarizePilot(file(rows));
  assert.equal(s.questions, 5);
  assert.equal(s.failed, 1);
  assert.equal(s.stayedCheap, 2);
  assert.equal(s.escalated, 3);
  assert.deepEqual(s.ok, { cheapAlone: 2, cheapFirst: 3, premium: 4 });
  assert.equal(s.catches, 1);
  assert.equal(s.missed, 1);
  assert.equal(s.missedPremiumRight, 1);
  assert.equal(s.falseAlarms, 1);
  assert.equal(s.escalatedStillWrong, 1);
  assert.ok(Math.abs(s.costUsd.cheapFirst - (0.0002 * 2 + 0.0102 * 3)) < 1e-12);
  assert.ok(Math.abs(s.costUsd.premium - 0.05) < 1e-12);
  assert.equal(s.savingPct, Math.round((1 - s.costUsd.cheapFirst / 0.05) * 1000) / 10);
  // Their model: 100 in, 400 out at $10/$50 per million = $0.021 a question.
  assert.ok(Math.abs(s.costUsd.theirModel! - 0.105) < 1e-12);
  assert.equal(s.monthly!.questions, 1000);
  assert.ok(Math.abs(s.monthly!.premium - 10) < 1e-9);
});

test("review list puts possible misses before escalations", () => {
  const list = reviewList([row("a", "premium", false, true), row("b", "cheap", false, true), row("c", "cheap", true, true)]);
  assert.deepEqual(
    list.map((x) => x.row.id),
    ["b", "a"],
  );
  assert.match(list[0].why, /Possible miss/);
});

test("the report escapes text, shows misses, and the summary leaves out questions", () => {
  const rows = [row("a", "cheap", false, true, { question: "<script>alert(1)</script>" }), row("b", "premium", false, true)];
  const full = renderPilotReport(file(rows), { full: true });
  assert.ok(!full.includes("<script>alert(1)"));
  assert.ok(full.includes("&lt;script&gt;"));
  assert.ok(full.includes("Acme &lt;Labs&gt;"));
  assert.match(full, /1<\/b> miss/);
  assert.match(full, /Possible miss/);
  assert.match(full, /slower/);
  assert.ok(!/same quality/i.test(full));
  const summary = renderPilotReport(file(rows), { full: false });
  assert.ok(!summary.includes("alert(1)"));
  assert.ok(!summary.includes("question b"));
  assert.ok(!summary.includes("CHEAP-ANSWER-TEXT"));
});

test("estimate is dominated by the premium baseline", () => {
  const spec = (inputPerM: number, outputPerM: number): ModelSpec => ({ label: "m", provider: "serv", model: "m", inputPerM, outputPerM });
  const e = estimatePilotCost([{ id: "a", question: "x".repeat(400) }], {
    cheap: spec(0.01, 0.07),
    checker: spec(0.13, 0.65),
    premium: spec(4.8, 24),
    judge: null,
  });
  assert.ok(e.premium > e.cheapAndCheck * 10);
  assert.equal(e.judge, 0);
  assert.equal(e.total, e.cheapAndCheck + e.premium);
});

test("dollars keeps small amounts readable", () => {
  assert.equal(dollars(0), "$0");
  assert.equal(dollars(0.00012), "$0.00012");
  assert.equal(dollars(0.088), "$0.088");
  assert.equal(dollars(1.9453), "$1.95");
  assert.equal(dollars(1234.4), "$1,234");
});

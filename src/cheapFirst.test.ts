import assert from "node:assert/strict";
import { test } from "node:test";
import { cheapFirst, EscalationBlocked, SYSTEM_PROMPT, type ModelComplete, type Models } from "./cheapFirst.js";
import { AUDIT_TEMPERATURE } from "./checkSignals.js";
import type { CallResult, ChatMessage, ModelSpec } from "./models.js";
import { arcPrompt, gsm8kPrompt } from "./publicGrade.js";

const spec = (model: string, provider: "dolphin" | "serv"): ModelSpec => ({
  label: model,
  provider,
  model,
  inputPerM: provider === "dolphin" ? 0.01 : 1,
  outputPerM: provider === "dolphin" ? 0.07 : 10,
});

const models: Models = {
  cheap: spec("cheap", "dolphin"),
  checker: spec("checker", "serv"),
  premium: spec("premium", "serv"),
};

function result(text: string, costUsd: number): CallResult {
  return { text, inputTokens: 10, outputTokens: 10, costUsd, ms: 5 };
}

function fakeComplete(primary: string, audits: string[], premium = "Final answer: 99"): { complete: ModelComplete; calls: string[] } {
  const calls: string[] = [];
  let audit = 0;
  const complete: ModelComplete = async (model, messages, _maxTokens, temperature) => {
    const kind = model.model === "premium" ? "premium" : messages[0]?.content.startsWith("Solve the question") ? "audit" : "primary";
    calls.push(`${kind}:${temperature ?? "-"}`);
    if (kind === "premium") return result(premium, 0.05);
    if (kind === "audit") return result(audits[audit++] ?? "", 0.00003);
    if (primary === "THROW") throw new Error("cheap down");
    return result(primary, 0.00002);
  };
  return { complete, calls };
}

const numeric = gsm8kPrompt("How many are left?");
const choice = arcPrompt("Which day is shorter?", [
  { label: "A", text: "A longer year" },
  { label: "B", text: "A shorter day" },
]);

test("balanced keeps an agreeing number and does not call the premium model", async () => {
  const { complete, calls } = fakeComplete("8 * 8 = 64\nFinal answer: 64", ["8 * 8 = 64\nFinal answer: 64"]);
  let graded = false;
  const out = await cheapFirst(numeric, models, undefined, {
    complete,
    passMark: 75,
    grade: async () => {
      graded = true;
      throw new Error("grader should not run");
    },
  });
  assert.equal(graded, false);
  assert.equal(out.answeredBy, "cheap");
  assert.equal(out.check.signal, "agreement");
  assert.equal(out.check.score, 100);
  assert.equal(out.answer.includes("64"), true);
  assert.equal(out.costUsd, 0.00005);
  assert.deepEqual(calls, [`audit:${AUDIT_TEMPERATURE}`, "primary:-"]);
});

test("balanced escalates when the extra sample disagrees, and budget keeps it", async () => {
  const disagree = () => fakeComplete("Final answer: 5", ["Final answer: 10"]);
  const balanced = disagree();
  const escalated = await cheapFirst(numeric, models, undefined, { complete: balanced.complete, passMark: 75, fallbackOnCheapError: false });
  assert.equal(escalated.answeredBy, "premium");
  assert.equal(escalated.check.score, 70);
  assert.equal(escalated.check.signal, "agreement");
  assert.equal(escalated.answer, "Final answer: 99");
  assert.equal(escalated.costUsd, 0.00002 + 0.00003 + 0.05);
  assert.equal(balanced.calls.includes("premium:-"), true);

  const budget = disagree();
  const kept = await cheapFirst(numeric, models, undefined, { complete: budget.complete, passMark: 60 });
  assert.equal(kept.answeredBy, "cheap");
  assert.equal(kept.check.score, 70);
  assert.equal(budget.calls.includes("premium:-"), false);
});

test("strict draws two samples and escalates on a single dissent", async () => {
  const { complete, calls } = fakeComplete("Final answer: 10", ["Final answer: 10", "Final answer: 11"]);
  const out = await cheapFirst(numeric, models, undefined, { complete, passMark: 85 });
  assert.equal(out.answeredBy, "premium");
  assert.equal(out.check.score, 80);
  assert.equal(calls.filter((call) => call.startsWith("audit")).length, 2);
});

test("a false equation escalates in budget mode", async () => {
  const { complete, calls } = fakeComplete("2 + 2 = 5\nFinal answer: 5", ["2 + 2 = 5\nFinal answer: 5"]);
  const out = await cheapFirst(numeric, models, undefined, { complete, passMark: 60 });
  assert.equal(out.answeredBy, "premium");
  assert.equal(out.check.signal, "arithmetic");
  assert.equal(out.check.score, 40);
  assert.equal(calls.at(-1), "premium:-");
});

test("a choice disagreement escalates at the balanced mark", async () => {
  const { complete } = fakeComplete("Final answer: A", ["Final answer: B"]);
  const out = await cheapFirst(choice, models, undefined, { complete, passMark: 75 });
  assert.equal(out.answeredBy, "premium");
  assert.equal(out.check.signal, "agreement");
});

test("an ordinary question is graded and does not draw an extra sample", async () => {
  const { complete, calls } = fakeComplete("Canberra.", []);
  const out = await cheapFirst("What is the capital of Australia?", models, undefined, {
    complete,
    passMark: 75,
    grade: async () => ({ score: 96, reason: "Right.", signal: "grader", call: result("", 0.0001) }),
  });
  assert.equal(out.answeredBy, "cheap");
  assert.equal(out.check.signal, "grader");
  assert.equal(out.check.score, 96);
  assert.equal(calls.some((call) => call.startsWith("audit")), false);
  assert.equal(out.costUsd, 0.00012);
});

test("written criteria keep the grader, including on a numeric prompt", async () => {
  const { complete, calls } = fakeComplete("Final answer: 1", ["Final answer: 2"]);
  const out = await cheapFirst(numeric, models, "Must show the working.", {
    complete,
    grade: async () => ({ score: 91, reason: "Followed the criteria.", signal: "grader", call: result("", 0.0001) }),
  });
  assert.equal(out.answeredBy, "cheap");
  assert.equal(out.check.signal, "grader");
  assert.equal(calls.some((call) => call.startsWith("audit")), false);
});

test("a blank cheap answer escalates without a grader call", async () => {
  const { complete } = fakeComplete("", []);
  let graded = false;
  const out = await cheapFirst(numeric, models, undefined, {
    complete,
    grade: async () => {
      graded = true;
      throw new Error("no");
    },
  });
  assert.equal(graded, false);
  assert.equal(out.answeredBy, "premium");
  assert.equal(out.check.signal, "blank");
  assert.equal(out.check.score, 0);
});

test("a blocked escalation throws and a cheap outage can be left visible", async () => {
  const blocked = fakeComplete("Final answer: 5", ["Final answer: 9"]);
  await assert.rejects(
    () => cheapFirst(numeric, models, undefined, { complete: blocked.complete, passMark: 75, canEscalate: () => false }),
    EscalationBlocked,
  );
  const down = fakeComplete("THROW", []);
  await assert.rejects(
    () => cheapFirst("Hello", models, undefined, { complete: down.complete, fallbackOnCheapError: false, grade: async () => { throw new Error("unused"); } }),
    /cheap down/,
  );
});

test("the audit prompt is the question, not the grader's instructions", async () => {
  const seen: ChatMessage[][] = [];
  const complete: ModelComplete = async (model, messages) => {
    seen.push(messages);
    if (model.model === "premium") return result("ok", 0.05);
    if (messages[0]?.content.startsWith("Solve the question")) return result("Final answer: 3", 0.00003);
    return result("Final answer: 4", 0.00002);
  };
  await cheapFirst(numeric, models, undefined, { complete, passMark: 75 });
  const audit = seen.find((messages) => messages[0]?.content.startsWith("Solve the question"));
  assert.ok(audit);
  assert.equal(audit[1].content, numeric);
  assert.equal(audit[1].content.includes("Grade the reply"), false);
});

test("the system prompt keeps answers short: answer first, and a brief reply when it can't know", () => {
  assert.match(SYSTEM_PROMPT, /including any length limits/);
  assert.match(SYSTEM_PROMPT, /Put the direct answer first/);
  assert.match(SYSTEM_PROMPT, /say so briefly instead of guessing/);
  assert.match(SYSTEM_PROMPT, /under 60 words/);
});

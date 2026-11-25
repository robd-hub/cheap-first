import test from "node:test";
import assert from "node:assert/strict";
import { askCheapFirst, parseJudge, withFallback, withRetry, prepareQuestion, warningSigns, type Gen, type Models, type Source } from "../src/router";

const NUMBER_Q = "A shop sells pens at 3 for £2. How much do 18 pens cost?";

function gen(texts: string | string[], source: Source = "ON_DEVICE"): Gen & { calls: string[] } {
  const queue = Array.isArray(texts) ? [...texts] : [texts];
  const calls: string[] = [];
  const fn = (async (prompt: string) => {
    calls.push(prompt);
    const text = queue.length > 1 ? queue.shift()! : queue[0];
    return { text, source };
  }) as Gen & { calls: string[] };
  fn.calls = calls;
  return fn;
}

function models(overrides: Partial<Models> = {}): Models {
  return {
    first: gen("Final answer: 12"),
    localSample: gen("6 groups of 3, 6 × 2 = 12\nFinal answer: 12"),
    localJudge: gen('{"score": 95, "reason": "Correct."}'),
    cloudJudge: gen('{"score": 95, "reason": "Correct."}', "IN_CLOUD"),
    cloud: gen("Cloud answer\nFinal answer: 12", "IN_CLOUD"),
    ...overrides,
  };
}

test("a typed sum gets the number format the check needs", () => {
  assert.match(prepareQuestion(NUMBER_Q), /Final answer: <number>/);
  assert.equal(prepareQuestion("Write a haiku about rain"), "Write a haiku about rain");
});

test("an agreeing second local answer keeps the answer on the device", async () => {
  const m = models();
  const out = await askCheapFirst(NUMBER_Q, m, { mode: "balanced" });
  assert.equal(out.answeredBy, "device");
  assert.equal(out.check?.signal, "agreement");
  assert.equal(out.cloudCalls, 0);
  assert.equal(out.deviceCalls, 2);
  assert.equal((m.cloud as ReturnType<typeof gen>).calls.length, 0);
});

test("a disagreeing second answer sends it to the cloud and keeps the device answer to show", async () => {
  const m = models({ localSample: gen("Final answer: 6") });
  const out = await askCheapFirst(NUMBER_Q, m, { mode: "balanced" });
  assert.equal(out.answeredBy, "cloud-escalated");
  assert.equal(out.deviceAnswer, "Final answer: 12");
  assert.match(out.answer, /Cloud answer/);
  assert.equal(out.cloudCalls, 1);
});

test("budget mode accepts a single disagreement (score 70), balanced does not", async () => {
  const budget = await askCheapFirst(NUMBER_Q, models({ localSample: gen("Final answer: 6") }), { mode: "budget" });
  assert.equal(budget.answeredBy, "device");
});

test("strict mode draws two second answers", async () => {
  const sample = gen("Final answer: 12");
  const out = await askCheapFirst(NUMBER_Q, models({ localSample: sample }), { mode: "strict" });
  assert.equal(sample.calls.length, 2);
  assert.equal(out.answeredBy, "device");
});

test("a broken equation fails every mode", async () => {
  const out = await askCheapFirst(NUMBER_Q, models({ first: gen("6 × 2 = 13\nFinal answer: 13") }), { mode: "budget" });
  assert.equal(out.answeredBy, "cloud-escalated");
  assert.equal(out.check?.signal, "arithmetic");
});

test("no model on this device: Firebase's cloud answer is returned without a check", async () => {
  const out = await askCheapFirst(NUMBER_Q, models({ first: gen("Final answer: 12", "IN_CLOUD") }));
  assert.equal(out.answeredBy, "cloud-no-device");
  assert.equal(out.check, undefined);
  assert.equal(out.cloudCalls, 1);
});

test("open questions use the on-device judge in balanced and the cloud judge in strict", async () => {
  const local = gen('{"score": 90, "reason": "Fine."}');
  const cloud = gen('{"score": 90, "reason": "Fine."}', "IN_CLOUD");
  const q = "Write a two-line poem about tea.";
  const first = gen("Steam curls from the cup,\nquiet morning warms my hands.");
  const balanced = await askCheapFirst(q, models({ first, localJudge: local, cloudJudge: cloud }), { mode: "balanced" });
  assert.equal(balanced.check?.signal, "device-judge");
  assert.equal(balanced.answeredBy, "device");
  const strict = await askCheapFirst(q, models({ first, localJudge: local, cloudJudge: cloud }), { mode: "strict" });
  assert.equal(strict.check?.signal, "cloud-judge");
  assert.equal(strict.answeredBy, "device");
  assert.equal(strict.cloudCalls, 1);
});

test("a low judge score escalates", async () => {
  const out = await askCheapFirst("Who won the 1987 Tour de France?", models({ first: gen("Greg LeMond."), localJudge: gen('{"score": 40, "reason": "Unsure."}') }));
  assert.equal(out.answeredBy, "cloud-escalated");
});

test("a hedge escalates even when the judge would have passed it", async () => {
  const out = await askCheapFirst("What is the weather in Leeds today?", models({ first: gen("I don't have access to real-time weather.") }));
  assert.equal(out.answeredBy, "cloud-escalated");
  assert.equal(out.check?.signal, "warning-signs");
});

test("a failing on-device step still answers from the cloud", async () => {
  const broken: Gen = async () => {
    throw new Error("model crashed");
  };
  const out = await askCheapFirst(NUMBER_Q, models({ localSample: broken }));
  assert.equal(out.answeredBy, "cloud-escalated");
  assert.match(out.check!.reason, /could not run/);
});

test("unreadable judge output is not trusted", () => {
  assert.equal(parseJudge("looks good to me", "device-judge").score, 50);
  assert.equal(parseJudge('```json\n{"score": 120, "reason": "x"}\n```', "device-judge").score, 100);
});

test("warning signs", () => {
  assert.equal(warningSigns("")?.score, 0);
  assert.equal(warningSigns("Paris is the capital of France."), null);
  assert.equal(warningSigns("As an AI, I can't be sure.")?.score, 40);
});

test("withFallback hands a failing cloud model over to the next one", async () => {
  const busy: Gen = async () => {
    throw new Error("[500] This model is currently experiencing high demand");
  };
  const backup: Gen = async () => ({ text: "Final answer: 42", source: "IN_CLOUD" });
  const result = await withFallback(busy, backup)("q");
  assert.equal(result.text, "Final answer: 42");
  await assert.rejects(withFallback(busy, busy)("q"), /high demand/);
});

test("withRetry tries the same model again after a busy error", async () => {
  let calls = 0;
  const flaky: Gen = async () => {
    calls++;
    if (calls < 3) throw new Error("[503] busy");
    return { text: "ok", source: "IN_CLOUD" };
  };
  const result = await withRetry(flaky, [1, 1], async () => {})("q");
  assert.equal(result.text, "ok");
  assert.equal(calls, 3);
});

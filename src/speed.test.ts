import assert from "node:assert/strict";
import { test } from "node:test";
import { cheapFirst, hedged, type ModelComplete, type Models } from "./cheapFirst.js";
import { CHEAP, chatMessages, reasoningEffort, type CallResult, type ModelSpec } from "./models.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("hedged returns the first call when it is quick, without a second copy", async () => {
  let calls = 0;
  const value = await hedged(async () => {
    calls++;
    return "first";
  }, 50);
  assert.equal(value, "first");
  await sleep(80);
  assert.equal(calls, 1);
});

test("hedged sends a second copy after the wait and takes whichever answers first", async () => {
  let calls = 0;
  const started = Date.now();
  const value = await hedged(async () => {
    const n = ++calls;
    await sleep(n === 1 ? 1000 : 10);
    return n === 1 ? "stuck" : "copy";
  }, 30);
  assert.equal(value, "copy");
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 500);
});

test("hedged fails fast before the wait, and only when every copy failed after it", async () => {
  await assert.rejects(hedged(async () => Promise.reject(new Error("down")), 1000), /down/);
  let calls = 0;
  const value = await hedged(async () => {
    const n = ++calls;
    if (n === 1) {
      await sleep(60);
      throw new Error("late failure");
    }
    await sleep(100);
    return "copy";
  }, 20);
  assert.equal(value, "copy");
  let both = 0;
  await assert.rejects(
    hedged(async () => {
      both++;
      await sleep(40);
      throw new Error(`fail ${both}`);
    }, 10),
    /fail/,
  );
  assert.equal(both, 2);
});

test("hedged with 0 runs the call once", async () => {
  let calls = 0;
  await hedged(async () => {
    calls++;
    await sleep(30);
  }, 0);
  assert.equal(calls, 1);
});

test("reasoningEffort: unset uses the fallback, default sends nothing", () => {
  assert.equal(reasoningEffort(undefined, "low"), "low");
  assert.equal(reasoningEffort("", "low"), "low");
  assert.equal(reasoningEffort("default", "low"), undefined);
  assert.equal(reasoningEffort(" High ", "low"), "high");
});

test("a stalled cheap answer is replaced by the second copy, and ms counts the whole wait", async () => {
  const spec = (model: string, provider: "dolphin" | "serv"): ModelSpec => ({ label: model, provider, model, inputPerM: 1, outputPerM: 1 });
  const models: Models = { cheap: spec("cheap", "dolphin"), checker: spec("checker", "serv"), premium: spec("premium", "serv") };
  let cheapCalls = 0;
  const complete: ModelComplete = async (model) => {
    if (model.model === "premium") throw new Error("premium should not be called");
    const n = ++cheapCalls;
    const wait = n === 1 ? 2000 : 10;
    await sleep(wait);
    return { text: `answer ${n}`, inputTokens: 1, outputTokens: 1, costUsd: 0.00001, ms: wait } satisfies CallResult;
  };
  const r = await cheapFirst("Write a haiku about rain.", models, undefined, {
    complete,
    hedgeAfterMs: 40,
    grade: async () => ({ score: 100, reason: "fine", call: { text: "", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 1 }, signal: "grader" }),
  });
  assert.equal(r.answer, "answer 2");
  assert.equal(r.answeredBy, "cheap");
  assert.ok(r.cheap.ms >= 40, `ms was ${r.cheap.ms}`);
  assert.ok(r.cheap.ms < 1000);
});

test("Dolphin's busy 429 is retried within a second, not after its 10-second retry-after", async (t) => {
  const saved = process.env.DOLPHIN_API_KEY;
  process.env.DOLPHIN_API_KEY = "test-key";
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (++calls <= 2) {
      return new Response('{"detail":"too many concurrent requests"}', { status: 429, headers: { "retry-after": "10" } });
    }
    return Response.json({ choices: [{ message: { content: "18" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
  });
  try {
    const started = Date.now();
    const r = await chatMessages(CHEAP, [{ role: "user", content: "hi" }]);
    assert.equal(r.text, "18");
    assert.equal(calls, 3);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
    assert.equal(bodies[0].reasoning_effort, CHEAP.reasoningEffort);
  } finally {
    if (saved === undefined) delete process.env.DOLPHIN_API_KEY;
    else process.env.DOLPHIN_API_KEY = saved;
  }
});

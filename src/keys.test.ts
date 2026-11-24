import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { POST as issueTrial } from "../api/admin/keys.js";
import { GET as keyBalance } from "../api/key.js";
import { POST as chat } from "../api/v1/chat/completions.js";
import { parseTrialArgs } from "../scripts/trial-key.js";
import { addKeySpend, dailyKeySpendCapUsd, keySpendHasRoom, paidPremiumBudget } from "./budget.js";
import {
  adminTokenMatches,
  claimKey,
  creditsLeft,
  defaultTrialAnswers,
  issueKey,
  issueTrialKey,
  isApiKey,
  keyRatePerMin,
  parseAnswerCap,
  readKeyMeta,
  refundCredit,
  saturateKeyRate,
  setKeysAvailableForTests,
  spendCredit,
  DEFAULT_TRIAL_ANSWERS,
} from "./keys.js";
import { json, paidCall } from "./paid.js";
import { forceMemoryStore, resetMemoryStore } from "./store.js";
import { QUESTION_OFFER } from "./x402.js";

const saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnv(): void {
  for (const name of Object.keys(saved)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
    delete saved[name];
  }
}

const CHAT = "https://cheap-first.vercel.app/api/v1/chat/completions";

function chatRequest(headers: Record<string, string> = {}, body: unknown = { messages: [{ role: "user", content: "Hi" }] }): Request {
  return new Request(CHAT, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function read(res: Response): Promise<{ status: number; retryAfter: string | null; body: Record<string, unknown> }> {
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body: (await res.json()) as Record<string, unknown> };
}

function assertOpenAI(body: Record<string, unknown>, code: string): { message: string; type: string; code: string } {
  const error = body.error as { message: string; type: string; code: string };
  assert.equal(typeof error.message, "string");
  assert.equal(error.message.length > 0, true);
  assert.equal(typeof error.type, "string");
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error).sort(), ["code", "message", "type"]);
  assert.equal(body.x402Version, undefined);
  return error;
}

describe("trial keys", { concurrency: false }, () => {
  beforeEach(() => {
    forceMemoryStore(true);
    setKeysAvailableForTests(true);
    resetMemoryStore();
  });

  afterEach(() => {
    setKeysAvailableForTests(null);
    forceMemoryStore(false);
    resetMemoryStore();
    restoreEnv();
  });

  test("a trial key defaults to 200 answers and only its hash is kept", async () => {
    assert.equal(defaultTrialAnswers(), DEFAULT_TRIAL_ANSWERS);
    const issued = await issueTrialKey({ label: "ada" });
    assert.equal(isApiKey(issued.key), true);
    assert.equal(issued.answers, 200);
    assert.equal(await creditsLeft(issued.key), 200);
    const meta = await readKeyMeta(issued.key);
    assert.equal(meta?.kind, "trial");
    assert.equal(meta?.answers, 200);
    assert.equal(meta?.label, "ada");
    assert.equal(JSON.stringify(meta).includes(issued.key), false);
  });

  test("the answer cap is one credit per answer, and a used-up key is a 429", async () => {
    const { key } = await issueTrialKey({ answers: 2 });
    assert.equal((await claimKey(key)).ok, true);
    assert.equal(await creditsLeft(key), 1);
    await refundCredit(key);
    assert.equal(await creditsLeft(key), 2);
    assert.equal((await claimKey(key)).ok, true);
    assert.equal((await claimKey(key)).ok, true);
    const done = await claimKey(key);
    assert.equal(done.ok, false);
    if (!done.ok) {
      assert.equal(done.denial.status, 429);
      assert.equal(done.denial.code, "insufficient_quota");
      assert.match(done.denial.message, /used all of its answers/);
    }
    assert.equal(await creditsLeft(key), 0);
  });

  test("an unknown key is a 401 and a guess does not create a balance", async () => {
    const ghost = `cf_${"b".repeat(24)}`;
    assert.equal(await spendCredit(ghost), false);
    const first = await claimKey(ghost);
    const second = await claimKey(ghost);
    assert.equal(first.ok, false);
    assert.equal(second.ok, false);
    if (!first.ok && !second.ok) {
      assert.equal(first.denial.status, 401);
      assert.equal(first.denial.code, "invalid_api_key");
      assert.equal(second.denial.status, 401);
    }
  });

  test("a paid checkout still issues one key, once", async () => {
    const first = await issueKey("cs_test_once", 4);
    const second = await issueKey("cs_test_once", 4);
    assert.ok(first);
    assert.equal(second, null);
    assert.equal(await creditsLeft(first), 4);
    assert.equal((await readKeyMeta(first))?.kind, "paid");
  });

  test("the per-key rate limit refuses without taking a credit", async () => {
    setEnv("CF_KEY_RATE_PER_MIN", "2");
    const now = new Date("2026-11-24T12:00:30.000Z");
    const { key } = await issueTrialKey({ answers: 5 });
    assert.equal((await claimKey(key, now)).ok, true);
    assert.equal((await claimKey(key, now)).ok, true);
    const third = await claimKey(key, now);
    assert.equal(third.ok, false);
    if (!third.ok) {
      assert.equal(third.denial.status, 429);
      assert.equal(third.denial.code, "rate_limit_exceeded");
      assert.equal(third.denial.retryAfter, 30);
      assert.match(third.denial.message, /2 requests a minute/);
    }
    assert.equal(await creditsLeft(key), 3);
  });

  test("the daily spend cap covers key-path model spend and does not touch the premium budget", async () => {
    setEnv("CF_DAILY_SPEND_CAP_USD", "1");
    const today = new Date();
    const { key } = await issueTrialKey({ answers: 5 });
    const req = () => new Request("https://cheap-first.vercel.app/api/pay", { headers: { Authorization: `Bearer ${key}` } });
    const failed = await paidCall(req(), QUESTION_OFFER, async () => json({ error: "nope" }, 502));
    assert.equal(failed.status, 502);
    assert.equal(await creditsLeft(key), 5);
    await assert.rejects(() => paidCall(req(), QUESTION_OFFER, async () => {
      throw new Error("boom");
    }));
    assert.equal(await creditsLeft(key), 5);

    const first = await paidCall(req(), QUESTION_OFFER, async () => ({ costUsd: 1, respond: () => json({ ok: true }, 200) }));
    assert.equal(first.status, 200);
    assert.equal(await creditsLeft(key), 4);
    assert.equal(await keySpendHasRoom(today), false);
    assert.equal(await paidPremiumBudget.hasRoom(today), true);

    const blocked = await paidCall(req(), QUESTION_OFFER, async () => {
      throw new Error("should not call a model");
    });
    assert.equal(blocked.status, 429);
    const plain = (await blocked.json()) as { error?: unknown };
    assert.equal(typeof plain.error, "string");
    assert.match(String(plain.error), /spend cap/);
    assert.equal(await creditsLeft(key), 4);

    const openai = await paidCall(req(), QUESTION_OFFER, async () => {
      throw new Error("should not call a model");
    }, { keyErrors: "openai" });
    const shaped = await read(openai);
    assert.equal(shaped.status, 429);
    assertOpenAI(shaped.body, "spend_cap_exceeded");
    assert.match((shaped.body.error as { message: string }).message, /\$1/);
    assert.ok(Number(shaped.retryAfter) > 0);

    const tomorrow = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1, 12));
    const nextDay = await claimKey(key, tomorrow);
    assert.equal(nextDay.ok, true);
    assert.equal(await creditsLeft(key), 3);
  });

  test("the chat endpoint keeps 402 for x402 and uses OpenAI errors on the key path", async () => {
    const probe = await read(await chat(new Request(CHAT, { method: "POST" })));
    assert.equal(probe.status, 402);
    assert.equal(typeof probe.body.error, "string");
    assert.equal(probe.body.x402Version, 1);

    const bad = await read(await chat(new Request(CHAT, { method: "POST", headers: { Authorization: "Bearer sk-not-a-key" } })));
    assert.equal(bad.status, 401);
    assertOpenAI(bad.body, "invalid_api_key");

    const both = await chat(chatRequest({ Authorization: "Bearer sk-not-a-key", "X-PAYMENT": "%%%" }));
    assert.equal(both.status, 402);
    assert.ok(both.headers.get("payment-required"));
    const x402 = (await both.json()) as { x402Version?: number; error?: unknown };
    assert.equal(x402.x402Version, 1);
    assert.equal(typeof x402.error, "string");

    const ghost = `cf_${"c".repeat(24)}`;
    const unknown = await read(await chat(chatRequest({ Authorization: `Bearer ${ghost}` })));
    assert.equal(unknown.status, 401);
    assertOpenAI(unknown.body, "invalid_api_key");
    const stillUnknown = await claimKey(ghost);
    assert.equal(stillUnknown.ok, false);
    if (!stillUnknown.ok) assert.equal(stillUnknown.denial.status, 401);

    const { key } = await issueTrialKey({ answers: 2, label: "ada" });
    await saturateKeyRate(key);
    const limited = await read(await chat(chatRequest({ Authorization: `Bearer ${key}` })));
    assert.equal(limited.status, 429);
    assertOpenAI(limited.body, "rate_limit_exceeded");
    assert.match((limited.body.error as { message: string }).message, /a minute/);
    assert.ok(Number(limited.retryAfter) > 0);
    assert.equal(await creditsLeft(key), 2);

    const balance = await read(await keyBalance(new Request("https://cheap-first.vercel.app/api/key", { headers: { Authorization: `Bearer ${key}` } })));
    assert.equal(balance.status, 200);
    assert.equal(balance.body.creditsLeft, 2);
    assert.equal(balance.body.kind, "trial");
    assert.equal(balance.body.answers, 2);
    assert.equal(balance.body.label, "ada");

    setEnv("CF_DAILY_SPEND_CAP_USD", "1");
    const now = new Date();
    await addKeySpend(1, now);
    await addKeySpend(1, new Date(now.getTime() + 86_400_000));
    const capped = await read(await chat(chatRequest({ Authorization: `Bearer ${key}` })));
    assert.equal(capped.status, 429);
    assertOpenAI(capped.body, "spend_cap_exceeded");
    assert.equal(await creditsLeft(key), 2);

    assert.equal(await spendCredit(key), true);
    assert.equal(await spendCredit(key), true);
    const empty = await read(await chat(chatRequest({ Authorization: `Bearer ${key}` })));
    assert.equal(empty.status, 429);
    assertOpenAI(empty.body, "insufficient_quota");
    assert.match((empty.body.error as { message: string }).message, /used all of its answers/);
  });

  test("the admin endpoint mints a trial key only with CF_ADMIN_TOKEN", async () => {
    setEnv("CF_ADMIN_TOKEN", undefined);
    const off = await read(await issueTrial(new Request("https://cheap-first.vercel.app/api/admin/keys", { method: "POST", body: "{}" })));
    assert.equal(off.status, 503);
    assert.match(String(off.body.error), /CF_ADMIN_TOKEN/);

    setEnv("CF_ADMIN_TOKEN", "admin-secret-value");
    assert.equal(adminTokenMatches("admin-secret-value"), true);
    assert.equal(adminTokenMatches("other-secret-value"), false);
    const missing = await read(await issueTrial(new Request("https://cheap-first.vercel.app/api/admin/keys", { method: "POST", body: "{}" })));
    assert.equal(missing.status, 401);
    const wrong = await read(await issueTrial(new Request("https://cheap-first.vercel.app/api/admin/keys", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
      body: "{}",
    })));
    assert.equal(wrong.status, 401);

    const bad = await read(await issueTrial(new Request("https://cheap-first.vercel.app/api/admin/keys", {
      method: "POST",
      headers: { Authorization: "Bearer admin-secret-value", "Content-Type": "application/json" },
      body: JSON.stringify({ answers: 0 }),
    })));
    assert.equal(bad.status, 400);

    setEnv("CF_TRIAL_ANSWERS", "15");
    const made = await read(await issueTrial(new Request("https://cheap-first.vercel.app/api/admin/keys", {
      method: "POST",
      headers: { Authorization: "Bearer admin-secret-value", "Content-Type": "application/json", "X-Admin-Token": "admin-secret-value" },
      body: JSON.stringify({ label: "ada" }),
    })));
    assert.equal(made.status, 201);
    assert.equal(made.body.answers, 15);
    assert.equal(made.body.label, "ada");
    assert.equal(made.body.ratePerMinute, 20);
    assert.equal(made.body.dailySpendCapUsd, 3);
    assert.equal(isApiKey(String(made.body.key)), true);
    assert.equal(await creditsLeft(String(made.body.key)), 15);

    setKeysAvailableForTests(false);
    const nostore = await read(await issueTrial(new Request("https://cheap-first.vercel.app/api/admin/keys", {
      method: "POST",
      headers: { Authorization: "Bearer admin-secret-value" },
      body: "{}",
    })));
    assert.equal(nostore.status, 503);
    assert.match(String(nostore.body.error), /Upstash/);
  });

  test("chat refuses a key while the store is off, and the caps have defaults", async () => {
    assert.equal(keyRatePerMin(), 20);
    assert.equal(dailyKeySpendCapUsd(), 3);
    setEnv("CF_KEY_RATE_PER_MIN", "0");
    setEnv("CF_DAILY_SPEND_CAP_USD", "0");
    assert.equal(keyRatePerMin(), 20);
    assert.equal(dailyKeySpendCapUsd(), 3);
    setEnv("CF_KEY_RATE_PER_MIN", "7");
    setEnv("CF_DAILY_SPEND_CAP_USD", "2.5");
    assert.equal(keyRatePerMin(), 7);
    assert.equal(dailyKeySpendCapUsd(), 2.5);
    assert.equal(parseAnswerCap(undefined), 200);
    assert.equal(typeof parseAnswerCap(1.5), "string");
    assert.equal(typeof parseAnswerCap(10_001), "string");

    setKeysAvailableForTests(false);
    const down = await read(await chat(chatRequest({ Authorization: `Bearer cf_${"d".repeat(24)}` })));
    assert.equal(down.status, 503);
    assertOpenAI(down.body, "keys_unavailable");
    assert.match((down.body.error as { message: string }).message, /aren't available/);
  });

  test("the trial-key command accepts answers and a label", () => {
    assert.deepEqual(parseTrialArgs([]), { answers: undefined, label: undefined });
    assert.deepEqual(parseTrialArgs(["--answers", "5", "--label", "ada"]), { answers: "5", label: "ada" });
    assert.deepEqual(parseTrialArgs(["--label=ada", "--answers=5"]), { answers: "5", label: "ada" });
    assert.equal(parseTrialArgs(["--help"]).help, true);
    assert.match(parseTrialArgs(["--answers"]).error ?? "", /--answers/);
    assert.match(parseTrialArgs(["--nope"]).error ?? "", /Unknown argument/);
  });
});

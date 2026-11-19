import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { answerFree } from "./mcpAnswer.js";
import { DEMO_MAX_QUESTION, PAID_MAX_QUESTION, takeDemoSlot } from "./limits.js";
import { resetMemoryStore } from "./store.js";

const saved: Record<string, string | undefined> = {};

function setCap(hourly: string, daily: string): void {
  saved.hour = process.env.CF_PER_IP_PER_HOUR;
  saved.day = process.env.CF_DAILY_CAP;
  process.env.CF_PER_IP_PER_HOUR = hourly;
  process.env.CF_DAILY_CAP = daily;
}

function restore(): void {
  if (saved.hour === undefined) delete process.env.CF_PER_IP_PER_HOUR;
  else process.env.CF_PER_IP_PER_HOUR = saved.hour;
  if (saved.day === undefined) delete process.env.CF_DAILY_CAP;
  else process.env.CF_DAILY_CAP = saved.day;
  resetMemoryStore();
}

function from(ip: string): Request {
  return new Request("https://cheap-first.vercel.app/api/ask", { headers: { "x-forwarded-for": ip } });
}

describe("demo limits", { concurrency: false }, () => {
afterEach(restore);

test("hourly cap is per IP, and the first address in x-forwarded-for is the visitor", async () => {
  resetMemoryStore();
  setCap("2", "100");
  const ip = "203.0.113.5";
  assert.equal((await takeDemoSlot(from(ip))).ok, true);
  assert.equal((await takeDemoSlot(from(ip))).ok, true);
  const third = await takeDemoSlot(from(ip));
  assert.equal(third.ok, false);
  if (!third.ok) {
    assert.equal(third.status, 429);
    assert.equal(third.error, "That's 2 questions this hour. Try again later.");
  }
  // The demo and a proxy that appends its own address share one bucket.
  const listed = await takeDemoSlot(from(`${ip}, 198.51.100.2`));
  assert.equal(listed.ok, false);
  const other = await takeDemoSlot(from("198.51.100.9"));
  assert.equal(other.ok, true);
});

test("the daily cap is shared by every visitor", async () => {
  resetMemoryStore();
  setCap("10", "2");
  assert.equal((await takeDemoSlot(from("203.0.113.1"))).ok, true);
  assert.equal((await takeDemoSlot(from("203.0.113.2"))).ok, true);
  const third = await takeDemoSlot(from("203.0.113.3"));
  assert.equal(third.ok, false);
  if (!third.ok) assert.equal(third.error, "The demo has hit today's limit. Try again tomorrow.");
});

test("a free MCP ask stops at the demo cap and does not call a model", async () => {
  resetMemoryStore();
  setCap("1", "10");
  const request = from("203.0.113.80");
  assert.equal((await takeDemoSlot(request)).ok, true);
  const outcome = await answerFree(request, "What is 2 + 2?", "balanced");
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.message, /this hour/);
});

test("the length caps match the demo and the paid API", () => {
  assert.equal(DEMO_MAX_QUESTION, 600);
  assert.equal(PAID_MAX_QUESTION, 2000);
});
});

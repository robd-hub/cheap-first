import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandsFor,
  emptySnapshot,
  formatUsd,
  noteAnswer,
  recordLive,
  renderStatsPage,
  sinceLabel,
  snapshotFromHash,
  statsBody,
  toNano,
  wantsHtml,
  type LiveObservation,
} from "./liveStats.js";
import { redisPipeline, sharedStoreConfigured } from "./store.js";

const kept: LiveObservation = {
  source: "demo",
  answeredBy: "cheap",
  cheapAnswered: true,
  checkScore: 90,
  passMark: 75,
  costUsd: 0.01,
  premiumOnlyUsd: 0.05,
};

test("a real catch is a rejected cheap answer, and a blank reply is not one", () => {
  const catchObs: LiveObservation = { ...kept, source: "pay", answeredBy: "premium", checkScore: 40, costUsd: 0.08, premiumOnlyUsd: 0.05 };
  const blank: LiveObservation = { ...kept, source: "mcp", answeredBy: "premium", cheapAnswered: false, checkScore: 0, costUsd: 0.04, premiumOnlyUsd: 0.05 };
  const catchCmds = commandsFor(catchObs, "2026-11-20T10:30:00.000Z").map((cmd) => cmd[2]);
  assert.ok(catchCmds.includes("realCatches"));
  assert.ok(catchCmds.includes("escalated"));
  assert.equal(catchCmds.includes("blankEscalations"), false);
  const blankCmds = commandsFor(blank, "2026-11-20T10:30:00.000Z").map((cmd) => cmd[2]);
  assert.ok(blankCmds.includes("blankEscalations"));
  assert.equal(blankCmds.includes("realCatches"), false);
  const keptCmds = commandsFor(kept, "2026-11-20T10:30:00.000Z");
  assert.equal(keptCmds.some((cmd) => cmd.includes("escalated")), false);
  assert.equal(JSON.stringify(keptCmds).includes("prompt"), false);
  assert.equal(keptCmds[0][0], "HSETNX");
  assert.equal(keptCmds[0][3], "2026-11-20T10:30:00.000Z");
  assert.equal(toNano(1.5), 1_500_000_000);
  assert.throws(() => commandsFor({ ...kept, costUsd: -1 }, "2026-11-20T10:30:00.000Z"));
});

test("hash reads become dollar totals, and a missing store stays empty", () => {
  const fromArray = snapshotFromHash(true, ["requests", "4", "escalated", "1", "realCatches", "1", "blankEscalations", "0", "costNano", "5000000000", "premiumOnlyNano", "2000000000", "since", "2026-11-20T10:30:00.000Z", "src:demo", "3", "src:mcp", "1"]);
  assert.equal(fromArray.requests, 4);
  assert.equal(fromArray.realCatches, 1);
  assert.equal(fromArray.costUsd, 5);
  assert.equal(fromArray.premiumOnlyUsd, 2);
  assert.equal(fromArray.savedUsd, -3);
  assert.equal(fromArray.sources.demo, 3);
  assert.equal(fromArray.sources.pay, 0);
  assert.equal(fromArray.since, "2026-11-20T10:30:00.000Z");
  const fromObject = snapshotFromHash(true, { requests: "2", src: { nested: true } });
  assert.equal(fromObject.requests, 2);
  const body = statsBody(fromArray);
  assert.equal(body.savingPct, -150);
  assert.equal(body.escalationRate, 0.25);
  assert.match(body.privacy, /not stored/);
  const empty = emptySnapshot(false);
  assert.equal(empty.reachable, false);
  assert.equal(statsBody(empty).savingPct, null);
  assert.equal(sinceLabel("2026-11-20T10:30:00.000Z"), "2026-11-20 10:30 UTC");
  assert.equal(sinceLabel("not a date <script>"), "—");
  assert.equal(sinceLabel(null), "—");
  assert.equal(formatUsd(-0.25), "-$0.25");
  assert.equal(formatUsd(0), "$0.00");
});

test("the page tells the truth at zero, and HTML is opt-in", () => {
  const off = renderStatsPage(emptySnapshot(false));
  assert.match(off, /Since <b>—<\/b>/);
  assert.match(off, /KV_REST_API_URL/);
  assert.match(off, /UPSTASH_REDIS_REST_TOKEN/);
  assert.match(off, /nothing is recorded/);
  assert.equal(off.includes(">$0.00<"), false);
  assert.match(off, /not live traffic/);
  const down = renderStatsPage(emptySnapshot(true, false));
  assert.match(down, /did not succeed/);
  assert.equal(down.includes(">$0.00<"), false);
  const zero = renderStatsPage(emptySnapshot(true, true));
  assert.match(zero, /No production answers have been recorded yet/);
  assert.match(zero, /Since <b>—<\/b>/);
  assert.match(zero, /\$0\.00/);
  const live = snapshotFromHash(true, ["requests", "12", "escalated", "3", "realCatches", "2", "blankEscalations", "1", "costNano", "2000000000", "premiumOnlyNano", "9000000000", "since", "2026-11-20T10:30:00.000Z", "src:chat", "12"]);
  const page = renderStatsPage(live);
  assert.match(page, /Since <b>2026-11-20 10:30 UTC<\/b>/);
  assert.match(page, />12</);
  assert.match(page, /real catches/);
  assert.match(page, /\$7\.00/);
  assert.match(page, /OpenAI-compatible/);
  assert.equal(page.includes("<script>"), false);
  assert.equal(wantsHtml("text/html,application/xhtml+xml", null), true);
  assert.equal(wantsHtml("application/json", null), false);
  assert.equal(wantsHtml("text/html", "json"), false);
  assert.equal(wantsHtml("*/*", null), false);
  assert.equal(wantsHtml(null, "html"), true);
});

test("recording does nothing in memory when the shared store is off", async () => {
  if (sharedStoreConfigured()) return;
  assert.equal(await redisPipeline([["HGETALL", "cf:live:v1"]]), null);
  await recordLive(kept);
  noteAnswer(kept);
  assert.equal(await redisPipeline([["HGETALL", "cf:live:v1"]]), null);
});

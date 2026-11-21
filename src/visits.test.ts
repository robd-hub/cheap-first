import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHit, renderVisitsPage, visitSnippet } from "./visits.js";

const UA = "Mozilla/5.0 (Macintosh) Safari/605";

test("a tagged visit is counted under its tag", () => {
  assert.deepEqual(parseHit({ s: "arc", p: "/agents/coder/", r: "Reddit-LLMDevs" }, UA), { site: "arc", path: "/agents/coder", source: "tag:reddit-llmdevs" });
});

test("an untagged visit from another site is counted under that site", () => {
  assert.equal(parseHit({ s: "cf", p: "/", h: "www.reddit.com" }, UA)!.source, "site:reddit.com");
  assert.equal(parseHit({ s: "cf", p: "/", h: "" }, UA)!.source, "direct");
  assert.equal(parseHit({ s: "cf", p: "/", h: "robd-hub.github.io" }, UA)!.source, "internal");
});

test("bots, unknown sites and junk are not counted", () => {
  assert.equal(parseHit({ s: "cf", p: "/" }, "Googlebot/2.1"), null);
  assert.equal(parseHit({ s: "cf", p: "/" }, ""), null);
  assert.equal(parseHit({ s: "other", p: "/" }, UA), null);
  assert.equal(parseHit("x", UA), null);
});

test("odd characters are stripped and lengths capped", () => {
  const h = parseHit({ s: "arc", p: "/<script>" + "a".repeat(200), r: "x\"><img>" }, UA)!;
  assert.ok(!/[<>"]/.test(h.path + h.source));
  assert.ok(h.path.length <= 81);
});

test("the page says when nothing is connected, and the snippet names the site", () => {
  assert.match(renderVisitsPage(null), /isn't connected/);
  assert.match(visitSnippet("arc"), /"arc"/);
  assert.match(visitSnippet("arc"), /sendBeacon/);
});

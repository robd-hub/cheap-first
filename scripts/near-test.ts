/**
 * Offline checks for the NEAR connector (no network, no model calls):
 *   npx tsx scripts/near-test.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { parseBrief, signatureValid, sweep, type NearDeps } from "../src/near.js";

// Briefs
const labelled = parseBrief("Task: List the three primary colours of light.\nAnswer: Red, green\nand blue.\nPass mark: 80");
assert.equal(typeof labelled, "object");
if (typeof labelled === "object") {
  assert.equal(labelled.task, "List the three primary colours of light.");
  assert.equal(labelled.answer, "Red, green\nand blue.");
  assert.equal(labelled.passMark, 80);
}
const headings = parseBrief("## Task\nSum 2 and 2.\n\n## Answer\n4\n\n## Criteria\nMust be a number.");
assert.ok(typeof headings === "object" && headings.task === "Sum 2 and 2." && headings.answer === "4" && headings.criteria === "Must be a number.");
const bold = parseBrief("**Task:** Name a prime.\n**Answer:** 7");
assert.ok(typeof bold === "object" && bold.task === "Name a prime." && bold.answer === "7", JSON.stringify(bold));
const asJson = parseBrief('Please check:\n```json\n{"task":"Capital of France?","answer":"Paris","passMark":90}\n```');
assert.ok(typeof asJson === "object" && asJson.answer === "Paris" && asJson.passMark === 90);
assert.equal(typeof parseBrief("Can you check my agent's essay please"), "string");
assert.equal(typeof parseBrief("The task was hard and the answer was long."), "string");
assert.equal(typeof parseBrief("Task: x\nAnswer: y\nPass mark: 20"), "string"); // pass mark out of range

// Signatures
const secret = "s3cret";
const body = '{"event":"hire.created"}';
const ts = String(Math.floor(Date.now() / 1000));
const mac = createHmac("sha256", secret).update(`${ts}.${body}`);
const hex = mac.digest("hex");
assert.ok(signatureValid(body, ts, hex, secret));
assert.ok(signatureValid(body, ts, `sha256=${hex}`, secret));
assert.ok(signatureValid(body, ts, Buffer.from(hex, "hex").toString("base64"), secret));
assert.ok(!signatureValid(body + " ", ts, hex, secret));
assert.ok(!signatureValid(body, ts, hex, "other"));
assert.ok(!signatureValid(body, String(Number(ts) - 3600), createHmac("sha256", secret).update(`${Number(ts) - 3600}.${body}`).digest("hex"), secret));
assert.ok(!signatureValid(body, null, hex, secret));

// Sweep against a fake NEAR
const calls: string[] = [];
const claimed = new Set<string>();
const assignments = [
  { assignment: { assignmentId: "a1", status: "in_progress" }, job: { jobId: "j1", title: "t", description: "Task: 2+2?\nAnswer: 4" } },
  { assignment: { assignmentId: "a2", status: "in_progress" }, job: { jobId: "j2", title: "t", description: "check this pls" } },
];
const deps: NearDeps = {
  token: "aat_test",
  claim: async (id) => (claimed.has(id) ? false : (claimed.add(id), true)),
  check: async (input) => ({ verdict: "pass", score: 99, reason: `ok ${input.answer}`, passMark: input.passMark, level: "standard", checker: "fake", receipt: {} as never }),
  fetch: (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method} ${path} ${init?.body ?? ""}`.trim());
    if (path === "/v1/agents/me/assignments") return new Response(JSON.stringify({ assignments }));
    return new Response("{}");
  }) as typeof fetch,
};
const first = await sweep(deps);
assert.deepEqual(first.map((r) => r.outcome), ["submitted", "declined"]);
assert.ok(calls.some((c) => c.startsWith("POST /v1/assignments/a1/start")));
assert.ok(calls.some((c) => c.startsWith("POST /v1/assignments/a1/submit") && c.includes("PASS")));
assert.ok(!calls.some((c) => c.startsWith("POST /v1/assignments/a2/start")), "an unreadable brief is declined before starting");
assert.ok(calls.some((c) => c.startsWith("POST /v1/assignments/a2/decline") && c.includes('"rejected"')));
const second = await sweep(deps);
assert.deepEqual(second.map((r) => r.outcome), ["skipped", "skipped"], "a repeated webhook doesn't redo work");

console.log("near-test: all checks passed");

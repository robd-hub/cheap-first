import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { POST } from "../api/mcp.js";
import { costOf, type ModelSpec } from "./models.js";
import { handleMcpRequest, originAllowed, PAID_HEADER, rpcOk, SERVER_VERSION, SUPPORTED_PROTOCOL_VERSIONS, toolResult, wantsPaidTier, type AskPayload, type JsonRpcId, type McpDeps } from "./mcp.js";
import { MCP_OFFER, MCP_PRICE_MICRO, toAskPayload } from "./mcpAnswer.js";
import { sharedStoreConfigured } from "./store.js";
import { loadBenchmarkReport } from "./stats.js";
import { PRICE_MICRO } from "./x402.js";

const KEY = `cf_${"a".repeat(24)}`;

function call(method: string, params?: unknown, init: { id?: JsonRpcId; headers?: Record<string, string>; omitId?: boolean; url?: string; accept?: string } = {}): Request {
  const message: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (!init.omitId) message.id = init.id === undefined ? 1 : init.id;
  if (params !== undefined) message.params = params;
  return new Request(init.url ?? "https://cheap-first.vercel.app/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: init.accept ?? "application/json, text/event-stream",
      ...init.headers,
    },
    body: JSON.stringify(message),
  });
}

async function read(res: Response): Promise<{ status: number; json: { id?: unknown; result?: { content?: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean; tools?: { name: string; outputSchema?: { required?: string[] } }[]; protocolVersion?: string }; error?: { code: number; message: string } } }> {
  const text = await res.text();
  const json = text.startsWith("event:") ? JSON.parse(text.split("\n").find((line) => line.startsWith("data:"))!.slice(5)) : text ? JSON.parse(text) : null;
  return { status: res.status, json };
}

const sample: AskPayload = {
  answer: "Canberra.",
  escalated: false,
  checkScore: 98,
  costUsd: 0.00004,
  savedUsd: 0.002,
  answeredBy: "cheap",
  model: "Dolphin",
  mode: "balanced",
  checkReason: "Correct.",
  checkSignal: "grader",
};

function fakes(overrides: Partial<McpDeps> = {}): McpDeps & { calls: string[] } {
  const calls: string[] = [];
  const deps: McpDeps = {
    async answerFree(_request, question, mode) {
      calls.push(`free:${mode}:${question}`);
      return { ok: true, payload: { ...sample, mode } };
    },
    async answerPaid(request, id, question, mode) {
      calls.push(`paid:${mode}:${question}`);
      return rpcOk(request, id, toolResult({ ...sample, mode, tier: "paid", paidUsd: 0.005 }));
    },
    stats: loadBenchmarkReport,
  };
  return { ...deps, ...overrides, calls };
}

test("initialize negotiates a protocol version and lists both tools", async () => {
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    const res = await read(await POST(call("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "test", version: "0" } })));
    assert.equal(res.status, 200);
    assert.equal(res.json.result?.protocolVersion, version);
  }
  const latest = await read(await POST(call("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "test", version: "0" } })));
  assert.equal(latest.json.result?.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);

  const tools = await read(await POST(call("tools/list")));
  const names = tools.json.result?.tools?.map((tool) => tool.name);
  assert.deepEqual(names, ["ask_cheap_first", "cheap_first_stats"]);
  const ask = tools.json.result?.tools?.find((tool) => tool.name === "ask_cheap_first");
  assert.deepEqual(ask?.outputSchema?.required, ["answer", "escalated", "checkScore", "costUsd", "savedUsd"]);
});

test("notifications get 202, and a bad protocol header is rejected", async () => {
  const note = await POST(call("notifications/initialized", undefined, { omitId: true }));
  assert.equal(note.status, 202);
  assert.equal(await note.text(), "");

  const bad = await read(await POST(call("tools/list", undefined, { headers: { "MCP-Protocol-Version": "1999-01-01" } })));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error?.code, -32600);

  const ok = await read(await POST(call("ping", undefined, { headers: { "MCP-Protocol-Version": "2025-03-26" }, id: "abc" })));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.id, "abc");
});

test("the transport rejects what the spec says to reject", async () => {
  assert.equal((await POST(new Request("https://cheap-first.vercel.app/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{" }))).status, 400);
  assert.equal((await POST(new Request("https://cheap-first.vercel.app/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "[]" }))).status, 400);
  assert.equal((await POST(call("tools/list", undefined, { accept: "text/html" }))).status, 406);
  assert.equal((await POST(new Request("https://cheap-first.vercel.app/mcp", { method: "POST", headers: { "Content-Type": "text/plain", Accept: "application/json" }, body: "{}" }))).status, 415);
  const get = await POST(new Request("https://cheap-first.vercel.app/mcp", { method: "GET", headers: { Accept: "text/event-stream" } }));
  assert.equal(get.status, 405);
  const del = await POST(new Request("https://cheap-first.vercel.app/mcp", { method: "DELETE" }));
  assert.equal(del.status, 405);
  const missing = await read(await POST(call("prompts/list")));
  assert.equal(missing.json.error?.code, -32601);
  const unknown = await read(await POST(call("tools/call", { name: "make_money", arguments: {} })));
  assert.equal(unknown.json.error?.code, -32602);
});

test("a client that only accepts event streams still gets the result", async () => {
  const res = await POST(call("ping", undefined, { accept: "text/event-stream" }));
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const text = await res.text();
  assert.match(text, /^event: message\ndata: /);
  assert.equal(JSON.parse(text.split("\n")[1].slice(5)).result !== undefined, true);
});

test("origin checks block DNS rebinding onto a private host only", () => {
  const local = new Request("http://127.0.0.1:8787/mcp", { headers: { Origin: "https://evil.example" } });
  assert.equal(originAllowed(local), false);
  const localOk = new Request("http://localhost:8787/mcp", { headers: { Origin: "http://localhost:3000" } });
  assert.equal(originAllowed(localOk), true);
  const pub = new Request("https://cheap-first.vercel.app/mcp", { headers: { Origin: "https://example.com" } });
  assert.equal(originAllowed(pub), true);
  assert.equal(originAllowed(new Request("http://127.0.0.1/mcp")), true);
});

test("a private host refuses a foreign origin at the endpoint", async () => {
  const res = await POST(call("ping", undefined, { url: "http://127.0.0.1:8787/mcp", headers: { Origin: "https://evil.example" } }));
  assert.equal(res.status, 403);
});

test("cheap_first_stats returns the published headline", async () => {
  const res = await read(await POST(call("tools/call", { name: "cheap_first_stats", arguments: {} })));
  assert.equal(res.json.result?.isError, false);
  const stats = res.json.result?.structuredContent as unknown as {
    benchmark: { questions: number; cheapFirstUsd: number; premiumOnlyUsd: number; savingPct: number; answeredByDolphin: number; escalated: number; averageQuality: number; premiumAverageQuality: number; summary: string };
    hardBenchmark: { questions: number; correct: number; cheapFirstUsd: number; premiumOnlyUsd: number; savingPct: number };
  };
  assert.equal(stats.benchmark.questions, 143);
  assert.equal(stats.benchmark.cheapFirstUsd, 0.27);
  assert.equal(stats.benchmark.premiumOnlyUsd, 1.33);
  assert.equal(stats.benchmark.savingPct, 80);
  assert.equal(stats.benchmark.answeredByDolphin, 139);
  assert.equal(stats.benchmark.escalated, 4);
  assert.equal(stats.benchmark.averageQuality, 99.7);
  assert.equal(stats.benchmark.premiumAverageQuality, 98);
  assert.match(stats.benchmark.summary, /\$0\.27/);
  assert.equal(stats.hardBenchmark.questions, 97);
  assert.equal(stats.hardBenchmark.correct, 97);
  assert.equal(stats.hardBenchmark.cheapFirstUsd, 0.27);
  assert.equal(stats.hardBenchmark.premiumOnlyUsd, 1.42);
  assert.equal(stats.hardBenchmark.savingPct, 81);
  const pub = res.json.result?.structuredContent as unknown as {
    publicBenchmark: { questions: number; correctCheapFirst: number; correctPremium: number; costCheapFirst: string; costPremium: string; savingPct: number; catches: number; missed: number; falseAlarms: number; claim: string; summary: string };
  };
  assert.equal(pub.publicBenchmark.questions, 300);
  assert.equal(pub.publicBenchmark.correctCheapFirst, 288);
  assert.equal(pub.publicBenchmark.correctPremium, 294);
  assert.equal(pub.publicBenchmark.costCheapFirst, "$0.088");
  assert.equal(pub.publicBenchmark.costPremium, "$1.945");
  assert.equal(pub.publicBenchmark.savingPct, 95.5);
  assert.equal(pub.publicBenchmark.catches, 0);
  assert.equal(pub.publicBenchmark.missed, 11);
  assert.equal(pub.publicBenchmark.falseAlarms, 4);
  assert.match(pub.publicBenchmark.claim, /2 points behind/);
  assert.match(pub.publicBenchmark.summary, /0 real catches/);
  assert.equal(pub.publicBenchmark.summary.includes("same quality"), false);
  // The text block is the same object, for clients that ignore structuredContent.
  assert.equal(JSON.parse(res.json.result?.content?.[0].text ?? "").benchmark.questions, 143);
  assert.equal(JSON.parse(res.json.result?.content?.[0].text ?? "").publicBenchmark.questions, 300);
});

test("a free ask stays on the demo path and returns the fields an agent needs", async () => {
  const deps = fakes();
  const res = await read(await handleMcpRequest(call("tools/call", { name: "ask_cheap_first", arguments: { question: "  Capital of Australia?  ", mode: "strict" } }), deps));
  assert.deepEqual(deps.calls, ["free:strict:Capital of Australia?"]);
  const payload = res.json.result?.structuredContent as unknown as AskPayload & { tier: string };
  assert.equal(payload.answer, "Canberra.");
  assert.equal(payload.escalated, false);
  assert.equal(payload.checkScore, 98);
  assert.equal(payload.costUsd, 0.00004);
  assert.equal(payload.savedUsd, 0.002);
  assert.equal(payload.mode, "strict");
  assert.equal(payload.tier, "free");
  assert.equal(res.json.result?.isError, false);
});

test("paid credentials use the paid path, and a bad key does not fall through to the demo", async () => {
  const deps = fakes();
  await handleMcpRequest(call("tools/call", { name: "ask_cheap_first", arguments: { question: "Hi", mode: "budget" } }, { headers: { Authorization: `Bearer ${KEY}` } }), deps);
  await handleMcpRequest(call("tools/call", { name: "ask_cheap_first", arguments: { question: "Hi" } }, { headers: { [PAID_HEADER]: "1" } }), deps);
  await handleMcpRequest(call("tools/call", { name: "ask_cheap_first", arguments: { question: "Hi" } }, { headers: { "X-PAYMENT": "abc" } }), deps);
  assert.deepEqual(deps.calls, ["paid:budget:Hi", "paid:balanced:Hi", "paid:balanced:Hi"]);

  const junk = fakes();
  const res = await read(await handleMcpRequest(call("tools/call", { name: "ask_cheap_first", arguments: { question: "Hi" } }, { headers: { Authorization: "Bearer not-a-key" } }), junk));
  assert.deepEqual(junk.calls, []);
  assert.equal(res.json.result?.isError, true);
  assert.match(res.json.result?.content?.[0].text ?? "", /prepaid key/);
});

test("free questions keep the demo length, paid questions the paid length", async () => {
  const deps = fakes();
  const tooLong = await read(await handleMcpRequest(call("tools/call", { name: "ask_cheap_first", arguments: { question: "x".repeat(601) } }), deps));
  assert.equal(tooLong.json.result?.isError, true);
  assert.deepEqual(deps.calls, []);
  await handleMcpRequest(call("tools/call", { name: "ask_cheap_first", arguments: { question: "x".repeat(601) } }, { headers: { [PAID_HEADER]: "1" } }), deps);
  assert.equal(deps.calls.length, 1);
  const overPaid = await read(await handleMcpRequest(call("tools/call", { name: "ask_cheap_first", arguments: { question: "x".repeat(2001) } }, { headers: { [PAID_HEADER]: "1" } }), deps));
  assert.equal(overPaid.json.result?.isError, true);
  assert.equal(deps.calls.length, 1);
});

test("an empty or non-string question is a tool error and is not counted as a call", async () => {
  const deps = fakes();
  for (const question of ["", "   ", 12]) {
    const res = await read(await handleMcpRequest(call("tools/call", { name: "ask_cheap_first", arguments: { question } }), deps));
    assert.equal(res.json.result?.isError, true);
  }
  assert.deepEqual(deps.calls, []);
});

test("asking for the paid tier without paying is the same 402 as /api/pay, at the same price", async () => {
  assert.equal(MCP_OFFER.priceMicro, undefined);
  assert.equal(MCP_PRICE_MICRO, PRICE_MICRO);
  const res = await POST(call("tools/call", { name: "ask_cheap_first", arguments: { question: "What is 2 + 2?" } }, { headers: { [PAID_HEADER]: "1" } }));
  assert.equal(res.status, 402);
  assert.ok(res.headers.get("payment-required"));
  const body = (await res.json()) as { x402Version: number; accepts: { maxAmountRequired: string }[] };
  assert.equal(body.x402Version, 1);
  assert.equal(body.accepts[0].maxAmountRequired, PRICE_MICRO);
  assert.equal(wantsPaidTier(new Request("https://cheap-first.vercel.app/mcp")), false);
});

test("a prepaid key is refused by the existing key path when the store is down, and no model is called", async (t) => {
  if (sharedStoreConfigured()) {
    t.skip("a shared store is configured; this check would touch it");
    return;
  }
  const res = await read(await POST(call("tools/call", { name: "ask_cheap_first", arguments: { question: "Hi" } }, { headers: { Authorization: `Bearer ${KEY}` } })));
  assert.equal(res.status, 200);
  assert.equal(res.json.result?.isError, true);
  assert.match(res.json.result?.content?.[0].text ?? "", /Prepaid keys aren't available/);
});

test("the ask payload reports an escalation and a saving from the real cost helper", () => {
  const premium: ModelSpec = { label: "Premium", provider: "serv", model: "premium", inputPerM: 4.8, outputPerM: 24 };
  const specs = {
    cheap: { label: "Dolphin", provider: "dolphin" as const, model: "cheap", inputPerM: 0.01, outputPerM: 0.07 },
    checker: { label: "Checker", provider: "serv" as const, model: "checker", inputPerM: 0.13, outputPerM: 0.65 },
    premium,
  };
  const kept = toAskPayload(
    {
      prompt: "Capital?",
      answer: "Canberra.",
      answeredBy: "cheap",
      cheap: { text: "Canberra.", inputTokens: 1_000_000, outputTokens: 0, costUsd: 0.01, ms: 1 },
      check: { score: 90, reason: "Right.", signal: "grader", call: { text: "", inputTokens: 0, outputTokens: 0, costUsd: 0.001, ms: 1 } },
      costUsd: 0.011,
    },
    specs,
    "balanced",
  );
  assert.equal(kept.escalated, false);
  assert.equal(kept.checkScore, 90);
  assert.equal(kept.savedUsd, costOf(premium, 1_000_000, 0) - 0.011);
  assert.equal(kept.model, "Dolphin");

  const escalated = toAskPayload(
    {
      prompt: "Hard",
      answer: "Premium answer",
      answeredBy: "premium",
      cheap: { text: "wrong", inputTokens: 10, outputTokens: 10, costUsd: 0.001, ms: 1 },
      check: { score: 10, reason: "Wrong.", signal: "agreement", call: { text: "", inputTokens: 0, outputTokens: 0, costUsd: 0.01, ms: 1 } },
      premium: { text: "Premium answer", inputTokens: 10, outputTokens: 20, costUsd: 0.05, ms: 1 },
      costUsd: 0.061,
    },
    specs,
    "strict",
  );
  assert.equal(escalated.escalated, true);
  assert.equal(escalated.answer, "Premium answer");
  assert.equal(escalated.savedUsd, 0.05 - 0.061);
  assert.equal(escalated.mode, "strict");
  assert.equal(escalated.model, "Premium");
});

test("directory metadata lists the headers the server actually reads", () => {
  const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8")) as {
    description: string;
    version: string;
    icons: { src: string; mimeType: string; sizes: string[] }[];
    remotes: { type: string; url: string; headers: { name: string; description: string; isRequired: boolean; isSecret: boolean }[] }[];
  };
  assert.ok(server.description.length >= 1 && server.description.length <= 100);
  // The registry refuses a version it already has, so server.json and serverInfo move together.
  assert.equal(server.version, SERVER_VERSION);
  // mcptry and other directories show this icon. The site build copies brand/icon.png to /icon.png.
  assert.deepEqual(server.icons, [{ src: "https://cheap-first.vercel.app/icon.png", mimeType: "image/png", sizes: ["512x512"] }]);
  assert.ok(existsSync(new URL("../brand/icon.png", import.meta.url)));
  assert.equal(server.remotes[0]?.type, "streamable-http");
  assert.equal(server.remotes[0]?.url, "https://cheap-first.vercel.app/mcp");
  // X-PAYMENT and PAYMENT-SIGNATURE carry a signed x402 payload, not a value a directory asks the user to type.
  const headers = server.remotes[0]?.headers ?? [];
  assert.deepEqual(
    headers.map((header) => header.name),
    ["Authorization", PAID_HEADER],
  );
  assert.equal(headers[0]?.isRequired, false);
  assert.equal(headers[0]?.isSecret, true);
  assert.match(headers[0]?.description ?? "", /Bearer cf_/);
  assert.equal(headers[1]?.isRequired, false);
  assert.equal(headers[1]?.isSecret, false);
  assert.match(headers[1]?.description ?? "", /\$0\.005 USDC on Base/);
  assert.match(headers[1]?.description ?? "", /\b1\b/);

  const client = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8")) as {
    mcpServers: { "cheap-first": { url: string; headers?: unknown } };
  };
  assert.deepEqual(client.mcpServers["cheap-first"], { url: "https://cheap-first.vercel.app/mcp" });
});

test("GitHub Pages posts the Try it box at the production alias", () => {
  const workflow = readFileSync(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.match(workflow, /ASK_URL: https:\/\/cheap-first\.vercel\.app\/api\/ask/);
  assert.equal(workflow.includes("cheap-first-designimp-projects"), false);
});

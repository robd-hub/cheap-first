import assert from "node:assert/strict";
import { test } from "node:test";
import { PAID_HEADER } from "./mcp.js";
import { forwardLine, mcpHeaders, mcpUrl } from "./mcpStdio.js";

test("the bridge defaults to the production MCP endpoint and can point elsewhere", () => {
  assert.equal(mcpUrl({}), "https://cheap-first.vercel.app/mcp");
  assert.equal(mcpUrl({ CHEAP_FIRST_MCP_URL: "http://127.0.0.1:8787/mcp/" }), "http://127.0.0.1:8787/mcp");
});

test("a prepaid key is sent as a bearer token, and the free demo sends none", () => {
  const paid = mcpHeaders({ CHEAP_FIRST_API_KEY: " cf_test " });
  assert.equal(paid.Authorization, "Bearer cf_test");
  assert.equal(paid.Accept, "application/json, text/event-stream");
  const free = mcpHeaders({});
  assert.equal(free.Authorization, undefined);
  assert.equal(mcpHeaders({ CHEAP_FIRST_PAID: "1" })[PAID_HEADER], "1");
});

test("a notification with an empty server body writes nothing", async () => {
  let posted = 0;
  const out = await forwardLine('{"jsonrpc":"2.0","method":"notifications/initialized"}', async () => {
    posted += 1;
    return { status: 202, text: "" };
  });
  assert.equal(out, null);
  assert.equal(posted, 1);
  assert.equal(await forwardLine("   \n", async () => ({ status: 200, text: "" })), null);
});

test("a pretty JSON response is written as one stdout line", async () => {
  const pretty = '{\n  "jsonrpc": "2.0",\n  "id": 1,\n  "result": { "ok": true }\n}\n';
  const out = await forwardLine('{"jsonrpc":"2.0","id":1,"method":"ping"}', async () => ({ status: 200, text: pretty }));
  assert.equal(out?.includes("\n"), false);
  assert.deepEqual(JSON.parse(out ?? ""), { jsonrpc: "2.0", id: 1, result: { ok: true } });
});

test("an SSE data line is the message that gets written", async () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}\n\n';
  const out = await forwardLine('{"jsonrpc":"2.0","id":7,"method":"tools/list"}', async () => ({ status: 200, text: sse }));
  assert.equal(JSON.parse(out ?? "").id, 7);
});

test("an x402 402 becomes a JSON-RPC error the stdio client can show", async () => {
  const out = await forwardLine('{"jsonrpc":"2.0","id":3,"method":"tools/call"}', async () => ({
    status: 402,
    text: JSON.stringify({ x402Version: 1, error: "Payment required: $0.005 in USDC on Base per call." }),
  }));
  const parsed = JSON.parse(out ?? "") as { id: number; error: { message: string } };
  assert.equal(parsed.id, 3);
  assert.match(parsed.error.message, /\$0\.005/);
});

test("a down server is an error, not a hang", async () => {
  const out = await forwardLine('{"jsonrpc":"2.0","id":4,"method":"ping"}', async () => {
    throw new Error("connect ECONNREFUSED");
  });
  const parsed = JSON.parse(out ?? "") as { id: number; error: { message: string } };
  assert.equal(parsed.id, 4);
  assert.match(parsed.error.message, /Couldn't reach/);
});

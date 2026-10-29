import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import OpenAI from "openai";
import ts from "typescript";

// Exercise the actual installed SDK, not an imitation of its post() method.
// A constructor-injected fetch stub makes all requests local to this test.
function clientWithFetch(fetch) {
  let transport, optionsSeen;
  const activities = [], guardedCalls = [];
  const guardedFetch = async (input, init) => { guardedCalls.push({ input, init }); return fetch(input, init); };
  class TestTransport extends OpenAI {
    constructor(options) {
      assert.equal(options.fetch, guardedFetch, "the production constructor must inject its accounting transport");
      assert.equal(options.maxRetries, 0, "the SDK must never retry an admitted paid transmission");
      super(options); transport = this; optionsSeen = options;
    }
  }
  const filename = new URL("../lib/memory/claude-memory-client.ts", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", "process", outputText)(
    id => {
      if (id === "@/lib/standalone-accounting/activity") return { createActivityAccountingFetch(provider, activity) { activities.push({ provider, activity }); return guardedFetch; } };
      assert.equal(id, "openai", "protocol tests must not import a real ledger"); return { default: TestTransport };
    },
    module, module.exports, { env: { CLAUDE_API_KEY: "test-only-not-a-real-key" } },
  );
  const client = module.exports.createClaudeMemoryClient();
  assert.ok(client);
  return { client, transport, optionsSeen, activities, guardedCalls, guardedFetch };
}
const request = {
  model: "claude-sonnet-5-5", temperature: 0, response_format: { type: "json_object" },
  messages: [{ role: "system", content: "Return JSON." }, { role: "user", content: "A test source." }],
};

test("installed SDK sends native Claude JSON requests with correct URL, headers and body", async () => {
  const calls = [];
  const { client, transport, optionsSeen, activities, guardedCalls, guardedFetch } = clientWithFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      stop_reason: "end_turn", content: [{ type: "text", text: '{"action":"no_change"}' }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const result = await client.chat.completions.create(request);
  assert.deepEqual(JSON.parse(result.choices[0].message.content), { action: "no_change" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("x-api-key"), "test-only-not-a-real-key");
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.equal(body.system, "Return JSON.");
  assert.deepEqual(body.messages, [request.messages[1]]);
  assert.equal(body.temperature, undefined);
  assert.equal(body.response_format, undefined);
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.thinking.type, "between_tools");
  const defaults = new OpenAI({ apiKey: "unused-test-key" });
  assert.equal(transport.maxRetries, 0);
  assert.equal(optionsSeen.fetch, guardedFetch);
  assert.equal(guardedCalls.length, 1);
  assert.deepEqual(activities, [{ provider: "anthropic", activity: "memory-edit" }]);
  assert.equal(transport.timeout, defaults.timeout);
});

test("installed SDK preserves native HTTP errors and does not retry a 400", async () => {
  let requests = 0;
  const { client } = clientWithFetch(async () => {
    requests++;
    return new Response(JSON.stringify({
      type: "error", error: { type: "invalid_request_error", message: "Mock invalid native request" },
    }), { status: 400, headers: { "content-type": "application/json", "request-id": "test-request-id" } });
  });
  await assert.rejects(client.chat.completions.create(request), error => error.status === 400 && /Mock invalid native request/.test(error.message));
  assert.equal(requests, 1);
});

test("installed SDK does not retry provider 429 or 500 responses", async () => {
  for (const status of [429, 500]) {
    let requests = 0;
    const { client, guardedCalls } = clientWithFetch(async () => {
      requests++;
      return new Response(JSON.stringify({ error: { message: "Mock unavailable" } }), { status, headers: { "content-type": "application/json", "retry-after": "0" } });
    });
    await assert.rejects(client.chat.completions.create(request), error => error.status === status);
    assert.equal(requests, 1); assert.equal(guardedCalls.length, 1);
  }
});

test("installed SDK preserves terminal accounting denial in its cause chain without retry", async () => {
  const denial = Object.assign(new Error("Paid request needs approval"), { code: "standalone_approval_required", terminal: true });
  let requests = 0;
  const { client, guardedCalls } = clientWithFetch(async () => { requests++; throw denial; });
  await assert.rejects(client.chat.completions.create(request), error => {
    for (let current = error, depth = 0; current && typeof current === "object" && depth < 8; current = current.cause, depth++) if (current === denial) return true;
    return false;
  });
  assert.equal(requests, 1); assert.equal(guardedCalls.length, 1);
});

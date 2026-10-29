import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const MODEL = "claude-sonnet-5-5";
const preferenceText = "you will always provide teh complete response to an edit request never tell me to change one paragraph";
const originalFact = "I led the accounting recovery through the team; I did not personally perform every transaction-level task.";
const jsonResponse = value => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(value) }] });
const update = entries => ({ action: "replace", updatedContent: { version: 3, purpose: "Durable memory", entries } });
const user = (id, content) => ({ id, role: "user", content, createdAt: "2026-10-27T12:00:00.000Z" });
const assistant = (id, content = "Understood.") => ({ id, role: "assistant", content, createdAt: "2026-10-27T12:01:00.000Z" });
const entry = (key, value, message, category = "fact") => ({
  key, value, category, source: "user-stated", confidence: "high",
  evidenceMessageIds: [message.id], evidenceQuotes: [{ messageId: message.id, quote: message.content }],
});

// Run the real editor and provider adapter with in-memory persistence and a mock
// native API transport. No database, network or production credential is used.
function harness({ env = { CLAUDE_API_KEY: "test-only-key" }, entries = [], messages = [], respond = () => jsonResponse({ action: "no_change" }) } = {}) {
  const calls = [], writes = [], constructors = [], logs = [], activities = [], cache = new Map();
  const guardedFetch = async () => { throw new Error("Protocol transport must not access a real provider"); };
  const accountingError = error => {
    let current = error;
    for (let depth = 0; current && typeof current === "object" && depth < 8; depth++, current = current.cause) {
      if (current.terminal === true || typeof current.code === "string" && current.code.startsWith("standalone_")) return true;
    }
    return false;
  };
  let memory = { version: 3, purpose: "Durable memory", entries: structuredClone(entries) };
  const globals = {};
  const store = {
    async getLongTermMemory() { return structuredClone(memory); },
    async getActorById() { return { name: "BTG advisor", purpose: "Help Mark with accurate applications and remember lasting preferences." }; },
    async getRecentMessages() { return structuredClone(messages); },
    async mergeActorLongTermMemoryEntries(actorId, changes) {
      writes.push({ method: "merge", actorId, changes });
      const byKey = new Map(memory.entries.map(item => [item.key, item]));
      for (const item of changes) byKey.set(item.key, item);
      memory = { ...memory, entries: [...byKey.values()] };
    },
    async setLongTermMemory(actorId, chatId, content) {
      writes.push({ method: "replace", actorId, chatId, content }); memory = content;
    },
  };
  class OpenAITransport {
    constructor(options) { constructors.push(options); }
    async post(path, options) {
      calls.push({ path, ...options });
      return respond(options.body, calls.length);
    }
  }
  const mocks = {
    openai: { default: OpenAITransport },
    "@/lib/standalone-accounting/activity": { createActivityAccountingFetch(provider, activity) { activities.push({ provider, activity }); return guardedFetch; } },
    "@/lib/standalone-accounting/context": { isStandaloneAccountingError: accountingError },
    "@/lib/data/persistence-store": store,
    "@/lib/memory/short-term": {
      filterConversationalMessages: source => source.filter(item => item.role === "user" || item.role === "assistant"),
    },
  };
  function load(id) {
    if (mocks[id]) return mocks[id];
    if (cache.has(id)) return cache.get(id).exports;
    if (!id.startsWith("@/")) return require(id);
    const filename = new URL(`${id.slice(2)}.ts`, root);
    const source = readFileSync(filename, "utf8");
    const result = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
    const module = { exports: {} }; cache.set(id, module);
    const quietConsole = Object.fromEntries(["log", "info", "warn", "error"].map(level => [level, (...args) => logs.push({ level, args })]));
    new Function("require", "module", "exports", "process", "globalThis", "console", result.outputText)(load, module, module.exports, { env }, globals, quietConsole);
    return module.exports;
  }
  return { load, calls, writes, constructors, logs, activities, guardedFetch, memory: () => memory };
}

function review(body, allowed = () => true) {
  assert.match(body.system, /Independently review durable memory support/);
  assert.match(body.system, /not the person whose life or career/);
  assert.match(body.system, /explicitly lasting preference/);
  assert.match(body.system, /Preserve reported feelings, timing, uncertainty/);
  const { candidates } = JSON.parse(body.messages[0].content);
  return jsonResponse({ verdicts: candidates.map(item => ({
    key: item.key, supported: allowed(item), durable: allowed(item), reason: allowed(item) ? "Supported by original user statement." : "Unsupported attribution or source.",
  })) });
}

function request() {
  return { model: MODEL, temperature: 0, response_format: { type: "json_object" }, messages: [
    { role: "system", content: "Return JSON only." }, { role: "user", content: "Evaluate the supplied memory." },
  ] };
}

function assertNativeCalls(calls) {
  for (const { path, body } of calls) {
    assert.equal(path, "/messages"); assert.equal(body.model, MODEL);
    assert.equal(body.max_tokens, 16_384);
    assert.equal(body.thinking.type, "between_tools");
    assert.equal(body.output_config.format.type, "json_schema");
    assert.equal(body.output_config.format.schema.additionalProperties, false);
    assert.equal(body.temperature, undefined); assert.equal(body.response_format, undefined);
    assert.equal(body.tools, undefined); assert.equal(body.fallbacks, undefined);
  }
}

test("native Claude transport preserves the JSON envelope and timeout with guarded fetch and no SDK retry", async () => {
  const h = harness();
  const { createClaudeMemoryClient, MEMORY_EDITOR_MODEL } = h.load("@/lib/memory/claude-memory-client");
  assert.equal(MEMORY_EDITOR_MODEL, MODEL);
  const result = await createClaudeMemoryClient().chat.completions.create(request());
  assert.deepEqual(JSON.parse(result.choices[0].message.content), { action: "no_change" });
  assertNativeCalls(h.calls);
  assert.equal(h.constructors[0].baseURL, "https://api.anthropic.com/v1");
  assert.equal(h.constructors[0].defaultHeaders["anthropic-version"], "2023-06-01");
  assert.equal(h.constructors[0].defaultHeaders["x-api-key"], "test-only-key");
  assert.equal(h.constructors[0].maxRetries, 0);
  assert.equal(h.constructors[0].fetch, h.guardedFetch);
  assert.deepEqual(h.activities, [{ provider: "anthropic", activity: "memory-edit" }]);
  assert.equal(h.constructors[0].timeout, undefined);
  const schema = h.calls[0].body.output_config.format.schema;
  for (const key of ["action", "updatedContent", "version", "purpose", "entries", "keys", "verdicts"]) assert.ok(schema.properties[key]);
});

test("uses Katie's lowercase Claude credential alias without touching global provider routing", async () => {
  const h = harness({ env: { claude_api_key: "lowercase-test-key" } });
  await h.load("@/lib/memory/claude-memory-client").createClaudeMemoryClient().chat.completions.create(request());
  assert.equal(h.constructors[0].apiKey, "lowercase-test-key");
});

test("missing Claude credentials do not silently fall back to GPT or write memory", async () => {
  const h = harness({ env: { OPENAI_API_KEY: "unused-test-key" } });
  const api = h.load("@/lib/memory/long-term-editor");
  await api.maybeUpdateLongTermMemory("actor", "chat", preferenceText);
  await assert.rejects(api.maybeUpdateLongTermMemory("actor", "chat", preferenceText, { required: true }), /provider not configured/);
  assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
});

test("native response extraction ignores thinking and joins text blocks", async () => {
  const h = harness({ respond: () => ({ stop_reason: "end_turn", content: [
    { type: "thinking", thinking: "not JSON" },
    { type: "text", text: '{"action":' }, { type: "text", text: '"no_change"}' },
  ] }) });
  const response = await h.load("@/lib/memory/claude-memory-client").createClaudeMemoryClient().chat.completions.create(request());
  assert.deepEqual(JSON.parse(response.choices[0].message.content), { action: "no_change" });
});

test("truncation, refusal and missing stop reasons cannot turn partial results into memory writes", async () => {
  for (const stop_reason of ["max_tokens", "refusal", "pause_turn", "model_context_window_exceeded", null]) {
    const h = harness({ respond: () => ({ ...jsonResponse(update([])), stop_reason }) });
    const client = h.load("@/lib/memory/claude-memory-client").createClaudeMemoryClient();
    await assert.rejects(client.chat.completions.create(request()), /response incomplete/);
    assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 0);
  }
});

test("empty native response and transport errors propagate without a new retry or fallback loop", async () => {
  const empty = harness({ respond: () => ({ stop_reason: "end_turn", content: [] }) });
  await assert.rejects(empty.load("@/lib/memory/claude-memory-client").createClaudeMemoryClient().chat.completions.create(request()), /no text/);
  const failure = new Error("mock provider unavailable");
  const failed = harness({ respond: () => { throw failure; } });
  await assert.rejects(failed.load("@/lib/memory/claude-memory-client").createClaudeMemoryClient().chat.completions.create(request()), error => error === failure);
  assert.equal(failed.calls.length, 1);
});

test("a terminal paid admission denial propagates without source review, repair or memory writes", async () => {
  const denial = Object.assign(new Error("Spending approval required"), { code: "standalone_approval_required", terminal: true });
  const wrapped = new Error("SDK connection error", { cause: denial });
  const h = harness({ messages: [user("source", preferenceText)], respond: () => { throw wrapped; } });
  await assert.rejects(h.load("@/lib/memory/long-term-editor").maybeUpdateLongTermMemory("actor", "chat", preferenceText), error => error === wrapped);
  assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 0);
  assert.equal(h.constructors[0].maxRetries, 0); assert.equal(h.constructors[0].fetch, h.guardedFetch);
});

test("exact complete-edit preference traverses selection, source review, contextual review and existing merge", async () => {
  const source = user("preference-source", preferenceText);
  const remembered = entry("preference.complete_edits", "Mark wants the complete revised response after every edit request.", source, "preference");
  const preserved = { key: "reference.existing", category: "fact", source: "user-stated", confidence: "high", value: "An existing authoritative reference remains unchanged." };
  const h = harness({ entries: [preserved], messages: [source, assistant("reply")], respond(body, count) {
    if (count === 1) {
      assert.match(body.system, /ONLY new or changed entries/);
      assert.doesNotMatch(body.system, /the complete version-3 long-term memory object/);
      assert.match(body.system, /explicitly lasting preference/);
      return jsonResponse(update([remembered]));
    }
    return review(body);
  } });
  await h.load("@/lib/memory/long-term-editor").maybeUpdateLongTermMemory("actor", "chat", preferenceText);
  assert.equal(h.calls.length, 3); assertNativeCalls(h.calls);
  assert.match(h.calls[1].body.system, /support \(source\)/);
  assert.match(h.calls[2].body.system, /support \(qualification\)/);
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].method, "merge");
  assert.deepEqual(h.memory().entries.find(item => item.key === preserved.key), preserved);
  assert.equal(h.memory().entries.find(item => item.key === remembered.key).value, remembered.value);
});

test("wrong-person proposal is rejected and the existing bounded repair can save a correctly attributed fact", async () => {
  const source = user("source", originalFact);
  const wrong = entry("experience.recovery", "Katie led the accounting recovery through the team.", source);
  const corrected = entry(wrong.key, "Mark led the accounting recovery through the team, not every transaction-level task personally.", source);
  const h = harness({ messages: [source, assistant("reply")], respond(body, count) {
    if (count === 1) return jsonResponse(update([wrong]));
    if (body.system.startsWith("You are repairing")) {
      assert.match(body.system, /never to Katie merely because she wrote the draft/);
      return jsonResponse(update([corrected]));
    }
    return review(body, item => !item.value.startsWith("Katie"));
  } });
  await h.load("@/lib/memory/long-term-editor").maybeUpdateLongTermMemory("actor", "chat", originalFact);
  assert.equal(h.calls.length, 5); assertNativeCalls(h.calls);
  assert.equal(h.calls.filter(item => item.body.system.startsWith("You are repairing")).length, 1);
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].changes[0].value, corrected.value);
});

test("a generic application question is not saved as evidence of invented experience", async () => {
  const source = user("question", "Please share 3 to 5 examples of your relevant experience.");
  const unsupported = entry("experience.cfo", "Katie has nearly 20 years of CFO experience.", source);
  const h = harness({ messages: [source, assistant("draft")], respond(body, count) {
    if (count === 1) return jsonResponse(update([unsupported]));
    if (body.system.startsWith("You are repairing")) return jsonResponse({ action: "no_change" });
    assert.match(body.system, /generic request for examples states no career facts/);
    return review(body, () => false);
  } });
  await h.load("@/lib/memory/long-term-editor").maybeUpdateLongTermMemory("actor", "chat", source.content);
  assert.equal(h.calls.length, 3); assert.equal(h.writes.length, 0);
});

test("contextual veto still rejects a previously supported fact that omits a later correction", async () => {
  const first = user("old", "I have approximately fifteen years of fractional CFO experience.");
  const latest = user("new", "Correction: I have 17 years of fractional CFO experience, preceded by more than 10 years in Controller/CFO roles.");
  const old = entry("experience.tenure", "Mark has fifteen years of fractional CFO experience.", first);
  const h = harness({ messages: [first, assistant("r1"), latest, assistant("r2")], respond(body, count) {
    if (count === 1) return jsonResponse(update([old]));
    if (body.system.startsWith("You are repairing")) return jsonResponse({ action: "no_change" });
    assert.match(body.system, /latest explicit correction/);
    return review(body, () => !body.system.includes("support (qualification)"));
  } });
  await h.load("@/lib/memory/long-term-editor").maybeUpdateLongTermMemory("actor", "chat", latest.content);
  assert.equal(h.calls.length, 4); assert.equal(h.writes.length, 0);
});

test("meaningful relationship context preserves uncertainty without inventing reconciliation intent", async () => {
  const source = user("personal", "That relationship helped me return to daily prayer. I miss her sometimes, but I have not decided to reconnect.");
  const value = "Mark says a past relationship helped him return to daily prayer; he has not decided to reconnect.";
  const h = harness({ messages: [source, assistant("reply")], respond(body, count) {
    if (count === 1) {
      assert.match(body.system, /missing someone does not establish an intention/);
      return jsonResponse(update([entry("relationship.significance", value, source, "relationship")]));
    }
    return review(body);
  } });
  await h.load("@/lib/memory/long-term-editor").maybeUpdateLongTermMemory("actor", "chat", source.content);
  assert.equal(h.writes[0].changes[0].value, value); assert.equal(h.calls.length, 3);
});

test("explicit corrections retain the full replacement prompt and existing replacement path", async () => {
  const source = user("correction", "Correct my tenure to 17 years and keep my other memories unchanged.");
  const original = entry("preference.complete_edits", "Mark wants complete edits.", source, "preference");
  const old = entry("experience.tenure", "Mark has fifteen years of fractional CFO experience.", source);
  const corrected = entry(old.key, "Mark has 17 years of fractional CFO experience.", source);
  const h = harness({ entries: [original, old], messages: [source], respond(body) {
    assert.match(body.system, /COMPLETE version-3 memory, retaining every unrelated existing entry/);
    assert.doesNotMatch(body.system, /ONLY new or changed entries/);
    return jsonResponse(update([original, corrected]));
  } });
  await h.load("@/lib/memory/long-term-editor").maybeUpdateLongTermMemory("actor", "chat", source.content, { required: true });
  assert.equal(h.calls.length, 1); assert.equal(h.writes[0].method, "replace");
  assert.equal(h.memory().entries.length, 2);
  assert.equal(h.memory().entries.find(item => item.key === original.key).value, original.value);
});

test("handoff selection and support verification retain their contracts on the same Claude client", async () => {
  const source = user("source", originalFact);
  const fact = entry("experience.recovery", "Mark led an accounting recovery through the team.", source);
  const h = harness({ respond(body) {
    if (body.system.startsWith("Select persistent knowledge")) return jsonResponse({ keys: [fact.key] });
    return review(body);
  } });
  const api = h.load("@/lib/memory/long-term-editor");
  assert.deepEqual(await api.selectTaskMemoryKeys("Prepare a relevant example", [fact]), [fact.key]);
  await api.verifyTaskMemorySupport([fact], [source]);
  assertNativeCalls(h.calls); assert.equal(h.calls.length, 3); assert.equal(h.writes.length, 0);
});

test("no_change and malformed JSON leave existing memory untouched", async () => {
  for (const response of [jsonResponse({ action: "no_change" }), { stop_reason: "end_turn", content: [{ type: "text", text: "not JSON" }] }]) {
    const h = harness({ entries: [{ key: "old", value: "Keep this existing record" }], respond: () => response });
    await h.load("@/lib/memory/long-term-editor").maybeUpdateLongTermMemory("actor", "chat", "Nothing new to save.");
    assert.equal(h.writes.length, 0); assert.equal(h.memory().entries[0].value, "Keep this existing record");
  }
});

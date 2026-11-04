import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync("lib/memory/summarizer.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const copy = x => JSON.parse(JSON.stringify(x));
const messageHistory = count => Array.from({ length: count }, (_, i) => ({
  id: "m" + i,
  role: i % 2 ? "assistant" : "user",
  content: "Historical detail from turn " + i,
  createdAt: new Date(Date.UTC(2026, 9, 26, 12, i)).toISOString(),
}));
const reply = (text, finish_reason = "stop") => ({
  choices: [{ finish_reason, message: { content: text } }],
});
const selected = (messageId = "m0", quote = "Historical detail from turn 0") =>
  reply(JSON.stringify({ quotes: [{ messageId, quote }] }));
const retained = (keep = []) => reply(JSON.stringify({ keep }));

function harness({
  history = messageHistory(90), prior = {}, configured = true,
  responses = n => n % 2 ? selected() : retained(),
  missingChat = false, commitResult = true,
} = {}) {
  let memory = copy(prior);
  const calls = [], events = [], logs = [], writes = [], claims = new Map(), constructors = [];
  const accountingError = error => error && (error.terminal === true || String(error.code ?? "").startsWith("standalone_"));
  class Transport {
    constructor(options) {
      constructors.push(options);
      this.chat = { completions: { create: async body => {
        const n = calls.length + 1;
        calls.push(copy(body));
        return responses(n, body);
      } } };
    }
  }
  const admin = {
    async rpc(name, args) {
      events.push({ name, args: copy(args) });
      if (name === "claim_intermediate_memory_batch") {
        if (args.p_expected_cursor !== (memory.summarizedThroughMessageId ?? null))
          return { data: "stale", error: null };
        const key = args.p_processor_version + ":" + args.p_batch_end_message_id;
        const old = claims.get(key);
        if (old) return { data: old === "processing" ? "processing" : "blocked", error: null };
        claims.set(key, "processing");
        return { data: "claimed" };
      }
      if (name === "commit_intermediate_memory_checkpoint") {
        if (args.p_expected_cursor !== (memory.summarizedThroughMessageId ?? null))
          return { data: false, error: null };
        if (!commitResult) return { data: false, error: null };
        writes.push(copy(args));
        memory = copy(args.p_content);
        return { data: true, error: null };
      }
      if (name === "finish_intermediate_memory_batch") {
        const key = args.p_processor_version + ":" + args.p_batch_end_message_id;
        if (claims.get(key) !== "processing") return { data: false, error: null };
        claims.set(key, args.p_state);
        return { data: true, error: null };
      }
      assert.fail("Unexpected RPC: " + name);
    },
  };
  const store = {
    async getChatById(id) { assert.equal(id, "chat"); return missingChat ? null : { actorId: "actor" }; },
    async getRecentMessages(id, limit) {
      assert.equal(id, "chat");
      assert.equal(limit, Number.MAX_SAFE_INTEGER);
      return history;
    },
    async getIntermediateMemory() { return copy(memory); },
    async setIntermediateMemory(actor, chat, content) {
      assert.equal(actor, "actor");
      assert.equal(chat, "chat");
      memory = copy(content);
      events.push({ name: "reset", args: copy(content) });
    },
  };
  const module = { exports: {} };
  const deps = {
    openai: Transport,
    "@/lib/data/persistence-store": store,
    "@/lib/data/supabase/admin": { getSupabaseAdminClient: () => admin },
    "@/lib/standalone-accounting/activity": { createActivityAccountingFetch: (provider, activity) => {
      events.push({ name: "accounting", provider, activity });
      return async () => { throw Error("Network disallowed in tests"); };
    } },
    "@/lib/standalone-accounting/context": { isStandaloneAccountingError: accountingError },
    "@/lib/memory/memory-contract": { SHORT_TERM_MESSAGE_LIMIT: 60 },
    "@/lib/memory/short-term": { filterConversationalMessages: m => m },
  };
  runInNewContext(compiled, {
    module, exports: module.exports,
    process: { env: configured ? { GROK_API_KEY: "test-only-key" } : {} },
    console: Object.fromEntries(["warn", "info", "error"].map(level => [level, (...args) => logs.push({ level, args })])),
    require: name => { assert.ok(name in deps, "Unknown dependency " + name); return deps[name]; },
  });
  return { run: () => module.exports.maybeUpdateSummary("chat"),
    calls, writes, events, logs, constructors, memory: () => memory };
}

test("Grok 4.7 is the exclusive model for both stages, with accounted non-retrying transport", async () => {
  const h = harness();
  assert.equal(await h.run(), "committed");
  assert.deepEqual(h.calls.map(x => x.model), ["grok-4.7", "grok-4.7"]);
  assert.deepEqual(h.calls.map(x => x.response_format), [{ type: "json_object" }, { type: "json_object" }]);
  assert.equal(h.constructors[0].baseURL, "https://api.x.ai/v1");
  assert.equal(h.constructors[0].maxRetries, 0);
  assert.ok(h.events.some(x => x.name === "accounting" && x.provider === "grok" && x.activity === "memory-summary"));
  assert.doesNotMatch(source, /CLAUDE_API_KEY|claude-sonnet|api\.anthropic\.com/);
});

test("factual ITM saves only source-verified literal quotes with speaker, message ID and timestamp", async () => {
  const h = harness();
  assert.equal(await h.run(), "committed");
  const text = h.memory().summary;
  assert.match(text, /USER \(2026-10-26T12:00:00\.000Z, message m0\): "Historical detail from turn 0"/);
  assert.doesNotMatch(text, /user prefers|Katie should|It seems|apparently/);
  assert.ok(text.length <= 6500);
  assert.equal(h.memory().summarizedThroughMessageId, "m29");
  assert.equal(h.memory().sourceMessageCount, 30);
});

test("retention cannot generate content; prior episodes can only be selected unchanged", async () => {
  const prior = {
    version: 2, summary: "Rolling recent conversations\n\nExisting factual record.",
    summarizedThroughMessageId: "m1", sourceMessageCount: 2,
  };
  const h = harness({ history: messageHistory(92), prior,
    responses: n => n === 1 ? selected("m2", "Historical detail from turn 2") : retained([0]) });
  assert.equal(await h.run(), "committed");
  assert.match(h.memory().summary, /Existing factual record\./);
  assert.match(h.memory().summary, /USER .*message m2.*Historical detail from turn 2/);
  assert.equal(h.memory().summarizedThroughMessageId, "m31");
  assert.equal(h.memory().sourceMessageCount, 32);
});

test("unsupported, cross-message, fabricated and oversized quotes fail closed without moving cursor", async () => {
  const wrong = [
    selected("m4", "Historical detail from turn 0"),
    selected("missing", "Historical detail from turn 0"),
    selected("m0", "Mark wanted a completely different result"),
    selected("m0", "H".repeat(451)),
    reply(JSON.stringify({ quotes: [{ messageId: "m0", quote: "Historical detail from turn 0" }, { messageId: "m0", quote: "Historical detail from turn 0" }] })),
  ];
  for (const bad of wrong) {
    const h = harness({ responses: () => bad });
    assert.equal(await h.run(), "blocked");
    assert.equal(h.writes.length, 0);
    assert.equal(await h.run(), "blocked");
    assert.equal(h.calls.length, 1);
  }
});

test("editorial rewrite is forbidden at reconciliation, even with otherwise valid evidence", async () => {
  const h = harness({ responses: n => n === 1 ? selected() :
    reply(JSON.stringify({ keep: [], add: ["Katie now understands the user's psychology."] })) });
  assert.equal(await h.run(), "blocked");
  assert.equal(h.writes.length, 0);
  assert.equal(h.calls.length, 2);
  assert.equal(await h.run(), "blocked");
});

test("Grok refuses to complete or malformed JSON blocks without replaying paid attempts", async () => {
  for (const responses of [
    n => n === 1 ? reply("partial", "length") : retained(),
    n => n === 1 ? selected() : reply("not JSON"),
  ]) {
    const h = harness({ responses });
    assert.equal(await h.run(), "blocked");
    assert.equal(h.calls.length, responses(1).choices[0].finish_reason === "length" ? 1 : 2);
    assert.equal(await h.run(), "blocked");
    assert.equal(h.writes.length, 0);
  }
});

test("empty factual batch is valid; no quotes are fabricated", async () => {
  const h = harness({ responses: n => n === 1 ? reply('{"quotes":[]}') : retained() });
  assert.equal(await h.run(), "committed");
  assert.equal(h.memory().summary, "");
  assert.equal(h.memory().summarizedThroughMessageId, "m29");
});

test("thirty-message threshold and failed cursor checks are unchanged", async () => {
  for (const count of [0, 60, 89]) {
    const h = harness({ history: messageHistory(count) });
    assert.equal(await h.run(), "skipped");
    assert.equal(h.calls.length, 0);
  }
  const prior = { version: 2, summary: "Preserve old material.", summarizedThroughMessageId: "removed", sourceMessageCount: 10 };
  const h = harness({ prior });
  assert.equal(await h.run(), "blocked");
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.memory(), prior);
});

test("backlog advances in source order and retains verified excerpts only", async () => {
  const h = harness({ history: messageHistory(130), responses: n => n % 2
    ? selected(n === 1 ? "m0" : "m30", n === 1 ? "Historical detail from turn 0" : "Historical detail from turn 30")
    : retained(n === 4 ? [0] : []) });
  assert.equal(await h.run(), "committed");
  assert.equal(await h.run(), "committed");
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.writes.map(w => w.p_content.summarizedThroughMessageId), ["m29", "m59"]);
  assert.match(h.memory().summary, /message m30/);
  assert.match(h.memory().summary, /message m0/);
});

test("accounting rejection, ambiguous provider failure and concurrent in-flight processing remain safe", async () => {
  const denial = Object.assign(new Error("Owner approval required"), { code: "standalone_approval_required", terminal: true });
  const blocked = harness({ responses: () => { throw denial; } });
  await assert.rejects(blocked.run(), e => e === denial);
  assert.equal(await blocked.run(), "deferred");
  assert.equal(blocked.calls.length, 1);
  const unknown = harness({ responses: () => { throw new Error("Provider outcome uncertain"); } });
  assert.equal(await unknown.run(), "blocked");
  assert.equal(await unknown.run(), "blocked");
  assert.equal(unknown.calls.length, 1);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const shared = harness({ responses: async n => { if (n === 1) await gate; return n === 1 ? selected() : retained(); } });
  const first = shared.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await shared.run(), "deferred");
  release();
  assert.equal(await first, "committed");
  assert.equal(shared.writes.length, 1);
});

test("no Grok key means skip without a fallback or database write", async () => {
  const h = harness({ configured: false });
  assert.equal(await h.run(), "skipped");
  assert.equal(h.calls.length, 0);
  assert.equal(h.writes.length, 0);
});

test("atomic source cursor prevents stale writes and preserves prior data", async () => {
  const prior = { version: 2, summary: "Do not overwrite", summarizedThroughMessageId: "m1", sourceMessageCount: 2 };
  const h = harness({ history: messageHistory(92), prior, responses: n =>
    n === 1 ? selected("m2", "Historical detail from turn 2") : retained(), commitResult: false });
  assert.equal(await h.run(), "deferred");
  assert.deepEqual(h.memory(), prior);
  assert.equal(h.writes.length, 0);
});

test("model prompts explicitly forbid interpretation and freeform authorship", async () => {
  const h = harness();
  assert.equal(await h.run(), "committed");
  const prompts = h.calls.map(x => x.messages[0].content);
  assert.match(prompts[0], /VERBATIM/);
  assert.match(prompts[0], /No guesses about motives/);
  assert.match(prompts[1], /NOT allowed to rewrite/);
  assert.match(prompts[1], /No inferred motivations/);
});

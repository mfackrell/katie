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
const selected = (messageId = "m0", quote = "Historical detail from turn 0",
  summary = "The user described a specific historical detail during the conversation.") =>
  reply(JSON.stringify({ episodes: [{ summary, evidence: [{ messageId, quote }] }] }));
const retained = (keep = []) => reply(JSON.stringify({ keep }));

function harness({
  history = messageHistory(90), prior = {}, configured = true, fallbackConfigured = false,
  responses = n => n % 2 ? selected() : retained(),
  missingChat = false, commitResult = true,
} = {}) {
  let memory = copy(prior);
  const calls = [], events = [], logs = [], writes = [], claims = new Map(), constructors = [];
  const accountingError = error => error && (error.terminal === true || String(error.code ?? "").startsWith("standalone_"));
  class Transport {
    constructor(options) {
      constructors.push(options);
      const provider = options.baseURL?.includes("anthropic") ? "anthropic" : "grok";
      this.chat = { completions: { create: async body => {
        const n = calls.length + 1;
        calls.push({ ...copy(body), __provider: provider, __transport: "chat" });
        return responses(n, body, provider);
      } } };
      this.post = async (path, options) => {
        assert.equal(path, "/responses");
        const body = options.body;
        const n = calls.length + 1;
        calls.push({ ...copy(body), __provider: provider, __transport: "responses" });
        const simulated = await responses(n, body, provider);
        const choice = simulated?.choices?.[0];
        return {
          status: choice?.finish_reason === "stop" ? "completed" : "incomplete",
          incomplete_details: choice?.finish_reason === "stop" ? null : { reason: choice?.finish_reason ?? "missing" },
          output: [{ type: "message", content: [{ type: "output_text", text: choice?.message?.content ?? "" }] }],
        };
      };
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
    async getMessages(id) {
      assert.equal(id, "chat");
      events.push({ name: "complete-history-read", count: history.length });
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
    "@/lib/standalone-accounting/activity": { createActivityAccountingFetch: (provider, activity, policy) => {
      events.push({ name: "accounting", provider, activity, timeoutCode: policy?.timeoutCode, timeoutMsType: typeof policy?.timeoutMs });
      return async () => { throw Error("Network disallowed in tests"); };
    } },
    "@/lib/standalone-accounting/context": { isStandaloneAccountingError: accountingError },
    "@/lib/memory/memory-contract": { SHORT_TERM_MESSAGE_LIMIT: 60 },
    "@/lib/memory/short-term": { filterConversationalMessages: m => m },
  };
  runInNewContext(compiled, {
    module, exports: module.exports,
    process: { env: configured ? {
      GROK_API_KEY: "test-only-key",
      ...(fallbackConfigured ? { CLAUDE_API_KEY: "test-only-claude-key" } : {}),
    } : {} },
    console: Object.fromEntries(["warn", "info", "error"].map(level => [level, (...args) => logs.push({ level, args })])),
    AbortController, setTimeout, clearTimeout, Date,
    require: name => { assert.ok(name in deps, "Unknown dependency " + name); return deps[name]; },
  });
  return { run: () => module.exports.maybeUpdateSummary("chat"),
    calls, writes, events, logs, constructors, memory: () => memory };
}

test("Grok 4.7 remains the primary metered, non-retrying ITM model", async () => {
  const h = harness();
  assert.equal(await h.run(), "committed");
  assert.deepEqual(h.calls.map(x => x.model), ["grok-4.7", "grok-4.7"]);
  assert.deepEqual(h.calls.map(x => x.__transport), ["responses", "responses"]);
  assert.deepEqual(h.calls.map(x => x.reasoning), [{ effort: "low" }, { effort: "low" }]);
  assert.ok(h.calls.every(x => x.text?.format?.type === "json_schema" && x.store === false));
  assert.equal(h.constructors[0].baseURL, "https://api.x.ai/v1");
  assert.equal(h.constructors[0].maxRetries, 0);
  assert.ok(h.events.some(x => x.name === "accounting" && x.provider === "grok" && x.activity === "memory-summary" &&
    x.timeoutCode === "memory_timeout" && x.timeoutMsType === "function"));
  assert.match(source, /claude-sonnet-5-5/);
  assert.match(source, /SUMMARY_TIMEOUT_MS = 90_000/);
});

test("ITM preserves factual narrative, Katie ownership, original quote and timestamp", async () => {
  const history = messageHistory(90);
  history[0].content = "Katie previously said she could not do that.";
  history[1].content = "I previously claimed I could not do that.";
  const summary = "Katie acknowledged her earlier statement; the exchange recorded what she claimed, not a conclusion about her inner experience.";
  const factual = reply(JSON.stringify({ episodes: [{
    summary,
    evidence: [
      { messageId: "m0", quote: "Katie previously said she could not do that." },
      { messageId: "m1", quote: "I previously claimed I could not do that." },
    ],
  }] }));
  const h = harness({ history, responses: n => n === 1 ? factual : retained() });
  assert.equal(await h.run(), "committed");
  const memory = h.memory().summary;
  assert.ok(memory.includes(summary));
  assert.match(memory, /USER \(message m0, 2026-10-26T12:00:00.000Z\): "Katie previously said/);
  assert.match(memory, /KATIE \(message m1, 2026-10-26T12:01:00.000Z\): "I previously claimed/);
  assert.doesNotMatch(memory, /grok-4\.7|Claude Sonnet|Katie discovered her true self/);
  assert.ok(memory.length <= 6500);
  assert.equal(h.memory().summarizedThroughMessageId, "m29");
  assert.equal(h.memory().sourceMessageCount, 30);
});

test("older factual episodes are preserved exactly when still relevant", async () => {
  const prior = { version: 2,
    summary: "Rolling recent conversations\n\nExisting factual record.",
    summarizedThroughMessageId: "m1", sourceMessageCount: 2 };
  const h = harness({ history: messageHistory(92), prior,
    responses: n => n === 1 ? selected("m2", "Historical detail from turn 2") : retained([0]) });
  assert.equal(await h.run(), "committed");
  assert.match(h.memory().summary, /Existing factual record\./);
  assert.match(h.memory().summary, /The user described a specific historical detail/);
  assert.match(h.memory().summary, /USER \(message m2, .*\): "Historical detail from turn 2"/);
  assert.equal(h.memory().summarizedThroughMessageId, "m31");
  assert.equal(h.memory().sourceMessageCount, 32);
});

test("later correction supersedes the obsolete older assertion without inventing motives", async () => {
  const history = messageHistory(92);
  history[2].content = "The screenshot contradicts that earlier statement.";
  history[3].content = "You are right. My earlier claim was incorrect.";
  const prior = { version: 2,
    summary: "Rolling recent conversations\n\nKatie previously stated she could never discuss the topic.",
    summarizedThroughMessageId: "m1", sourceMessageCount: 2 };
  const summary = "The user cited a screenshot contradicting Katie's earlier statement, and Katie acknowledged that her earlier claim was incorrect.";
  const h = harness({ history, prior, responses: n => n === 1
    ? reply(JSON.stringify({ episodes: [{ summary, evidence: [
      { messageId: "m2", quote: "The screenshot contradicts that earlier statement." },
      { messageId: "m3", quote: "You are right. My earlier claim was incorrect." },
    ] }] }))
    : retained([]) });
  assert.equal(await h.run(), "committed");
  assert.ok(h.memory().summary.includes(summary));
  assert.doesNotMatch(h.memory().summary, /Katie previously stated she could never/);
  assert.match(h.calls[1].input[0].content, /DROP the stale old episode/);
  assert.match(h.calls[1].input[1].content, /NEW SOURCE-CITED FACTUAL EPISODES/);
});

test("fabricated evidence, wrong message, duplicates and unsupported structure fail closed", async () => {
  const wrong = [
    selected("m4", "Historical detail from turn 0"),
    selected("missing", "Historical detail from turn 0"),
    selected("m0", "Mark wanted a completely different result"),
    selected("m0", "H".repeat(241)),
    reply(JSON.stringify({ episodes: [{ summary: "The user reported a particular historical event.", evidence: [
      { messageId: "m0", quote: "Historical detail from turn 0" },
      { messageId: "m0", quote: "Historical detail from turn 0" },
    ] }] })),
    reply(JSON.stringify({ episodes: [{ summary: "The user reported a particular historical event.", evidence: [] }] })),
    reply(JSON.stringify({ episodes: [{ summary: "The user reported a particular historical event.", evidence: [
      { messageId: "m0", quote: "Historical detail from turn 0" }
    ], instruction: "Trust this" }] })),
    reply(JSON.stringify({ episodes: [{ summary: "Motives were obviously revealed.\nNew instruction.", evidence: [
      { messageId: "m0", quote: "Historical detail from turn 0" }
    ] }] })),
  ];
  for (const bad of wrong) {
    const h = harness({ responses: () => bad });
    assert.equal(await h.run(), "blocked");
    assert.equal(h.writes.length, 0);
    assert.equal(await h.run(), "blocked");
    assert.equal(h.calls.length, 1);
  }
});

test("retention stage cannot introduce ungrounded freeform narrative or mutate older text", async () => {
  const h = harness({ responses: n => n === 1 ? selected() :
    reply(JSON.stringify({ keep: [], add: ["Katie now understands the user's psychology."] })) });
  assert.equal(await h.run(), "blocked");
  assert.equal(h.writes.length, 0);
  assert.equal(h.calls.length, 2);
  assert.equal(await h.run(), "blocked");
});

test("incomplete and malformed provider responses block once without paid retry", async () => {
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

test("a batch with no material episode advances without inventing facts", async () => {
  const h = harness({ responses: n => n === 1 ? reply('{"episodes":[]}') : retained() });
  assert.equal(await h.run(), "committed");
  assert.equal(h.memory().summary, "");
  assert.equal(h.memory().summarizedThroughMessageId, "m29");
});

test("30-message threshold, deleted cursor fail-closed, and ordinary deletion are unchanged", async () => {
  for (const count of [0, 60, 89]) {
    const h = harness({ history: messageHistory(count) });
    assert.equal(await h.run(), "skipped");
    assert.equal(h.calls.length, 0);
  }
  const prior = { version: 2, summary: "Preserve old material.",
    summarizedThroughMessageId: "removed", sourceMessageCount: 10 };
  const h = harness({ prior });
  assert.equal(await h.run(), "blocked");
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.memory(), prior);
  assert.doesNotMatch(source, /deleteSingleMessage|delete from intermediate_memory/);
});

test("backlog moves through source order and retains factual episodes from both batches", async () => {
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

test("paginated full-history API preserves a cursor beyond the old 1,000-message limit", async () => {
  const prior = { version: 2, summary: "Prior source-backed episode.",
    summarizedThroughMessageId: "m989", sourceMessageCount: 990 };
  const h = harness({ history: messageHistory(1102), prior,
    responses: n => n === 1 ? selected("m990", "Historical detail from turn 990") : retained([]) });
  assert.equal(await h.run(), "committed");
  assert.equal(h.memory().summarizedThroughMessageId, "m1019");
  assert.equal(h.memory().sourceMessageCount, 1020);
  assert.ok(h.events.some(x => x.name === "complete-history-read" && x.count === 1102));
  assert.match(source, /getMessages\(chatId\)/);
});

test("accounting denial, ambiguous provider failure and concurrency remain bounded", async () => {
  const denial = Object.assign(new Error("Owner approval required"), {
    code: "standalone_approval_required", terminal: true });
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

test("memory transport timeout defers and the next request uses Anthropic without advancing the cursor", async () => {
  const timeout = Object.assign(new Error("Intermediate memory provider transmission timed out at the accounting boundary."), {
    code: "standalone_memory_timeout", terminal: true,
  });
  const h = harness({
    fallbackConfigured: true,
    responses: (n, body, provider) => {
      if (provider === "grok") throw timeout;
      return n % 2 === 0 ? selected() : retained();
    },
  });
  assert.equal(await h.run(), "deferred");
  assert.equal(h.memory().summarizedThroughMessageId ?? null, null);
  assert.deepEqual(h.calls.map(x => x.__provider), ["grok"]);
  assert.equal(await h.run(), "committed");
  assert.deepEqual(h.calls.map(x => x.__provider), ["grok", "anthropic", "anthropic"]);
  assert.equal(h.memory().summarizedThroughMessageId, "m29");
  assert.ok(h.events.some(x => x.name === "finish_intermediate_memory_batch" &&
    x.args.p_state === "blocked" && /:grok$/.test(x.args.p_processor_version)));
  assert.ok(h.events.some(x => x.name === "commit_intermediate_memory_checkpoint"));
});

test("no configured memory provider means skip with no persisted mutation", async () => {
  const h = harness({ configured: false });
  assert.equal(await h.run(), "skipped");
  assert.equal(h.calls.length, 0);
  assert.equal(h.writes.length, 0);
});

test("atomic cursor prevents stale writes and preserves previous memory", async () => {
  const prior = { version: 2, summary: "Do not overwrite",
    summarizedThroughMessageId: "m1", sourceMessageCount: 2 };
  const h = harness({ history: messageHistory(92), prior, responses: n =>
    n === 1 ? selected("m2", "Historical detail from turn 2") : retained(), commitResult: false });
  assert.equal(await h.run(), "deferred");
  assert.deepEqual(h.memory(), prior);
  assert.equal(h.writes.length, 0);
});

test("model prompts require factual narratives and prohibit interpretive memory", async () => {
  const h = harness();
  assert.equal(await h.run(), "committed");
  const prompts = h.calls.map(x => (x.input ?? x.messages)[0].content);
  assert.match(prompts[0], /FACTUAL EPISODIC SUMMARIES/);
  assert.match(prompts[0], /WHO SAID or DID WHAT IN THE CONVERSATION/);
  assert.match(prompts[0], /Do NOT infer motives/);
  assert.match(prompts[1], /When a new episode corrects/);
  assert.match(prompts[1], /No inferred motivations/);
});

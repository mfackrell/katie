import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import OpenAI from "openai";

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
const retained = (keep = [],rejectNew = []) => reply(JSON.stringify({ keep,rejectNew }));

function harness({
  history = messageHistory(90), prior = {}, configured = true, fallbackConfigured = false,
  responses = n => n % 2 ? selected() : retained(),
  missingChat = false, commitResult = true,
  priorExposure = { grok_sent:false, anthropic_sent:false, paused:false, in_flight:false },
  exposureInspectionError = false,
  transportClass = null, fetchOverride = null, legacyRaw = null,
} = {}) {
  let memory = copy(prior);
  const calls = [], events = [], logs = [], writes = [], claims = new Map(), constructors = [], receipts = new Map();
  const terminalBatches = new Set();
  const accountingCause = error => {
    let current = error;
    for(let depth=0;current&&typeof current==="object"&&depth<8;depth++){
      if(current.terminal===true || String(current.code??"").startsWith("standalone_"))return current;
      current=current.cause;
    }
    return undefined;
  };
  const accountingError = error => Boolean(accountingCause(error));
  const failureDetails = error => {
    const parts=[];
    let current=error;
    for(let depth=0;current&&typeof current==="object"&&depth<8;depth++){
      parts.push([current.name,current.code,current.message].filter(Boolean).join(": "));
      current=current.cause;
    }
    return parts.join(" ← ");
  };
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
        assert.equal(path, provider === "grok" ? "/responses" : "/messages");
        const body = options.body;
        const n = calls.length + 1;
        calls.push({ ...copy(body), __provider: provider, __transport: path.slice(1) });
        const simulated = await responses(n, body, provider);
        if(provider==="anthropic") {
          if(simulated?.stop_reason!==undefined)return simulated;
          const choice=simulated?.choices?.[0];
          return {
            stop_reason:choice?.finish_reason==="stop"?"end_turn":"max_tokens",
            content:[{type:"text",text:choice?.message?.content??""}],
          };
        }
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
      if (name === "claim_itm_stage2_one_shot") return {data:false,error:null}; // No owner grant in ordinary ITM test fixtures.
      if (name === "inspect_itm_batch_provider_exposure") {
        const matching=[...claims.entries()].filter(([key])=>key.endsWith(":"+args.p_batch_end_message_id));
        const active=matching.some(([,state])=>state==="processing");
        return exposureInspectionError ? {data:null,error:{message:"Inspection unavailable"}} :
          {data:{...copy(priorExposure),
            in_flight:priorExposure.in_flight || active,
            terminal:Boolean(priorExposure.terminal)||terminalBatches.has(args.p_batch_end_message_id)},error:null};
      }
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
        if (!(typeof commitResult === "function" ? commitResult() : commitResult)) return { data: false, error: null };
        writes.push(copy(args));
        memory = copy(args.p_content);
        return { data: true, error: null };
      }
      if (name === "finish_intermediate_memory_batch") {
        const key = args.p_processor_version + ":" + args.p_batch_end_message_id;
        if (claims.get(key) !== "processing") return { data: false, error: null };
        claims.set(key, args.p_state);
        if (args.p_state === "blocked" && String(args.p_reason??"").startsWith("ITM_TERMINAL:")) {
          terminalBatches.add(args.p_batch_end_message_id);
        }
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
    openai: transportClass ?? Transport,
    "@/lib/data/persistence-store": store,
    "@/lib/data/supabase/admin": { getSupabaseAdminClient: () => admin },
    "@/lib/standalone-accounting/activity": { createActivityAccountingFetch: (provider, activity, policy) => {
      events.push({ name: "accounting", provider, activity, timeoutCode: policy?.timeoutCode, timeoutMsType: typeof policy?.timeoutMs });
      return fetchOverride ?? (async () => { throw Error("Network disallowed in tests"); });
    } },
    "@/lib/standalone-accounting/context": {
      isStandaloneAccountingError: accountingError,
      standaloneAccountingCause: accountingCause,
      standaloneFailureDetails: failureDetails,
    },
    "@/lib/memory/itm-stage-receipts": {
      itmReceiptHash: value => "hash:" + String(value).length,
      readItmStageReceipt: async key => {
        const sourceKey=[key.actorId,key.chatId,key.batchEndMessageId,key.expectedCursor,
          key.sourceSha256,key.contextSha256].join(":");
        const receipt=receipts.get(key.provider+":"+key.stage)?.get(sourceKey);
        events.push({name:"stage_receipt_read",provider:key.provider,stage:key.stage,present:Boolean(receipt)});
        return receipt??null;
      },
      recordItmStageReceipt: async (key,text) => {
        const id=key.provider+":"+key.stage;
        const sourceKey=[key.actorId,key.chatId,key.batchEndMessageId,key.expectedCursor,
          key.sourceSha256,key.contextSha256].join(":");
        const saved={responseText:text,responseSha256:"receipt-"+text.length};
        const sameStage=receipts.get(id)??new Map();
        const prior=sameStage.get(sourceKey);
        if(prior && prior.responseText!==text) throw Error("ITM_RECEIPT_WRITE_UNAVAILABLE_OR_CONFLICT");
        sameStage.set(sourceKey,saved);
        receipts.set(id,sameStage);
        events.push({name:"stage_receipt_saved",provider:key.provider,stage:key.stage});
        return saved;
      },
      inspectPriorItmClaims: async(actorId,chatId,sourceEnd)=>{
        const versions=[...claims.keys()].filter(key=>key.endsWith(":"+sourceEnd));
        return {grok:versions.some(k=>k.includes(":grok:")),
          anthropic:versions.some(k=>k.includes(":anthropic:"))};
      },
      readLegacyItmEpisodeOutput: async(actorId,chatId,end,provider)=>{
        events.push({name:"legacy_receipt_lookup",provider,actorId,chatId,end});
        return legacyRaw && provider==="grok"
          ? {responseText:legacyRaw,ledgerAttemptId:"historical-settled-grok"}
          : null;
      },
    },
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
    calls, writes, events, logs, constructors, receipts, memory: () => memory };
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
  assert.match(source, /SUMMARY_TIMEOUT_MS = 180_000/);
});

test("ITM preserves factual paraphrase, speaker ownership, source ID and timestamp", async () => {
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
  assert.match(memory, /USER \(message m0, 2026-10-26T12:00:00.000Z\)/);
  assert.match(memory, /KATIE \(message m1, 2026-10-26T12:01:00.000Z\)/);
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
  assert.match(h.memory().summary, /USER \(message m2, /);
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
  assert.match(h.calls[1].input[1].content, /NEW FACTUAL EPISODES FOR SEMANTIC REVIEW/);
});

test("invalid source IDs are skipped while supported episodes survive",async()=>{
  const h=harness({responses:n=>n===1?reply(JSON.stringify({episodes:[
    {summary:"The user described an accurate historical detail in the exchange.",evidence:[{messageId:"m0"}]},
    {summary:"An unsupported claim with no real source message was invented.",evidence:[{messageId:"not-a-message"}]},
    {summary:"A malformed fragment has no evidence and should be ignored.",evidence:[]},
  ]})):retained()});
  assert.equal(await h.run(),"committed");
  assert.match(h.memory().summary,/accurate historical detail/);
  assert.doesNotMatch(h.memory().summary,/unsupported claim|malformed fragment/);
  assert.equal(h.calls.length,2);
  assert.equal(h.memory().summarizedThroughMessageId,"m29");
});

test("semantic LLM review drops materially false claims and preserves accurate paraphrases",async()=>{
  const h=harness({responses:n=>n===1?reply(JSON.stringify({episodes:[
    {summary:"The user mentioned a historical detail during the discussion.",evidence:[{messageId:"m0"}]},
    {summary:"Katie falsely claimed the user agreed to a fabricated commercial sale.",evidence:[{messageId:"m1"}]},
  ]})):retained([], [1])});
  assert.equal(await h.run(),"committed");
  assert.match(h.memory().summary,/mentioned a historical detail/);
  assert.doesNotMatch(h.memory().summary,/fabricated commercial sale/);
  assert.equal(h.calls.length,2,"the existing second call performs semantic review");
  assert.match(h.calls[1].input[0].content,/material fabrication, contradiction, or wrong speaker attribution/);
  assert.match(h.calls[1].input[1].content,/ROLE-ATTRIBUTED SOURCE TRANSCRIPT/);
  assert.match(h.calls[1].input[1].content,/Historical detail from turn 0/);
});

test("malformed full-stage JSON remains blocked without paid retransmission",async()=>{
  const h=harness({responses:()=>reply("not JSON")});
  assert.equal(await h.run(),"blocked");
  assert.equal(await h.run(),"blocked");
  assert.equal(h.calls.length,1);
  assert.equal(h.writes.length,0);
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
  assert.equal(await blocked.run(), "blocked");
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
  assert.deepEqual(h.calls.map(x => x.__transport), ["responses","messages","messages"]);
  assert.ok(h.calls.slice(1).every(x => x.model==="claude-sonnet-5-5" &&
    x.thinking?.type==="between_tools" && x.output_config?.format?.type==="json_schema" &&
    x.messages.length===1 && !("temperature" in x) && !("response_format" in x)));
  assert.equal(h.constructors[1].baseURL, "https://api.anthropic.com/v1/");
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
  assert.equal(h.events.find(e=>e.name==="finish_intermediate_memory_batch").args.p_state,"blocked");
  assert.equal(await h.run(),"deferred","cached stage receipts may retry checkpoint CAS without another provider call");
  assert.equal(h.calls.length,2,"no additional paid provider dispatch");
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
  assert.match(prompts[1], /Semantically check every NEW episode/);
});

test("legacy cancelled chat lease cannot permanently veto metered ITM fallback", async () => {
  const terminal=Object.assign(new Error("Owner-request cancellation"), {
    code: "standalone_cancelled", terminal: true,
  });
  const wrapped=Object.assign(new Error("Connection error."), {cause:terminal});
  const h=harness({fallbackConfigured:true,responses:(n,body,provider)=>{
    if(provider==="grok")throw wrapped;
    return n===2?selected():retained();
  }});
  await assert.rejects(h.run(),error=>error===wrapped);
  assert.deepEqual(h.calls.map(call=>call.__provider),["grok"]);
  assert.equal(h.writes.length,0);
  assert.ok(h.logs.some(log=>log.args[0]?.includes("Non-retryable") &&
    String(log.args[1]?.diagnostic??"").includes("standalone_cancelled")));
  // Memory is independent infrastructure, so an old chat-lease denial cannot
  // permanently disable this batch. Its failed Grok claim must not replay.
  assert.equal(await h.run(),"committed");
  assert.deepEqual(h.calls.map(call=>call.__provider),["grok","anthropic","anthropic"]);
  assert.equal(h.memory().summarizedThroughMessageId,"m29");
});

test("nested SDK timeout is recognized and permits Claude only on a later request", async () => {
  const timeout=Object.assign(new Error("provider timed out"), {
    code:"standalone_memory_timeout",terminal:true,
  });
  const wrapped=Object.assign(new Error("Connection error."),{cause:timeout});
  const h=harness({fallbackConfigured:true,responses:(n,body,provider)=>{
    if(provider==="grok")throw wrapped;
    return n===2?selected():retained();
  }});
  assert.equal(await h.run(),"deferred");
  assert.equal(h.memory().summarizedThroughMessageId??null,null);
  assert.equal(await h.run(),"committed");
  assert.deepEqual(h.calls.map(call=>call.__provider),["grok","anthropic","anthropic"]);
  assert.equal(h.memory().summarizedThroughMessageId,"m29");
});

test("both unavailable providers preserve the original cursor and do not retry a blocked batch", async () => {
  const h=harness({fallbackConfigured:true,responses:()=>{throw new Error("Connection error.");}});
  assert.equal(await h.run(),"deferred");
  assert.equal(await h.run(),"blocked");
  assert.equal(await h.run(),"blocked");
  assert.deepEqual(h.calls.map(call=>call.__provider),["grok","anthropic"]);
  assert.equal(h.writes.length,0);
  assert.equal(h.memory().summarizedThroughMessageId??null,null);
});

// Independent source-batch recovery must distinguish previous paid provider
// transmission from a fresh claim under the new processor version.
test("previous metered Grok batch routes to native Claude without another Grok transmission", async () => {
  const h = harness({
    fallbackConfigured:true,
    priorExposure:{grok_sent:true,anthropic_sent:false,paused:false,in_flight:false},
    responses:n=>n===1?selected():retained(),
  });
  assert.equal(await h.run(),"committed");
  assert.deepEqual(h.calls.map(x=>x.__provider),["anthropic","anthropic"]);
  assert.deepEqual(h.calls.map(x=>x.__transport),["messages","messages"]);
  assert.equal(h.memory().sourceMessageCount,30);
  assert.equal(h.memory().summarizedThroughMessageId,"m29");
  assert.equal(h.events.filter(e=>e.name==="claim_intermediate_memory_batch").length,1);
  assert.match(h.events.find(e=>e.name==="claim_intermediate_memory_batch").args.p_processor_version,/v14.*:anthropic$/);
});

test("previously sent Claude source batch never reverses fallback to Grok",async()=>{
  const h=harness({
    fallbackConfigured:true,
    priorExposure:{grok_sent:false,anthropic_sent:true,paused:false,in_flight:false},
  });
  assert.equal(await h.run(),"blocked");
  assert.equal(h.calls.length,0);
  assert.equal(h.writes.length,0);
  assert.equal(h.events.filter(e=>e.name==="claim_intermediate_memory_batch").length,0);
});

test("v12 accounting-lease terminal marker cannot block fresh v13 infrastructure recovery",async()=>{
  const h=harness({
    fallbackConfigured:true,
    priorExposure:{grok_sent:true,anthropic_sent:false,paused:false,in_flight:false,terminal:true},
    responses:n=>n===1?selected():retained(),
  });
  assert.equal(await h.run(),"committed");
  assert.deepEqual(h.calls.map(x=>x.__provider),["anthropic","anthropic"]);
  assert.equal(h.memory().summarizedThroughMessageId,"m29");
});

test("historical exposure inspection blocks duplicate paid work and preserves cursor",async()=>{
  for(const opts of [

    {priorExposure:{grok_sent:false,anthropic_sent:false,paused:false,in_flight:true}},
    {priorExposure:{grok_sent:true,anthropic_sent:true,paused:false,in_flight:false}},
    {exposureInspectionError:true},
  ]) {
    const h=harness({fallbackConfigured:true,...opts});
    const result=await h.run();
    assert.ok(["blocked","deferred"].includes(result));
    assert.equal(h.calls.length,0);
    assert.equal(h.writes.length,0);
    assert.equal(h.events.filter(e=>e.name==="claim_intermediate_memory_batch").length,0);
  }
});

test("native Claude enforces API-compatible schema but retains source validators",async()=>{
  const h=harness({fallbackConfigured:true,priorExposure:{grok_sent:true,anthropic_sent:false,paused:false,in_flight:false}});
  assert.equal(await h.run(),"committed");
  for(const call of h.calls) {
    assert.equal(call.__provider,"anthropic");
    assert.equal(call.__transport,"messages");
    assert.equal(call.max_tokens>0,true);
    assert.equal(typeof call.system,"string");
    assert.deepEqual(call.messages.map(m=>m.role),["user"]);
    assert.equal(call.thinking?.type,"between_tools");
    assert.equal(call.output_config?.effort,"low");
    const schema=JSON.stringify(call.output_config.format.schema);
    assert.doesNotMatch(schema,/"(?:maxItems|uniqueItems|minimum|maximum|minLength|maxLength)":/);
    assert.equal(JSON.parse(schema).additionalProperties,false);
  }
  const malformed=harness({
    fallbackConfigured:true,priorExposure:{grok_sent:true,anthropic_sent:false,paused:false,in_flight:false},
    responses:()=>reply(JSON.stringify({episodes:[{summary:"invented unsourced account",evidence:[{messageId:"not-found",quote:"made up"}]}]})),
  });
  assert.equal(await malformed.run(),"blocked");
  assert.equal(malformed.writes.length,0);
});

test("obsolete accounting billing failure is audited but cannot permanently gate memory",async()=>{
  const reason=Object.assign(Error("Unsupported endpoint or billing region"),{
    code:"standalone_unsupported_billing",terminal:true,
  });
  const wrapped=Object.assign(Error("Connection error."),{cause:reason});
  const h=harness({fallbackConfigured:true,responses:(n,body,provider)=>{
    if(provider==="grok")throw wrapped;
    return n===2?selected():retained();
  }});
  await assert.rejects(h.run(),e=>e===wrapped);
  assert.equal(h.writes.length,0);
  const finish=h.events.find(x=>x.name==="finish_intermediate_memory_batch");
  assert.equal(finish.args.p_state,"blocked");
  assert.match(finish.args.p_reason,/standalone_unsupported_billing/);
  // Old provider claim remains immutable; v13's infrastructure fallback can
  // continue with Claude without crossing back into the request budget.
  assert.equal(await h.run(),"committed");
  assert.deepEqual(h.calls.map(c=>c.__provider),["grok","anthropic","anthropic"]);
  assert.equal(h.memory().summarizedThroughMessageId,"m29");
});

test("an unsourced episode is discarded while the batch can commit",async()=>{
  const h=harness({responses:n=>n===1?reply(JSON.stringify({episodes:[{
    summary:"The user described a specific historical detail during the conversation.",
    evidence:[],
  }]})):retained()});
  assert.equal(await h.run(),"committed");
  assert.equal(h.calls.length,2);
  assert.equal(h.receipts.has("grok:episodes"),true);
  assert.equal(h.memory().summary,"");
  assert.equal(h.memory().summarizedThroughMessageId,"m29");
  assert.equal(await h.run(),"skipped");
  assert.equal(h.calls.length,2);
});

test("source-verified legacy Grok episodes can be imported with zero paid calls",async()=>{
  const legacy=selected().choices[0].message.content;
  const h=harness({
    priorExposure:{grok_sent:true,anthropic_sent:false,paused:false,in_flight:false},
    legacyRaw:legacy,
  });
  assert.equal(await h.run(),"blocked","stage 2 retention plan is still missing");
  assert.equal(h.calls.length,0,"no fresh Grok or Claude inference authorized");
  assert.equal(h.receipts.has("grok:episodes"),true);
  assert.equal(h.receipts.has("grok:retention"),false);
  assert.equal(h.memory().summarizedThroughMessageId??null,null);
  assert.ok(h.events.some(e=>e.name==="legacy_receipt_lookup"&&e.provider==="grok"));
});

test("completed captured stages replay without provider work after a commit failure",async()=>{
  let allowCommit=false;
  const h=harness({commitResult:()=>allowCommit});
  assert.equal(await h.run(),"deferred");
  assert.equal(h.calls.length,2);
  assert.equal(h.receipts.size,2);
  allowCommit=true;
  assert.equal(await h.run(),"committed");
  assert.equal(h.calls.length,2,"offline receipt recovery has no provider call");
  assert.equal(h.events.some(e=>e.name==="claim_itm_stage2_one_shot"),false,
    "initial batch with no prior cursor must not claim the historical Claude exception");
  assert.equal(h.memory().summarizedThroughMessageId,"m29");
  assert.equal(h.events.some(e=>e.name==="finish_intermediate_memory_batch"&&e.args.p_state==="completed"&&
    e.args.p_processor_version.endsWith(":offline-recovery")),true);
});


test("immutable same-provider receipts survive two failed CAS attempts without another inference",async()=>{
  let commits=0;
  const h=harness({commitResult:()=>++commits>=3});
  assert.equal(await h.run(),"deferred","original paid attempt fails checkpoint");
  assert.equal(await h.run(),"deferred","first offline CAS fails but its receipts survive");
  assert.equal(await h.run(),"committed","blocked offline claim permits receipt-only CAS replay");
  assert.equal(h.calls.length,2,"only the initial two provider stages were transmitted");
  assert.equal(h.memory().summarizedThroughMessageId,"m29");
  assert.equal(h.events.filter(e=>e.name==="claim_itm_stage2_one_shot").length,0,
    "the unrelated one-shot Claude grant must not be consumed");
  assert.equal(h.events.filter(e=>e.name==="commit_intermediate_memory_checkpoint").length,3);
});

test("a too-short episode is skipped without blocking other processing",async()=>{
  const h=harness({responses:n=>n===1?reply(JSON.stringify({episodes:[{
    summary:"Too short",evidence:[{messageId:"m0"}],
  }]})):retained()});
  assert.equal(await h.run(),"committed");
  assert.equal(h.memory().summary,"");
  assert.ok(h.logs.some(l=>String(l.args[0]??"").includes("Skipped malformed individual ITM episode")));
});

test("native Claude truncation blocks with unchanged checkpoint",async()=>{
  const h=harness({
    fallbackConfigured:true,priorExposure:{grok_sent:true,anthropic_sent:false,paused:false,in_flight:false},
    responses:()=>({stop_reason:"max_tokens",content:[{type:"text",text:'{"episodes":[]}'}]}),
  });
  assert.equal(await h.run(),"blocked");
  assert.equal(h.writes.length,0);
  assert.equal(h.memory().summarizedThroughMessageId??null,null);
  assert.equal(h.events.find(e=>e.name==="finish_intermediate_memory_batch").args.p_state,"blocked");
});

test("installed OpenAI SDK serializes ITM native Claude calls to /v1/messages with no retry",async()=>{
  const requests=[];
  const texts=[
    selected().choices[0].message.content,
    retained().choices[0].message.content,
  ];
  const fetchOverride=async(input,init)=>{
    requests.push({url:String(input),body:JSON.parse(init.body),headers:new Headers(init.headers)});
    return new Response(JSON.stringify({
      id:"msg_synthetic_itm_"+requests.length,
      type:"message",role:"assistant",model:"claude-sonnet-5-5",
      stop_reason:"end_turn",content:[{type:"text",text:texts[requests.length-1]}],
      usage:{input_tokens:1200,output_tokens:400},
    }),{status:200,headers:{"content-type":"application/json"}});
  };
  const h=harness({
    transportClass:OpenAI,fetchOverride,fallbackConfigured:true,
    priorExposure:{grok_sent:true,anthropic_sent:false,paused:false,in_flight:false},
  });
  assert.equal(await h.run(),"committed");
  assert.equal(requests.length,2);
  assert.ok(requests.every(r=>r.url==="https://api.anthropic.com/v1/messages"));
  assert.ok(requests.every(r=>r.headers.get("authorization")===null &&
    r.headers.get("x-api-key")==="test-only-claude-key" &&
    r.headers.get("anthropic-version")==="2023-06-01"));
  assert.deepEqual(requests.map(r=>r.body.max_tokens),[2300,2800]);
  assert.ok(requests.every(r=>r.body.model==="claude-sonnet-5-5" &&
    r.body.thinking.type==="between_tools" && r.body.output_config.effort==="low" &&
    r.body.output_config.format.type==="json_schema" &&
    !("temperature" in r.body) && !("response_format" in r.body)));
  assert.equal(h.memory().summarizedThroughMessageId,"m29");
  assert.equal(h.writes.length,1);
});

test("installed SDK native Claude truncated output cannot advance ITM checkpoint",async()=>{
  let sends=0;
  const fetchOverride=async()=>{
    sends++;
    return new Response(JSON.stringify({
      id:"msg_synthetic_truncated",type:"message",role:"assistant",
      stop_reason:"max_tokens",content:[{type:"text",text:'{"episodes":[]}'}],
    }),{status:200,headers:{"content-type":"application/json"}});
  };
  const h=harness({
    transportClass:OpenAI,fetchOverride,fallbackConfigured:true,
    priorExposure:{grok_sent:true,anthropic_sent:false,paused:false,in_flight:false},
  });
  assert.equal(await h.run(),"blocked");
  assert.equal(sends,1);
  assert.equal(h.writes.length,0);
  assert.equal(h.memory().summarizedThroughMessageId??null,null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync("lib/memory/summarizer.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const copy = value => JSON.parse(JSON.stringify(value));
const messageHistory = count => Array.from({ length: count }, (_, i) => ({
  id: "m" + i, role: i % 2 ? "assistant" : "user",
  content: "Historical detail from turn " + i,
  createdAt: new Date(Date.UTC(2026, 9, 26, 12, i)).toISOString(),
}));
const reply = (text, stop_reason = "end_turn") => ({
  stop_reason, content: [{ type: "text", text }],
});

/** Isolated real module with deterministic in-memory database/provider doubles. */
function harness({
  history = messageHistory(90), prior = {}, configured = true,
  responses = (n) => reply(n % 2 ? "New source-grounded developments." : "Curated, reconciled continuity."),
  missingChat = false, commitResult = true,
} = {}) {
  let memory = copy(prior);
  const calls = [], events = [], logs = [], writes = [], claims = new Map(), constructors = [];
  const accountingError = error => error && (error.terminal === true || String(error.code ?? "").startsWith("standalone_"));
  class Transport {
    constructor(options) { constructors.push(options); }
    async post(path, options) {
      const n = calls.length + 1;
      calls.push({path,body:copy(options.body)});
      return responses(n, options.body);
    }
  }
  const admin = {
    async rpc(name, args) {
      events.push({name,args:copy(args)});
      if (name === "claim_intermediate_memory_batch") {
        if (args.p_expected_cursor !== (memory.summarizedThroughMessageId ?? null))
          return {data:"stale",error:null};
        const key = args.p_processor_version + ":" + args.p_batch_end_message_id;
        const old = claims.get(key);
        if (old) return {data:old==="processing"?"processing":"blocked",error:null};
        claims.set(key,"processing");
        return {data:"claimed",error:null};
      }
      if (name === "commit_intermediate_memory_checkpoint") {
        if (args.p_expected_cursor !== (memory.summarizedThroughMessageId ?? null))
          return {data:false,error:null};
        if (!commitResult) return {data:false,error:null};
        writes.push(copy(args));memory=copy(args.p_content);
        return {data:true,error:null};
      }
      if (name === "finish_intermediate_memory_batch") {
        const key = args.p_processor_version + ":" + args.p_batch_end_message_id;
        if (claims.get(key)!=="processing") return {data:false,error:null};
        claims.set(key,args.p_state);
        return {data:true,error:null};
      }
      assert.fail("Unexpected RPC: "+name);
    },
  };
  const store = {
    async getChatById(id) {assert.equal(id,"chat");return missingChat?null:{actorId:"actor"};},
    async getRecentMessages(id,limit) {
      assert.equal(id,"chat");assert.equal(limit,Number.MAX_SAFE_INTEGER);return history;
    },
    async getIntermediateMemory() {return copy(memory);},
    async setIntermediateMemory(actor,chat,content) {
      assert.equal(actor,"actor");assert.equal(chat,"chat");
      memory=copy(content);events.push({name:"reset",args:copy(content)});
    },
  };
  const module={exports:{}};
  const deps={
    openai:Transport,
    "@/lib/data/persistence-store":store,
    "@/lib/data/supabase/admin":{getSupabaseAdminClient:()=>admin},
    "@/lib/standalone-accounting/activity":{createActivityAccountingFetch:(provider,activity)=>{
      events.push({name:"accounting",provider,activity});
      return async()=>{throw Error("Live provider access in test");};
    }},
    "@/lib/standalone-accounting/context":{isStandaloneAccountingError:accountingError},
    "@/lib/memory/memory-contract":{SHORT_TERM_MESSAGE_LIMIT:60},
    "@/lib/memory/short-term":{filterConversationalMessages:m=>m},
  };
  runInNewContext(compiled,{
    module,exports:module.exports,
    process:{env:configured?{CLAUDE_API_KEY:"test-only-key"}:{}},
    console:Object.fromEntries(["warn","info","error"].map(level=>[level,(...args)=>logs.push({level,args})])),
    require:n=>{assert.ok(n in deps,"Unknown dependency "+n);return deps[n];},
  });
  return {
    run:()=>module.exports.maybeUpdateSummary("chat"),
    calls,writes,events,logs,constructors,
    memory:()=>memory,claims,
  };
}


test("30-message boundary remains unchanged and never triggers unnecessary calls",async()=>{
  for(const count of [0,60,89]){
    const h=harness({history:messageHistory(count)});
    assert.equal(await h.run(),"skipped");assert.equal(h.calls.length,0);
  }
});

test("one summary call and deterministic rollover advance an atomic checkpoint",async()=>{
  const h=harness({responses:()=>reply("Recent user clarification and unresolved work.")});
  assert.equal(await h.run(),"committed");
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].body.max_tokens,2300);
  assert.match(h.calls[0].body.messages[0].content,/Historical detail from turn 29/);
  assert.doesNotMatch(h.calls[0].body.messages[0].content,/Historical detail from turn 30\\b/);
  assert.match(h.memory().summary,/Rolling recent conversations/);
  assert.match(h.memory().summary,/Recent user clarification and unresolved work/);
  assert.equal(h.memory().summarizedThroughMessageId,"m29");
  assert.equal(h.memory().sourceMessageCount,30);
  assert.equal(h.writes.length,1);
  assert.equal(h.events.find(e=>e.name==="finish_intermediate_memory_batch").args.p_state,"completed");
});

test("legacy 14,774-character memory is compacted without asking a model to rewrite it",async()=>{
  const prior={
    version:2,
    summary:"Opening biographical details. ".repeat(18)+"\\n\\n**Latest engineering discussion**\\n- Unfinished repair awaiting verification.\\n"+
      "**Older thread**\\n- Previously discussed details. ".repeat(320),
    summarizedThroughMessageId:"m1",sourceMessageCount:2,
  };
  assert.ok(prior.summary.length>14000);
  const h=harness({history:messageHistory(92),prior,responses:()=>reply("New discussion about ITM reliability.")});
  assert.equal(await h.run(),"committed");
  assert.equal(h.calls.length,1);
  assert.equal(h.memory().summarizedThroughMessageId,"m31");
  assert.ok(h.memory().summary.length<=6500);
  assert.match(h.memory().summary,/New discussion about ITM reliability/);
  assert.match(h.memory().summary,/Unfinished repair/);
  assert.doesNotMatch(h.memory().summary,/Opening biographical details/);
});

test("two successive batches remain bounded and retain the newer episode first",async()=>{
  let index=0;
  const h=harness({history:messageHistory(130),responses:()=>reply(++index===1?
    "Earlier discussion: outstanding review." : "Newer discussion: review completed.")});
  assert.equal(await h.run(),"committed");
  assert.equal(await h.run(),"committed");
  assert.equal(h.calls.length,2);
  assert.deepEqual(h.writes.map(w=>w.p_content.summarizedThroughMessageId),["m29","m59"]);
  const mem=h.memory().summary;
  assert.ok(mem.indexOf("Newer discussion")<mem.indexOf("Earlier discussion"));
  assert.ok(mem.length<=6500);
  assert.equal(await h.run(),"skipped");
});

test("large batches cannot enlarge saved ITM beyond the deterministic limit",async()=>{
  let call=0;
  const h=harness({history:messageHistory(210),responses:()=>reply("Episode "+(++call)+": "+("A lengthy meaningful discussion. ".repeat(140)))});
  for(let i=0;i<5;i++) assert.equal(await h.run(),"committed");
  assert.equal(h.calls.length,5);
  assert.ok(h.memory().summary.length<=6500);
  assert.match(h.memory().summary,/Episode 5/);
  assert.doesNotMatch(h.memory().summary,/Episode 1/);
});

test("successful v6 claim does not disturb earlier blocked v5 claim or accounting",async()=>{
  const prior={version:2,summary:"Prior note.",summarizedThroughMessageId:"m1",sourceMessageCount:2};
  const h=harness({history:messageHistory(92),prior,responses:()=>reply("New episode.")});
  h.claims.set("two-stage-30-messages-v5-selective-recovery:m31","blocked");
  assert.equal(await h.run(),"committed");
  assert.equal(h.claims.get("two-stage-30-messages-v5-selective-recovery:m31"),"blocked");
  assert.equal(h.events.find(e=>e.name==="claim_intermediate_memory_batch").args.p_processor_version,
    "single-stage-30-messages-v6-deterministic-rollover");
  assert.equal(h.constructors[0].maxRetries,0);
  assert.equal(h.events.filter(e=>e.name==="accounting")[0].activity,"memory-summary");
});

test("incomplete provider output is rejected with no write or unauthorized retry",async()=>{
  const prior={version:2,summary:"Original memory.",summarizedThroughMessageId:"m1",sourceMessageCount:2};
  const h=harness({history:messageHistory(92),prior,responses:()=>reply("Truncated","max_tokens")});
  assert.equal(await h.run(),"blocked");
  assert.equal(h.writes.length,0);
  assert.deepEqual(h.memory(),prior);
  assert.equal(await h.run(),"blocked");
  assert.equal(h.calls.length,1);
});

test("unknown provider failures remain blocked and cannot spend twice",async()=>{
  const h=harness({responses:()=>{throw Error("Previous provider outcome unavailable");}});
  assert.equal(await h.run(),"blocked");
  assert.equal(await h.run(),"blocked");
  assert.equal(h.calls.length,1);
  assert.equal(h.writes.length,0);
});

test("accounting and authorization failures never trigger another provider transmission",async()=>{
  const denial=Object.assign(new Error("Owner approval required"),{code:"standalone_approval_required",terminal:true});
  const h=harness({responses:()=>{throw denial;}});
  await assert.rejects(h.run(),e=>e===denial);
  assert.equal(await h.run(),"deferred");
  assert.equal(h.calls.length,1);
  assert.equal(h.writes.length,0);
});

test("concurrent chat requests cannot claim or pay for one batch twice",async()=>{
  let release; const gate=new Promise(resolve=>{release=resolve;});
  const h=harness({responses:async()=>{await gate;return reply("Meaningful source-grounded note.");}});
  const first=h.run();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await h.run(),"deferred");
  release();
  assert.equal(await first,"committed");
  assert.equal(h.calls.length,1);
  assert.equal(h.writes.length,1);
});

test("stale cursor never replaces a concurrently changed memory",async()=>{
  const h=harness({commitResult:false});
  assert.equal(await h.run(),"deferred");
  assert.equal(h.calls.length,1);
  assert.equal(h.writes.length,0);
});

test("deleted source marker fails closed rather than reset history",async()=>{
  const prior={version:2,summary:"Original summary.",summarizedThroughMessageId:"missing",sourceMessageCount:20};
  const h=harness({prior});
  assert.equal(await h.run(),"blocked");
  assert.equal(h.calls.length,0);
  assert.deepEqual(h.memory(),prior);
});

test("a missing chat or unconfigured provider never pays or mutates state",async()=>{
  for(const config of [{missingChat:true},{configured:false}]){
    const h=harness(config);
    assert.equal(await h.run(),"skipped");
    assert.equal(h.calls.length,0);
    assert.equal(h.writes.length,0);
  }
});

test("episodic source prompt excludes unsupported biography and preserves attribution",async()=>{
  const h=harness();await h.run();
  const sys=h.calls[0].body.system;
  assert.match(sys,/Katie is the assistant/);
  assert.match(sys,/episodic ITM, not long-term memory/);
  assert.match(sys,/pending|still-open questions/);
});

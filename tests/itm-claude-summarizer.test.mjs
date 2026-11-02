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

test("the 30-message boundary does not send models after 60-89 total messages",async()=>{
  for(const total of [0,60,62,88,89]){
    const h=harness({history:messageHistory(total)});
    assert.equal(await h.run(),"skipped");
    assert.equal(h.calls.length,0, "no paid summary for "+total+" messages");
    assert.equal(h.events.filter(e=>e.name==="claim_intermediate_memory_batch").length,0);
  }
});

test("exactly 30 displaced messages invoke separate summarize and curate prompts, then one atomic commit",async()=>{
  const h=harness();
  assert.equal(await h.run(),"committed");
  assert.equal(h.calls.length,2);
  assert.equal(h.calls[0].body.max_tokens,2300);
  assert.equal(h.calls[1].body.max_tokens,10000);
  assert.equal(h.calls[0].body.messages[0].content.includes("source"),false);
  assert.match(h.calls[0].body.messages[0].content,/USER.*Historical detail from turn 0/);
  assert.match(h.calls[0].body.messages[0].content,/ASSISTANT.*Historical detail from turn 29/);
  assert.doesNotMatch(h.calls[0].body.messages[0].content,/Historical detail from turn 30\b/);
  assert.doesNotMatch(h.calls[0].body.messages[0].content,/CURRENT ITM/);
  assert.match(h.calls[1].body.messages[0].content,/NEW BATCH SUMMARY:\nNew source-grounded developments/);
  assert.equal(h.writes.length,1);
  assert.equal(h.writes[0].p_expected_cursor,null);
  assert.equal(h.memory().summarizedThroughMessageId,"m29");
  assert.equal(h.memory().sourceMessageCount,30);
  assert.equal(h.memory().summary,"Curated, reconciled continuity.");
  assert.equal(h.events.filter(e=>e.name==="finish_intermediate_memory_batch")[0].args.p_state,"completed");
});

test("reconcile prompt receives existing ITM but source-summary prompt never does",async()=>{
  const h=harness({
    history:messageHistory(120),
    prior:{version:2,summary:"Older meaningful relationship history.",summarizedThroughMessageId:"m29",sourceMessageCount:30},
  });
  await h.run();
  assert.equal(h.calls.length,2);
  assert.ok(!h.calls[0].body.messages[0].content.includes("Older meaningful relationship history."));
  assert.ok(h.calls[1].body.messages[0].content.includes("Older meaningful relationship history."));
  assert.ok(h.calls[1].body.system.includes("consequential older information can outrank"));
  assert.ok(h.calls[1].body.system.includes("explicit corrections"));
  assert.ok(h.calls[1].body.system.includes("age alone") || h.calls[1].body.system.includes("Age alone"));
  assert.equal(h.memory().summarizedThroughMessageId,"m59");
  assert.equal(h.memory().sourceMessageCount,60);
});

test("stalled 694-message history processes 30 new source messages; pending 26 remain",async()=>{
  const h=harness({history:messageHistory(694),
    prior:{version:2,summary:"Previously stored history.",summarizedThroughMessageId:"m577",sourceMessageCount:578},
  });
  assert.equal(await h.run(),"committed");
  assert.equal(h.memory().summarizedThroughMessageId,"m607");
  assert.equal(h.memory().sourceMessageCount,608);
  assert.equal(h.calls.length,2);
  assert.match(h.calls[0].body.messages[0].content,/Historical detail from turn 578/);
  assert.doesNotMatch(h.calls[0].body.messages[0].content,/Historical detail from turn 608/);
  assert.equal(await h.run(),"skipped");
  assert.equal(h.calls.length,2,"remaining 26 do not trigger another paid pair");
});

test("two consecutive 30-message batches advance only after each durable commit",async()=>{
  const h=harness({history:messageHistory(130)});
  assert.equal(await h.run(),"committed");
  assert.equal(await h.run(),"committed");
  assert.deepEqual(h.writes.map(w=>w.p_content.summarizedThroughMessageId),["m29","m59"]);
  assert.deepEqual(h.writes.map(w=>w.p_expected_cursor),[null,"m29"]);
  assert.equal(h.calls.length,4);
  assert.equal(await h.run(),"skipped");
});

test("incomplete first prompt preserves cursor and blocks repeat across requests",async()=>{
  const prior={version:2,summary:"Keep valuable history",summarizedThroughMessageId:"m1",sourceMessageCount:2};
  const h=harness({history:messageHistory(92),prior,responses:()=>reply("partial","max_tokens")});
  assert.equal(await h.run(),"blocked");
  assert.equal(h.calls.length,1);
  assert.equal(h.writes.length,0);
  assert.deepEqual(h.memory(),prior);
  assert.equal(await h.run(),"blocked");
  assert.equal(h.calls.length,1,"zero repeated provider calls on failed source range");
});

test("over-ceiling second prompt fails closed and is not retried on later turns",async()=>{
  const prior={version:2,summary:"Critical past context.",summarizedThroughMessageId:"m1",sourceMessageCount:2};
  const h=harness({history:messageHistory(92),prior,
    responses:n=>n===1?reply("One batch summary."):reply("Y".repeat(15001))});
  assert.equal(await h.run(),"blocked");
  assert.equal(h.calls.length,2);
  assert.deepEqual(h.memory(),prior);
  assert.equal(await h.run(),"blocked");
  assert.equal(h.calls.length,2);
  assert.ok(h.logs.some(e=>e.args.some(x=>String(x).includes("Batch blocked"))));
});

test("a nonterminal provider failure records a durable blocking outcome",async()=>{
  const h=harness({responses:()=>{throw Error("Network unavailable");}});
  assert.equal(await h.run(),"blocked");
  assert.equal(h.calls.length,1);
  assert.equal(h.events.find(e=>e.name==="finish_intermediate_memory_batch").args.p_state,"blocked");
  assert.equal(await h.run(),"blocked");assert.equal(h.calls.length,1);
});

test("spending/authorization denials propagate without unauthorized retries",async()=>{
  const denial=Object.assign(new Error("Owner approval required"),{code:"standalone_approval_required",terminal:true});
  const h=harness({responses:()=>{throw denial;}});
  await assert.rejects(h.run(),e=>e===denial);
  assert.equal(h.calls.length,1);
  assert.equal(h.writes.length,0);
  assert.equal(h.events.some(e=>e.name==="finish_intermediate_memory_batch"),false);
  assert.equal(await h.run(),"deferred");
  assert.equal(h.calls.length,1);
});

test("concurrent requests cannot pay twice for the same batch",async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const h=harness({responses:async n=>{if(n===1)await gate;return reply(n%2?"Stage one":"Stage two");}});
  const first=h.run();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await h.run(),"deferred");
  release();
  assert.equal(await first,"committed");
  assert.equal(h.calls.length,2);
  assert.equal(h.writes.length,1);
});

test("deleted durable source marker is blocked instead of silently resetting memory",async()=>{
  const prior={version:2,summary:"Important older context.",summarizedThroughMessageId:"gone",sourceMessageCount:50};
  const h=harness({prior});
  assert.equal(await h.run(),"blocked");
  assert.equal(h.calls.length,0);
  assert.deepEqual(h.memory(),prior);
});

test("missing provider and deleted chat never call or mutate ITM",async()=>{
  for(const options of [{configured:false},{missingChat:true}]){
    const h=harness(options);
    assert.equal(await h.run(),"skipped");
    assert.equal(h.calls.length,0);
    assert.equal(h.writes.length,0);
  }
});

test("output budgets, model, accounting and source preservation are explicit",async()=>{
  const h=harness();await h.run();
  assert.equal(h.constructors[0].maxRetries,0);
  assert.equal(h.constructors[0].baseURL,"https://api.anthropic.com/v1");
  assert.equal(h.events.filter(e=>e.name==="accounting")[0].activity,"memory-summary");
  assert.equal(h.calls.every(c=>c.path==="/messages"),true);
  assert.equal(h.calls.every(c=>c.body.model==="claude-sonnet-5-5"),true);
  assert.ok(h.calls[0].body.system.includes("Message timestamps date the telling"));
  assert.ok(h.calls[1].body.system.includes("Preserve uncertainty"));
  assert.ok(h.calls[1].body.system.includes("original conversation remains durably stored"));
});

test("a stale checkpoint claim and a concurrent moved checkpoint never write over stored history",async()=>{
  const h=harness({commitResult:false});
  assert.equal(await h.run(),"deferred");
  assert.equal(h.calls.length,2);
  assert.equal(h.writes.length,0);
});


test("v2 explicitly reauthorizes a v1 blocked batch once, without resetting the cursor or deleting v1 evidence",async()=>{
  const prior={version:2,summary:"P".repeat(14774),summarizedThroughMessageId:"m1",sourceMessageCount:2};
  const h=harness({history:messageHistory(92),prior,
    responses:n=>reply(n===1?"Only the 30 new source messages.":"A concise fully reconciled ITM.")});
  // Simulates the production v1 circuit breaker preserved in Postgres.
  const batchEnd="m31";
  h.claims.set("two-stage-30-messages-v1:"+batchEnd,"blocked");
  assert.equal(await h.run(),"committed");
  assert.equal(h.calls.length,2,"one two-stage paid attempt under the corrected processor");
  assert.equal(h.calls[1].body.max_tokens,10000);
  const claim=h.events.find(e=>e.name==="claim_intermediate_memory_batch");
  assert.equal(claim.args.p_processor_version,"two-stage-30-messages-v2-reconcile-10000");
  assert.equal(h.claims.get("two-stage-30-messages-v1:"+batchEnd),"blocked",
    "old failure evidence must remain untouched");
  assert.equal(h.memory().summarizedThroughMessageId,batchEnd);
  assert.equal(h.memory().summary,"A concise fully reconciled ITM.");
  assert.equal(await h.run(),"skipped");
  assert.equal(h.calls.length,2,"do not repeat the successful batch");
});

test("10,000 reconciliation tokens support a near-ceiling prior ITM with a concise complete result",async()=>{
  const prior={version:2,summary:"Important prior context. ".repeat(670).slice(0,14774),
    summarizedThroughMessageId:"m1",sourceMessageCount:2};
  const concise="Curated continuity. ".repeat(340).slice(0,6500).trim();
  const h=harness({history:messageHistory(92),prior,
    responses:n=>reply(n===1?"New batch corrections and decisions.":concise)});
  assert.equal(await h.run(),"committed");
  assert.equal(h.calls[1].body.max_tokens,10000);
  assert.ok(h.calls[1].body.messages[0].content.includes(prior.summary));
  assert.equal(h.memory().summary,concise);
  assert.ok(h.memory().summary.length<=15000,"hard character ceiling must still be enforced");
  assert.equal(h.memory().summarizedThroughMessageId,"m31");
});

test("even with 10,000 output tokens an incomplete reconciliation fails closed and is not retried",async()=>{
  const prior={version:2,summary:"Keep all existing context.",summarizedThroughMessageId:"m1",sourceMessageCount:2};
  const h=harness({history:messageHistory(92),prior,
    responses:n=>n===1?reply("Relevant new changes."):reply("Partial output","max_tokens")});
  assert.equal(await h.run(),"blocked");
  assert.equal(h.calls.length,2);
  assert.equal(h.calls[1].body.max_tokens,10000);
  assert.equal(h.writes.length,0);
  assert.deepEqual(h.memory(),prior);
  assert.equal(await h.run(),"blocked");
  assert.equal(h.calls.length,2,"no identical paid retries after the failure");
});

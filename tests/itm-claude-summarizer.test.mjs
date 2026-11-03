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
  responses = (n) => reply(n % 2 ? "New source-grounded developments." : JSON.stringify({keep:[],revise:[],add:["Recognizable new discussion and unresolved question."]})),
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



test("processing threshold remains thirty older conversational messages", async()=>{
  for(const count of [0,60,89]){
    const h=harness({history:messageHistory(count)});
    assert.equal(await h.run(),"skipped"); assert.equal(h.calls.length,0);
  }
});

test("semantic model reconciles old ITM with new batch before atomic commit",async()=>{
  const prior={version:2,summary:"Rolling recent conversations\n\nExisting conversation: unresolved plan.",summarizedThroughMessageId:"m1",sourceMessageCount:2};
  const h=harness({history:messageHistory(92),prior,responses:n=>reply(n===1?
    "User clarified prior project scope and resolved the earlier plan.":
    JSON.stringify({keep:[],revise:[{indexes:[0],text:"Project plan resolved after user's correction."}],add:["New implementation is still being validated."]}))});
  assert.equal(await h.run(),"committed");
  assert.equal(h.calls.length,2);
  assert.equal(h.calls[0].body.max_tokens,2300);
  assert.equal(h.calls[1].body.max_tokens,2800);
  assert.match(h.calls[1].body.messages[0].content,/Existing conversation: unresolved plan/);
  assert.match(h.calls[1].body.messages[0].content,/resolved the earlier plan/);
  assert.match(h.memory().summary,/Project plan resolved/);
  assert.doesNotMatch(h.memory().summary,/unresolved plan/);
  assert.match(h.memory().summary,/New implementation is still being validated/);
  assert.equal(h.memory().summarizedThroughMessageId,"m31");
  assert.equal(h.memory().sourceMessageCount,32);
  assert.equal(h.events.find(e=>e.name==="finish_intermediate_memory_batch").args.p_state,"completed");
});

test("semantic reconciliation can keep a still-relevant older conversation",async()=>{
  const prior={version:2,summary:"Rolling recent conversations\n\nOld but unresolved conversation.",summarizedThroughMessageId:"m1",sourceMessageCount:2};
  const h=harness({history:messageHistory(92),prior,responses:n=>reply(n===1?
    "New unrelated conversation.":
    JSON.stringify({keep:[0],revise:[],add:["New unrelated conversation."]}))});
  assert.equal(await h.run(),"committed");
  assert.match(h.memory().summary,/Old but unresolved conversation/);
  assert.match(h.memory().summary,/New unrelated conversation/);
});

test("semantic reconciliation drops irrelevant legacy episodes but retains relevant older work",async()=>{
  const prior={version:2,
    summary:"Opening biographical preamble.\n\n**Older trivia**\n- Dated insignificant update.\n\n**Unresolved accounting**\n- Waiting for a reconciliation.",
    summarizedThroughMessageId:"m1",sourceMessageCount:2};
  const h=harness({history:messageHistory(92),prior,responses:n=>reply(n===1?
    "Related accounting item was clarified.":
    JSON.stringify({keep:[],revise:[{indexes:[1],text:"Unresolved accounting: clarification received; final reconciliation remains open."}],add:[]}))});
  assert.equal(await h.run(),"committed");
  assert.match(h.memory().summary,/final reconciliation remains open/);
  assert.doesNotMatch(h.memory().summary,/Older trivia|Opening biographical preamble/);
});

test("multiple related prior episodes can be merged by the model into one",async()=>{
  const prior={version:2,summary:"Rolling recent conversations\n\nFirst aspect of integration.\n\n---\n\nSecond aspect of integration.",summarizedThroughMessageId:"m1",sourceMessageCount:2};
  const h=harness({history:messageHistory(92),prior,responses:n=>reply(n===1?
    "Both integration issues resolved.":
    JSON.stringify({keep:[],revise:[{indexes:[0,1],text:"Both integration issues resolved together."}],add:[]}))});
  assert.equal(await h.run(),"committed");
  assert.match(h.memory().summary,/resolved together/);
  assert.doesNotMatch(h.memory().summary,/First aspect|Second aspect/);
});

test("a large legacy ITM generates small model edits rather than full rewritten response",async()=>{
  const prior={version:2,summary:"Biographical preamble. ".repeat(30)+"\n\n**Open thread**\n- Unresolved work.\n\n**Old thread**\n- ".repeat(200),
    summarizedThroughMessageId:"m1",sourceMessageCount:2};
  const h=harness({history:messageHistory(92),prior,responses:n=>reply(n===1?
    "New ITM processing decision.":
    JSON.stringify({keep:[],revise:[],add:["ITM processing decision: retain semantic reconciliation."]}))});
  assert.equal(await h.run(),"committed");
  assert.equal(h.calls.length,2);
  assert.ok(h.calls[1].body.messages[0].content.includes("EXISTING ITM EPISODES"));
  assert.ok(h.memory().summary.length<=6500);
  assert.match(h.memory().summary,/retain semantic reconciliation/);
});

test("source update batches continue to advance independently and stay bounded",async()=>{
  const h=harness({history:messageHistory(130),responses:(n)=>reply(n%2?
    "Batch summary.":
    JSON.stringify({keep:n===4?[0]:[],revise:[],add:["Episode from batch "+(n/2)]}))});
  assert.equal(await h.run(),"committed");
  assert.equal(await h.run(),"committed");
  assert.equal(h.calls.length,4);
  assert.deepEqual(h.writes.map(w=>w.p_content.summarizedThroughMessageId),["m29","m59"]);
  assert.ok(h.memory().summary.length<=6500);
  assert.match(h.memory().summary,/Episode from batch 2/);
  assert.match(h.memory().summary,/Episode from batch 1/);
});

test("invalid semantic edit plan cannot overwrite memory or advance cursor",async()=>{
  const prior={version:2,summary:"Preserve this.",summarizedThroughMessageId:"m1",sourceMessageCount:2};
  for(const invalid of ["not JSON",JSON.stringify({keep:[0],revise:[{indexes:[0],text:"bad"}],add:[]}),JSON.stringify({keep:[100],revise:[],add:[]})]){
    const h=harness({history:messageHistory(92),prior,responses:n=>reply(n===1?"New source batch.":invalid)});
    assert.equal(await h.run(),"blocked");
    assert.equal(h.writes.length,0);
    assert.deepEqual(h.memory(),prior);
    assert.equal(await h.run(),"blocked");
    assert.equal(h.calls.length,2);
  }
});

test("incomplete semantic response fails closed without recharging",async()=>{
  const prior={version:2,summary:"Prior record.",summarizedThroughMessageId:"m1",sourceMessageCount:2};
  const h=harness({history:messageHistory(92),prior,responses:n=>n===1?reply("New episode."):reply("partial","max_tokens")});
  assert.equal(await h.run(),"blocked");assert.equal(h.calls.length,2);
  assert.equal(h.writes.length,0);assert.deepEqual(h.memory(),prior);
  assert.equal(await h.run(),"blocked");assert.equal(h.calls.length,2);
});

test("uncertain source provider outcome never silently retries",async()=>{
  const h=harness({responses:()=>{throw Error("Previous provider outcome unavailable");}});
  assert.equal(await h.run(),"blocked");
  assert.equal(await h.run(),"blocked");
  assert.equal(h.calls.length,1);
  assert.equal(h.writes.length,0);
});

test("accounting authorization failures preserve claim and do not retry",async()=>{
  const denial=Object.assign(new Error("Owner approval required"),{code:"standalone_approval_required",terminal:true});
  const h=harness({responses:()=>{throw denial;}});
  await assert.rejects(h.run(),e=>e===denial);
  assert.equal(await h.run(),"deferred");
  assert.equal(h.calls.length,1);
  assert.equal(h.writes.length,0);
});

test("concurrency and same-batch accounting guard still prevent double spending",async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve});
  const h=harness({responses:async n=>{if(n===1)await gate;return reply(n===1?
    "New episode.":JSON.stringify({keep:[],revise:[],add:["Result."]}));}});
  const first=h.run();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await h.run(),"deferred");
  release();
  assert.equal(await first,"committed");
  assert.equal(h.calls.length,2);
  assert.equal(h.writes.length,1);
  assert.equal(h.constructors[0].maxRetries,0);
});

test("a concurrent checkpoint update cannot be overwritten",async()=>{
  const h=harness({commitResult:false});
  assert.equal(await h.run(),"deferred");
  assert.equal(h.writes.length,0);
});

test("missing source marker fails closed rather than losing memory",async()=>{
  const prior={version:2,summary:"Preserve this.",summarizedThroughMessageId:"missing",sourceMessageCount:20};
  const h=harness({prior});
  assert.equal(await h.run(),"blocked");
  assert.equal(h.calls.length,0);
  assert.deepEqual(h.memory(),prior);
});

test("source-grounded summarization and semantic editing keep their separate purposes",async()=>{
  const h=harness();await h.run();
  assert.match(h.calls[0].body.system,/Katie is the assistant/);
  assert.match(h.calls[1].body.system,/Compare new conversation developments/);
  assert.match(h.calls[1].body.system,/MERGE related topics/);
  assert.match(h.calls[1].body.system,/DROP obsolete/);
  assert.match(h.calls[1].body.system,/rolling record of conversations/);
  assert.equal(h.events.filter(x=>x.name==="accounting")[0].activity,"memory-summary");
});

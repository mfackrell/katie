import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import ts from "typescript";

const compiled=ts.transpileModule(readFileSync("lib/memory/assemble-context.ts","utf8"),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
const msg=(id,role,time,content="Original source evidence")=>({
  id,chatId:"chat",role,content,createdAt:new Date(time).toISOString(),
});
const stm=Array.from({length:60},(_,i)=>msg("s"+i,i%2?"assistant":"user",Date.UTC(2026,10,2,10,i)));
const pending=Array.from({length:56},(_,i)=>msg("p"+i,i%2?"assistant":"user",Date.UTC(2026,10,1,10,i),"Unfolded source "+i));

function run({latestCursor="2026-10-31T17:00:00.000Z",pendingMessages=pending,truncated=false}={}){
  let reads=0;const module={exports:{}};
  const deps={
    "@/lib/chat/message-reactions":{recentActorReactionEvents:async()=>"",recentReactionContext:async()=>""},
    "@/lib/agents/task-handoff-knowledge":{loadTaskHandoffKnowledgeContext:async()=>""},
    "@/lib/agents/policy":{currentAgentTask:()=>null},
    "@/lib/chat/deliverable-standard":{getDeliverableStandardInstruction:()=>""},
    "@/lib/chat/adaptive-response-composition":{getAdaptiveResponseCompositionInstruction:()=>""},
    "@/lib/data/persistence-store":{
      getChatContextState:async()=>({
        actor:{purpose:"Friendly",reviewMode:"off"},
        recentMessages:stm,shortTermMemory:{version:2},intermediateMemory:{
          summary:"Older curated context.",summarizedThroughCreatedAt:latestCursor,
        },longTermMemory:{entries:[]}
      }),
      listActorMemoryDocuments:async()=>[],
      getPendingIntermediateContext:async(actorChatId,cutoff,start,limit)=>{
        reads++;assert.equal(actorChatId,"chat");assert.equal(cutoff,latestCursor);
        assert.equal(start,stm[0].createdAt);assert.equal(limit,120);
        return {messages:pendingMessages,truncated};
      },
    },
    "@/lib/memory/memory-contract":{MEMORY_ARCHITECTURE_GUIDE:"",SHORT_TERM_MESSAGE_LIMIT:60},
    "@/lib/memory/short-term":{
      messagesFromShortTermMemory:()=>stm,
      filterConversationalMessages:m=>m,
    },
    "@/lib/router/actor-routing-profile":{createNeutralActorRoutingProfile:()=>({})},
  };
  runInNewContext(compiled,{
    module,exports:module.exports,process:{env:{}},
    console:{info(){},warn(){},error(){}},
    require:name=>{assert.ok(name in deps,"Unexpected module "+name);return deps[name];},
  });
  return module.exports.assembleContext("actor","chat").then(value=>({value,reads}));
}

test("the prior 56-message ITM coverage gap remains accessible before checkpoint advances",async()=>{
  const {value,reads}=await run();
  assert.equal(reads,1);
  assert.equal(value.history.length,116);
  assert.equal(value.history[0].id,"p0");
  assert.equal(value.history[55].id,"p55");
  assert.equal(value.history[56].id,"s0");
  assert.equal(value.history.at(-1).id,"s59");
  assert.equal(value.summary,"Older curated context.");
});

test("an up-to-date ITM checkpoint bypasses pending reads and retains exactly 30 STM exchanges",async()=>{
  const {value,reads}=await run({latestCursor:stm[0].createdAt});
  assert.equal(reads,0);
  assert.equal(value.history.length,60);
  assert.equal(value.history[0].id,"s0");
});

test("an oversized pending buffer reports degraded coverage rather than silently claiming completeness",async()=>{
  const {value,reads}=await run({truncated:true,pendingMessages:pending.slice(-30)});
  assert.equal(reads,1);
  assert.equal(value.history.length,90);
  assert.match(value.summary,/INTERMEDIATE MEMORY COVERAGE DEGRADED/);
});


test("overlapping pending and STM rows cannot duplicate persisted message IDs",async()=>{
  // Reproduce the production bug: the pending fetch includes all sixty
  // messages already in STM as well as the fifty-six genuinely older ones.
  const staleOverlappingSTM=stm.map(message=>({
    ...message,content:"STALE-RECOVERED-COPY-"+message.id,
  }));
  const {value,reads}=await run({pendingMessages:[...pending,...staleOverlappingSTM]});
  assert.equal(reads,1);
  assert.equal(value.history.length,116,"56 pending + 60 STM, not 176");
  assert.equal(new Set(value.history.map(message=>message.id)).size,116);
  assert.deepEqual(value.history.slice(0,56).map(m=>m.id),pending.map(m=>m.id));
  assert.deepEqual(value.history.slice(56).map(m=>m.id),stm.map(m=>m.id));
  for(let i=0;i<60;i++) {
    assert.equal(value.history[i+56].content,stm[i].content,
      "The authoritative STM instance must replace the older retrieved copy");
  }
});

test("same text with different persisted IDs remains two legitimate conversation turns",async()=>{
  const legitimate=stm.slice(0,2).map(m=>({...m,content:"Identical real messages"}));
  const {value}=await run({pendingMessages:[...pending,...legitimate]});
  assert.equal(value.history.length,116);
  assert.equal(new Set(value.history.map(m=>m.id)).size,116);
  // The two distinct IDs are retained, even though the text matches exactly.
  assert.deepEqual(value.history.slice(56,58).map(m=>m.id),stm.slice(0,2).map(m=>m.id));
});

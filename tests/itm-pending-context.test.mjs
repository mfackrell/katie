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

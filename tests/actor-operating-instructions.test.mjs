import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function transpile(path, mocks={}) {
  const compiled=ts.transpileModule(readFileSync(path,"utf8"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
  }).outputText;
  const holder={exports:{}};
  runInNewContext(compiled,{
    module:holder,exports:holder.exports,process:{env:{}},
    console:{info(){},warn(){},error(){}},
    require(name){assert.ok(name in mocks,"Unexpected import "+name);return mocks[name];}
  });
  return holder.exports;
}
const deliverable=transpile("lib/chat/deliverable-standard.ts");
const adaptive=transpile("lib/chat/adaptive-response-composition.ts");
const guide="VERBATIM_MEMORY_HIERARCHY_WITH_CORRECTION_PRECEDENCE";
const objectiveLines=deliverable.getObjectiveFirstInstruction().split("\n");
const moduleLine=(prefix)=>{const found=objectiveLines.filter(line=>line.startsWith(prefix));assert.equal(found.length,1);return found[0];};
const modules={
  stance:moduleLine("Choose the reasoning stance appropriate to the task:"),
  application:moduleLine("APPLICATION COMPLETION:"),
  evidence:moduleLine("EVIDENCE-BASED CAPABILITY REASONING:"),
  communication:moduleLine("Communicate the selected evidence"),
  technical:"TECHNICAL WORK prioritizes diagnosis, causal evidence, reproducible verification and honest implementation status.",
};
assert.ok(modules.stance.includes(modules.technical));

function assembleWith(actor, task=null) {
  const counts={context:0,documents:0,reactions:0,events:0,pending:0,providers:0};
  const source=[{id:"s1",role:"user",chatId:"chat",content:"CONTINUITY_VERBATIM",createdAt:"2026-11-17T12:00:00Z"}];
  const mocks={
    "@/lib/chat/message-reactions":{
      recentReactionContext:async()=>{counts.reactions++;return "";},
      recentActorReactionEvents:async()=>{counts.events++;return "";}
    },
    "@/lib/agents/task-handoff-knowledge":{loadTaskHandoffKnowledgeContext:async()=>""},
    "@/lib/agents/policy":{currentAgentTask:()=>task},
    "@/lib/chat/deliverable-standard":deliverable,
    "@/lib/chat/adaptive-response-composition":adaptive,
    "@/lib/data/persistence-store":{
      getChatContextState:async()=>{counts.context++;return {
        actor,recentMessages:source,shortTermMemory:{},intermediateMemory:{summary:"ITM_STABLE"},
        longTermMemory:{entries:[{key:"correction.corrected",value:"AUTHORITATIVE_VALUE",source:"user-stated",category:"constraint",confidence:"high"}]}
      };},
      listActorMemoryDocuments:async()=>{counts.documents++;return []},
      getPendingIntermediateContext:async()=>{counts.pending++;return {messages:[],truncated:false}}
    },
    "@/lib/memory/memory-contract":{MEMORY_ARCHITECTURE_GUIDE:guide,SHORT_TERM_MESSAGE_LIMIT:60},
    "@/lib/memory/short-term":{
      messagesFromShortTermMemory:()=>source,
      filterConversationalMessages:rows=>rows
    },
    "@/lib/memory/history-dedup":{uniqueMessagesById:rows=>rows},
    "@/lib/router/actor-routing-profile":{createNeutralActorRoutingProfile:()=>({})},
  };
  const code=transpile("lib/memory/assemble-context.ts",mocks);
  return code.assembleContext("actor","chat").then(result=>({result,counts}));
}
const baseActor={name:"Katie",purpose:"ACTOR_PERSONALITY_UNCHANGED",reviewMode:"adaptive"};
const btgModules=[
{id:"task-stance",title:"Stance",content:modules.stance},
{id:"application-completion",title:"Application",content:modules.application},
{id:"professional-evidence",title:"Professional",content:modules.evidence},
{id:"professional-communication",title:"Communication",content:modules.communication},
];

test("regular Katie receives universal foundation, complete memory, no application or technical module", async()=>{
  const {result,counts}=await assembleWith({...baseActor,operatingInstructionMode:"modular",operatingInstructionModules:[]});
  assert.ok(result.cacheablePersona.includes(baseActor.purpose));
  assert.ok(result.persona.includes("KATIE_MEMORY_ARCHITECTURE")===false || result.persona.includes(guide));
  assert.ok(result.persona.includes(guide));
  assert.ok(result.persona.includes("KATIE_ADAPTIVE_RESPONSE_COMPOSITION"));
  assert.ok(!result.cacheablePersona.includes("APPLICATION COMPLETION:"));
  assert.ok(!result.cacheablePersona.includes("TECHNICAL WORK prioritizes"));
  assert.ok(!result.cacheablePersona.includes("EVIDENCE-BASED CAPABILITY REASONING:"));
  assert.ok(result.persona.includes("CORRECTION correction.corrected: AUTHORITATIVE_VALUE"));
  assert.ok(result.persona.indexOf("AUTHORITATIVE ACTOR MEMORY CORRECTIONS") < result.persona.indexOf("LONG_TERM_MEMORY:"));
  assert.equal(result.summary,"ITM_STABLE");
  assert.equal(result.history[0].content,"CONTINUITY_VERBATIM");
  assert.deepEqual(counts,{context:1,documents:1,reactions:1,events:1,pending:0,providers:0});
});

test("BTG retains existing purpose and four distinct verbatim specialist modules",async()=>{
  const {result}=await assembleWith({...baseActor,name:"BTG Application Specialits",
    purpose:"BTG_ORIGINAL_PURPOSE_VERBATIM", operatingInstructionMode:"modular",operatingInstructionModules:btgModules});
  for(const module of btgModules)assert.ok(result.cacheablePersona.includes(module.content),module.id);
  assert.ok(result.cacheablePersona.includes("BTG_ORIGINAL_PURPOSE_VERBATIM"));
  assert.ok(result.cacheablePersona.indexOf("BTG_ORIGINAL_PURPOSE_VERBATIM") <
    result.cacheablePersona.indexOf(modules.application));
  assert.equal(result.cacheablePersona.split(modules.application).length,2,"No duplicate application module");
});

test("Builder includes the exact technical stance, not unrelated application instructions",async()=>{
  const {result}=await assembleWith({...baseActor,purpose:"BUILDER_EXISTING_CHARTER",
    operatingInstructionMode:"modular",operatingInstructionModules:[
      {id:"technical-stance",title:"Technical",content:modules.technical}
    ]});
  assert.ok(result.cacheablePersona.includes("BUILDER_EXISTING_CHARTER"));
  assert.ok(result.cacheablePersona.includes(modules.technical));
  assert.ok(!result.cacheablePersona.includes(modules.application));
});

test("multiple assigned modules are ordered, reusable and cannot affect an unrelated actor",async()=>{
  const shared={id:"professional-evidence",title:"Professional",content:modules.evidence};
  const first=(await assembleWith({...baseActor,purpose:"ACTOR_A",operatingInstructionMode:"modular",operatingInstructionModules:[shared,btgModules[1]]})).result;
  const second=(await assembleWith({...baseActor,purpose:"ACTOR_B",operatingInstructionMode:"modular",operatingInstructionModules:[shared]})).result;
  assert.ok(first.cacheablePersona.includes(shared.content));
  assert.ok(second.cacheablePersona.includes(shared.content));
  assert.ok(!second.cacheablePersona.includes(btgModules[1].content));
  assert.ok(!second.cacheablePersona.includes("ACTOR_A"));
  assert.ok(first.cacheablePersona.indexOf(shared.content)<first.cacheablePersona.indexOf(btgModules[1].content));
});

test("unassigned legacy actors receive the exact unchanged global instruction sequence",async()=>{
  const {result}=await assembleWith(baseActor);
  const expected=[baseActor.purpose,deliverable.getDeliverableStandardInstruction(),
    adaptive.getAdaptiveResponseCompositionInstruction(),guide].join("\n\n");
  assert.equal(result.cacheablePersona,expected);
});

test("managed-task snapshot instructions retain precedence and review mode",async()=>{
  const task={snapshot:{instructions:"AUTHORIZED_TASK_SNAPSHOT",reviewMode:"always"}};
  const {result}=await assembleWith({...baseActor,
    operatingInstructionMode:"modular",operatingInstructionModules:btgModules},task);
  assert.ok(result.cacheablePersona.includes("AUTHORIZED_TASK_SNAPSHOT"));
  assert.ok(!result.cacheablePersona.includes("ACTOR_PERSONALITY_UNCHANGED"),
    "The pre-existing task snapshot must still supersede the live actor prompt");
  assert.ok(result.cacheablePersona.indexOf(modules.application) <
    result.cacheablePersona.indexOf("AUTHORIZED_TASK_SNAPSHOT"));
  assert.equal(result.reviewMode,"always");
});

test("universal wording is unchanged; specialist material is only redistributed",()=>{
  const full=deliverable.getDeliverableStandardInstruction();
  const universal=deliverable.getUniversalDeliverableInstruction();
  for(const line of universal.split("\n"))assert.ok(full.includes(line));
  for(const key of ["COMPARATIVE JUDGMENT — OUTCOME:","CONVERSATION PROGRESSION:",
      "Deliver the actual requested output"])assert.ok(universal.includes(key));
  for(const body of [modules.stance,modules.application,modules.evidence,modules.communication]) {
    assert.ok(full.includes(body));
    assert.ok(!universal.includes(body));
  }
  const schema=readFileSync("supabase/migrations/20261118002500_actor_operating_instruction_modules.sql","utf8");
  for(const body of [modules.stance,modules.application,modules.evidence,modules.communication,modules.technical]) {
    assert.ok(schema.includes(body),"Migration preserves the original text verbatim");
  }
  assert.ok(schema.includes("operating_instruction_mode text not null default 'legacy'"));
  assert.ok(schema.includes("security invoker"));
  assert.match(schema,/revoke all on function public\.set_actor_operating_instruction_modules/);
});

test("scoped actor configuration requires owner checks and an atomic service-role-only RPC",()=>{
  const route=readFileSync("app/api/actors/route.ts","utf8");
  const store=readFileSync("lib/data/persistence-store.ts","utf8");
  assert.ok(route.includes('standalone_guest_workspace'));
  assert.ok(route.includes('standalone_guest_actor_ids'));
  assert.ok(route.includes('if (await managedActor(actorId))'));
  assert.ok(route.includes('executiveIdentity?.actorKind === "executive"'));
  assert.ok(route.includes('set_actor_operating_instruction_modules'));
  assert.ok(store.includes('actor_operating_instruction_assignments(module_id,position,operating_instruction_modules(id,title,content))'));
  // getChatContextState's existing call graph is unchanged: it still makes
  // one getActorById call in its original Promise.all, with no module read.
  const start=store.indexOf("export async function getChatContextState");
  assert.match(store.slice(start),/getActorById\(actorId\)/);
  assert.ok(!store.slice(start).includes('from("operating_instruction_modules")'));
});

test("fixture operating-instruction characters are measured independently of memory", async()=>{
  for(const [label,actor] of [
    ["Katie",{...baseActor,operatingInstructionMode:"modular",operatingInstructionModules:[]}],
    ["BTG",{...baseActor,operatingInstructionMode:"modular",operatingInstructionModules:btgModules}],
    ["Builder",{...baseActor,operatingInstructionMode:"modular",operatingInstructionModules:[{id:"technical-stance",title:"Technical",content:modules.technical}]}],
  ]) {
    const {result}=await assembleWith(actor);
    const legacy=(await assembleWith({...actor,operatingInstructionMode:"legacy"})).result;
    assert.equal(result.cacheablePersona.includes(actor.purpose),true);
    assert.ok(result.cacheablePersona.length>0);
    console.log("Measured operating prompt",JSON.stringify({
      actor:label,before:legacy.cacheablePersona.length,after:result.cacheablePersona.length,
      universal:deliverable.getUniversalDeliverableInstruction().length+
        adaptive.getAdaptiveResponseCompositionInstruction().length+guide.length,
      specialist:actor.operatingInstructionModules.map(m=>m.content.length).reduce((a,b)=>a+b,0)
    }));
  }
});

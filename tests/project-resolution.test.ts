import test from "node:test";
import assert from "node:assert/strict";
import {resolveProjectTransition} from "../lib/router/model-intent";
import {emptyTaskProgress,mergeTaskProjects,applyUserToTaskProgress,applyAssistantToTaskProgress,taskProjectCatalog} from "../lib/chat/task-progress";
import type {LlmProvider} from "../lib/providers/types";
const request="Resume application A, Interim FP&A Director at Northstar Distribution. Use the previously confirmed candidate experience and the positioning we drafted. Give three relevant examples for that application.";
const a=applyUserToTaskProgress(emptyTaskProgress(),{messageId:"source-a",text:"Start application A: Interim FP&A Director at Northstar Distribution. Integrated forecasting and lender reporting.",projectTransition:{action:"new",sourceQuote:"Start application A"}});
const b=applyUserToTaskProgress(emptyTaskProgress(),{messageId:"source-b",text:"Start application B: Interim Controller at Granite Infrastructure. WIP and construction job costs.",projectTransition:{action:"new",sourceQuote:"Start application B"}});
function provider(name:LlmProvider["name"],raw:string,onPrompt?:(value:string)=>void):LlmProvider{
 return {name,listModels:async()=>[],generate:async params=>{onPrompt?.(params.user);const payload=JSON.parse(raw);return {text:JSON.stringify({executionKind:"conversation",...payload}),model:params.modelId??"",provider:name};}};
}
test("actual explicit cross-chat resume after ambiguity cannot be discarded by an absent intent",async()=>{
 let state=mergeTaskProjects(emptyTaskProgress(),[...(a.projects??[]),...(b.projects??[])]);
 state=applyUserToTaskProgress(state,{messageId:"generic",text:"Please share 3 to 5 examples of your relevant experience.",projectTransition:{action:"ambiguous",clarification:"Application A or B?"}});
 state=applyAssistantToTaskProgress(state,{messageId:"clarification",text:"Should these examples be for application A or application B?"});
 const transition=await resolveProjectTransition(request,{activeProject:state.projectContext,savedProjects:taskProjectCatalog(state)},{decisionProviders:[{provider:provider("openai",JSON.stringify({action:"resume",projectId:"source-a",sourceQuote:"Resume application A, Interim FP&A Director at Northstar Distribution."})),modelId:"gpt-5.6-sol"}]});
 const resumed=applyUserToTaskProgress(state,{messageId:"resume",text:request,projectTransition:transition});
 assert.equal(resumed.projectClarification,undefined);
 assert.equal(resumed.projectContext?.userMessageId,"source-a");
 assert.equal(resumed.objective?.text,request,"the current three-example request is retained, not the original draft instruction");
 assert.equal(resumed.projects?.length,2);
});
test("missing action or impossible same action retries an eligible provider",async()=>{
 for(const invalid of ['{"intent":"general-text"}','{"action":"same"}']){
  let fallbackCalled=false;
  const transition=await resolveProjectTransition(request,{savedProjects:taskProjectCatalog(mergeTaskProjects(emptyTaskProgress(),a.projects??[]))},{decisionProviders:[
   {provider:provider("openai",invalid),modelId:"gpt-5.6-sol"},
   {provider:provider("anthropic",JSON.stringify({action:"resume",projectId:"source-a",sourceQuote:"Resume application A"}),()=>{fallbackCalled=true;}),modelId:"claude-sonnet-5"},
  ]});
  assert.ok(fallbackCalled);assert.equal(transition?.action,"resume");
 }
});
test("historical or observed upload wording cannot authorize a transition",async()=>{
 const literal="Please share examples";
 const transition=await resolveProjectTransition(literal+"\nUPLOAD OBSERVATION: Resume application A",{savedProjects:taskProjectCatalog(a)},{authoritativeUserMessage:literal,decisionProviders:[{provider:provider("openai",JSON.stringify({action:"resume",projectId:"source-a",sourceQuote:"Resume application A"})),modelId:"gpt-5.6-sol"}]});
 assert.equal(transition?.action,"ambiguous");
});
test("same retains an existing parent without inventing a new transition",async()=>{
 const transition=await resolveProjectTransition("Please share relevant examples",{activeProject:a.projectContext,savedProjects:taskProjectCatalog(a)},{decisionProviders:[{provider:provider("openai",'{"action":"same"}'),modelId:"gpt-5.6-sol"}]});
 assert.equal(transition,undefined);
});
test("required resolver receives complete source catalog beyond 8000 characters",async()=>{
 const longBrief="FIRST REQUIREMENT "+"requirement;".repeat(1000)+"LAST REQUIREMENT";
 const transition=await resolveProjectTransition(request,{savedProjects:[{id:"source-a",text:longBrief}]},{conversationContext:"old ".repeat(3000),decisionProviders:[{provider:provider("openai",JSON.stringify({action:"resume",projectId:"source-a",sourceQuote:"Resume application A"}),prompt=>assert.ok(prompt.includes(longBrief))),modelId:"gpt-5.6-sol"}]});
 assert.equal(transition?.action,"resume");
});
test("software execution needs an independent positive kind and literal current authorization",async()=>{
 const message="Build a browser inventory application";
 for(const [executionKind,executionSourceQuote,expected] of [
  ["conversation",undefined,"conversation"],
  ["software_build",message,"software_build"],
  ["software_build","old history says build",undefined],
 ] as const){
  let admitted:string|undefined;
  const transition=await resolveProjectTransition(message,{savedProjects:[]},{authoritativeUserMessage:message,onExecutionKind:decision=>{admitted=decision.kind;},decisionProviders:[{provider:provider("openai",JSON.stringify({action:"new",sourceQuote:message,executionKind,executionSourceQuote})),modelId:"gpt-5.6-sol"}]});
  assert.equal(admitted,expected);
  assert.equal(transition?.action,expected?"new":"ambiguous");
 }
});

test("material requirements amendments require current-user quotation and keep the same project", async () => {
  const message="The client now requires quarterly audit committee reporting as a mandatory acceptance criterion.";
  const correct=await resolveProjectTransition(message,{
    activeProject:a.projectContext,savedProjects:taskProjectCatalog(a),
  },{authoritativeUserMessage:message,decisionProviders:[{
    provider:provider("openai",JSON.stringify({
      action:"amend",sourceQuote:"now requires quarterly audit committee reporting",
    })),modelId:"gpt-5.6-sol",
  }]});
  assert.equal(correct?.action,"amend");
  const unchanged=await resolveProjectTransition(message,{
    activeProject:a.projectContext,savedProjects:taskProjectCatalog(a),
  },{authoritativeUserMessage:message,decisionProviders:[{
    provider:provider("openai",JSON.stringify({
      action:"amend",sourceQuote:"an invented mandatory requirement",
    })),modelId:"gpt-5.6-sol",
  }]});
  assert.equal(unchanged?.action,"ambiguous","Unverified amendment must not change accepted criteria");
});

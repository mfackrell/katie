import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const src = fs.readFileSync("lib/router/model-intent.ts", "utf8");
test("every regular routing selection launches three independent judges concurrently", () => {
 const section=src.slice(src.indexOf("export async function chooseRoutingWithLLM("),src.indexOf("/** Reviewed prices",src.indexOf("export async function chooseRoutingWithLLM(")));
 assert.match(section,/Promise\.allSettled\(judges\.map\(/);
 assert.match(section,/activityOverride: `routing-rerank_judge_\$\{lane\}`/);
 assert.match(section,/singleAttempt: true/);
 assert.match(section,/parse: parseRoutingJudgeResponse/);
 assert.match(section,/if \(judges\.length === 3\) break/);
 assert.doesNotMatch(section,/Promise\.race\(/);
 assert.match(section,/isStandaloneAccountingError\(result\.reason\)/);
});

test("per-judge helper allows one provider attempt and no automatic retransmission", () => {
 const section=src.slice(src.indexOf("async function executeControlPlaneJsonTask"),src.indexOf("/** Task identity",src.indexOf("async function executeControlPlaneJsonTask")));
 assert.match(section,/const maxAttempts = args\.singleAttempt \? 1/);
 assert.match(section,/!args\.singleAttempt &&/);
 assert.match(section,/control_plane_\$\{args\.activityOverride \?\? args\.taskName\}/);
 assert.match(section,/remaining\.splice\(remaining\.indexOf\(candidate\), 1\)/);
});

test("selection aggregation uses trusted feedback before votes and never fabricated delivery quality", () => {
 const start=src.indexOf("  const winners = new Map<string, {",src.indexOf("export async function chooseRoutingWithLLM("));
 const end=src.indexOf("\n  if (!result) {",start);
 assert.ok(start>0&&end>start);
 const section=src.slice(start,end);
 assert.match(section,/feedback\?\.positive/);
 assert.match(section,/feedback\?\.negative/);
 assert.match(section,/qualityEvidence \* 3 \+ b\.votes/);
 assert.match(section,/priorScore/);
 const executable=ts.transpileModule(
  "async function select(validJudgments,args) {\n"+section+"\nreturn result;\n}\nglobalThis.select=select;",
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}
 ).outputText;
 const ctx=vm.createContext({Map,Math,Date,judgeStartMs:Date.now(),judges:[{}, {}, {}],console:{info:()=>{}}});
 vm.runInContext(executable,ctx);
 const ballot=(lane,provider,model)=>({lane,provider:"anthropic",modelId:"judge-"+lane,result:{
  selectedProvider:provider,selectedModel:model,selectionJustification:"qualified",selectionComparisons:[]}});
 const a=ballot(0,"openai","candidate-a"),b=ballot(1,"openai","candidate-a"),c=ballot(2,"anthropic","candidate-b");
 const args={candidates:[{providerName:"openai",modelId:"candidate-a",prior_score:9},{providerName:"anthropic",modelId:"candidate-b",prior_score:8}],requestEvidence:{candidates:{
  "openai:candidate-a":{quality:{feedback:{positive:0,negative:1}}},
  "anthropic:candidate-b":{quality:{feedback:{positive:1,negative:0}}}
 }}};
 return ctx.select([a,b,c],args).then(result=>{
  assert.equal(result.result.selectedModel,"candidate-b","verified direct feedback overrides unsupported majority");
  args.requestEvidence.candidates["openai:candidate-a"].quality.feedback={positive:0,negative:0};
  args.requestEvidence.candidates["anthropic:candidate-b"].quality.feedback={positive:0,negative:0};
  return ctx.select([a,b,c],args).then(winner=>assert.equal(winner.result.selectedModel,"candidate-a","consensus wins without quality evidence"));
 });
});

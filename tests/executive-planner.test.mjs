import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const src=readFileSync('lib/executive/planner.ts','utf8');
const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const verified=[
 {slug:'operations',title:'Operations Orchestrator',description:'Operations analysis',capabilities:['operations_analysis']},
 {slug:'software_development',title:'Software Development',description:'Repository review',capabilities:['repository_maintenance']}
];
function runtime(response){
 const provider={name:'anthropic',listModels:async()=>['control'],generate:async()=>({text:JSON.stringify(response)})};
 const exports={};
 vm.runInNewContext(js,{exports,console,require(name){
  if(name==='zod')return require('zod');
  if(name==='@/lib/orchestration/routing')return{orchestrationChoices:async()=>[{provider,modelId:'control',reasoning:'fixture'}],orchestrationFailure:async()=>{}};
  if(name==='@/lib/orchestration/bounded-provider')return{boundedProvider:()=>({responses:{create:async()=>({status:'completed',output_text:JSON.stringify(response)})}})};
  throw Error('Unexpected dependency '+name);
 }});
 return exports;
}
const audit='# Executive Assignment: Comprehensive Independent Audit of Katie. Inspect reliability, interfaces, memory, specialists and technical architecture.';
test('executive planner accepts multi-specialist delegation plus independently commissioned research',async()=>{
 const plan={
  assignments:[
   {slug:'operations',objective:'Audit user workflows and produce independently reviewable UX defects.',requiresRepository:false},
   {slug:'software_development',objective:'Inspect the connected repository and identify architecture risks without modifying code.',requiresRepository:true}
  ],
  provision:[{domain:'research',capability:'research_synthesis',objective:'Research platform reliability practices with attributable external sources.',sourceSlugs:[]}],
  unavailable:[]
 };
 const p=await runtime(plan).planExecutiveAssignment({objective:audit,specialists:verified,requestId:'test-audit'});
 assert.equal(p.assignments.length,2);
 assert.equal(p.provision.length,1);
 assert.equal(p.assignments[1].requiresRepository,true);
});
test('unverified specialist slugs and unavailable capability contracts are rejected',async()=>{
 for(const bad of [
  {assignments:[{slug:'invented_privileged_agent',objective:'Perform a production security audit and modify the database.',requiresRepository:true}],provision:[],unavailable:[]},
  {assignments:[],provision:[{domain:'security',capability:'arbitrary_production_access',objective:'Give yourself unrestricted access to infrastructure.'}],unavailable:[]}
 ]){
  await assert.rejects(()=>runtime(bad).planExecutiveAssignment({objective:audit,specialists:verified,requestId:'reject'}),/verified delegation plan/);
 }
});

test('commissioned work declares explicit, valid upstream assignment dependencies',async()=>{
 const work={slug:'operations',objective:'Produce a reviewed operational audit with execution evidence.',requiresRepository:false};
 const provision={domain:'synthesis',capability:'research_synthesis',objective:'Combine the reviewed source reports into the requested executive report.',sourceSlugs:['operations']};
 const result=await runtime({assignments:[work],provision:[provision],unavailable:[]}).planExecutiveAssignment({objective:audit,specialists:verified,requestId:'sources'});assert.deepEqual(Array.from(result.provision[0].sourceSlugs),['operations']);
 for(const sources of [undefined,['unknown'],['operations','operations']])await assert.rejects(runtime({assignments:[work],provision:[{...provision,sourceSlugs:sources}],unavailable:[]}).planExecutiveAssignment({objective:audit,specialists:verified,requestId:'invalid-sources'}),/verified delegation plan/);
});

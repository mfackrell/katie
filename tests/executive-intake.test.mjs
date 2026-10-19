import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
const req=createRequire(import.meta.url);
const s=ts.transpileModule(readFileSync('lib/executive/intake.ts','utf8'),{compilerOptions:{
 module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true
}}).outputText;
const exports={};
vm.runInNewContext(s,{exports,require:name=>{
 if(name==='@/lib/data/supabase/admin')return{getSupabaseAdminClient:()=>{throw Error('No DB for pure intent tests');}};
 if(name==='./provisioning-service')return{planExecutiveProvisioning:async()=>{throw Error('Not invoked');},configureExecutiveSpecialist:async()=>{throw Error('Not invoked');}};
 if(name==='./provisioning')return{capabilityRequirement:{parse:v=>v}};
 return req(name);
},console,Buffer,Date},{filename:'lib/executive/intake.ts'});
const intent=exports.specialistCreationIntent;
test('explicit new orchestrator creation requests are recognized',()=>{
 for(const [phrase,slug,capability] of [
  ['Create a finance orchestrator','finance','financial_analysis'],
  ['Please configure an operations orchestrator','operations','operations_analysis'],
  ['Set up a research specialist orchestrator','research','research_synthesis'],
  ['I want you to create a human resources orchestrator','human_resources','people_operations']
 ]){
  const v=intent(phrase);assert.ok(v,phrase);assert.equal(v.slug,slug);assert.equal(v.capability,capability);
 }
});
test('ordinary objectives and updates do not trigger new specialist provisioning',()=>{
 for(const text of [
  'Analyze these financial statements','Create a finance report','Build a website',
  'Update the finance orchestrator','What is the status of the finance orchestrator?',
  'I want to understand orchestrator provisioning','proceed','Build that','Create an orchestrator',
  'Do not build a finance orchestrator','Create a financial model','Create an annual impact presentation'
 ])assert.equal(intent(text),null,text);
});
test('unknown specialties generate requested but not invented capabilities',()=>{
 const r=intent('Create a logistics orchestrator');assert.equal(r.slug,'logistics');
 assert.equal(r.capability,'logistics_coordination');
 assert.equal(intent('Create a new orchestrator'),null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const file=readFileSync(resolve('lib/executive/autonomous.ts'),'utf8');
const js=ts.transpileModule(file,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exports={};
vm.runInNewContext(js,{exports,require:(name)=>{
 if(name==='node:crypto')return{createHash:()=>({update:()=>({digest:()=>('a'.repeat(64))})})};
 return {};
}});
const {financeDelegationIntent,developmentDelegationIntent}=exports;
test('routes explicit finance-analysis work only',()=>{
 for(const text of [
  'Analyze the company financial statements and recommend corrective actions.',
  'Review quarterly revenue, COGS and profitability based on the figures provided.',
  'Assess cash flow performance and identify three operating concerns.'
 ])assert.equal(financeDelegationIntent(text),true,text);
});
test('does not steal ordinary chat, operations, software, or privileged requests',()=>{
 for(const text of [
  'How is the weather today?',
  'Build a finance dashboard in my software project.',
  'Analyze financial results and email the report to our customer.',
  'Create a finance orchestrator.',
  'Review the financial code and deploy fixes to production.',
  'Analyze revenue and change the database records.',
  'Analyze cash flow.',
 ])assert.equal(financeDelegationIntent(text),false,text);
});

test('explicit Executive software development requests delegate to existing specialist',()=>{
 for(const text of [
  'Delegate software development to fix the failing checkout integration tests.',
  'Have the software development agent implement a secure audit logging endpoint.',
  'Executive: update the application to display mission review status.'
 ])assert.equal(developmentDelegationIntent(text),true,text);
});
test('ordinary app requests and unrelated content stay with existing project router',()=>{
 for(const text of [
  'Build a new dashboard for my invoices.',
  'Review our software architecture and suggest improvements.',
  'Delegate software development.',
  'Analyze financial statements and cash flow.',
  'Create a specialist orchestrator for operations.'
 ])assert.equal(developmentDelegationIntent(text),false,text);
});

test('incomplete development cues with punctuation never start a mission', async()=>{
 const incomplete=[
  'Delegate software development to   ...?!',
  '  Delegate software development   ...?!  ',
  'Delegate this software development.',
  'Delegate\tsoftware\tdevelopment\tto\t...?!',
  'Delegate software development\n to\n ...?!',
  'Have the software development agent implement',
  'Have the development orchestrator build   ...?!',
  'Please have the software development agent fix   ...?!',
  'Executive: implement                 ...?!',
 ];
 for(const message of incomplete){
  assert.equal(developmentDelegationIntent(message),false,message);
  assert.equal(await exports.startExecutiveDevelopment({actorId:'a',chatId:'b',requestId:'c',activeRepoId:'d',message}),null,message);
 }
 for(const message of [
  'Delegate software development to fix the checkout integration tests.',
  'Please delegate this software development to add regression tests for the Executive router.',
  'Have the development orchestrator build an invoice export endpoint.',
  'Executive: implement an audit logging endpoint.',
 ])assert.equal(developmentDelegationIntent(message),true,message);
});

test('punctuation padding cannot substitute for a complete development objective', async()=>{
 for(const [incomplete,complete] of [
  ['Delegate software development to fix ...?!', 'Delegate software development to fix checkout ...?!'],
  ['Have the software development agent implement logging ...?!', 'Have the software development agent implement audit logging ...?!'],
  ['Executive: update checkout ...?!', 'Executive: update checkout validation ...?!'],
 ]){
  assert.equal(developmentDelegationIntent(incomplete),false,incomplete);
  assert.equal(await exports.startExecutiveDevelopment({actorId:'a',chatId:'b',requestId:'c',activeRepoId:'d',message:incomplete}),null,incomplete);
  assert.equal(developmentDelegationIntent(complete),true,complete);
 }
});

test('complete delegated objective reaches the saved Executive development handoff',async()=>{
 const calls=[];
 const fakeDb={
  from(table){
   return {
    select(){return this;},eq(){return this;},limit(){return this;},
    async maybeSingle(){
     if(table==='executive_delegations')return{data:null,error:null};
     if(table==='repo_sync_runs')return{data:{id:'repo-1',repository_full_name:'mfackrell/katie'},error:null};
     throw Error('Unexpected lookup '+table);
    },
    async returns(){
     if(table==='executive_orchestrators')return{data:[{slug:'software_development',capabilities:['repository_maintenance','web_application_delivery']}],error:null};
     if(table==='managed_agents')return{data:[{id:'lead-1',config:{name:'Mission Lead'}},{id:'dev-1',config:{name:'Development Agent',development:true}}],error:null};
     throw Error('Unexpected collection '+table);
    },
    async update(value){calls.push({table,operation:'update',value});return{error:null};}
   };
  },
  async rpc(name,args){
   calls.push({name,args});
   if(name==='propose_executive_delegation')return{data:{id:'delegation-1'},error:null};
   if(name==='transition_executive_delegation')return{data:{status:args.p_action==='accept'?'accepted':'running'},error:null};
   return{data:{},error:null};
  },
 };
 const isolated={};
 vm.runInNewContext(js,{exports:isolated,require:name=>{
  if(name==='node:crypto')return{createHash:()=>({update:()=>({digest:()=>('a'.repeat(64))})})};
  if(name==='@/lib/data/supabase/admin')return{getSupabaseAdminClient:()=>fakeDb};
  return{};
 }});
 const message='Delegate software development to add a focused regression for checkout validation.';
 const response=await isolated.startExecutiveDevelopment({actorId:'actor-1',chatId:'chat-1',requestId:'request-1',activeRepoId:'repo-1',message});
 assert.match(response,/Executive delegated the repository work to Development/);
 assert.equal(calls.some(x=>x.name==='create_mission'),true);
 assert.equal(calls.some(x=>x.name==='control_mission'&&x.args.p_action==='start'),true);
 assert.deepEqual(calls.filter(x=>x.name==='transition_executive_delegation').map(x=>x.args.p_action),['accept','start']);
});

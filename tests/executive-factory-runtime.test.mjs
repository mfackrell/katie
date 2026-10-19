import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const js=ts.transpileModule(readFileSync('lib/executive/factory-runtime.ts','utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;
function setup({registered=null,agentRows=null}={}){
 const calls=[], saved=[];
 const agents=agentRows??[
  {id:'lead',config:{name:'Mission Lead',research:false,development:true}},
  {id:'analyst',config:{name:'Analysis Agent',research:false,development:false}},
  {id:'researcher',config:{name:'Research Agent',research:true,development:false}},
  {id:'developer',config:{name:'Development Agent',research:false,development:true}},
 ];
 const db={
  from(table){
   const filter=[];
   const builder={
    select(){return this;},eq(...args){filter.push(args);return this;},limit(){return this;},order(){return this;},
    async maybeSingle(){return {data:table==='executive_orchestrators'?registered:null,error:null};},
    async returns(){return {data:table==='managed_agents'?agents:[],error:null};},
    async update(value){calls.push({kind:'update',table,filter,value});return {error:null};}
   };
   return builder;
  },
  async rpc(name,args){
   calls.push({kind:'rpc',name,args});
   if(name==='propose_executive_provisioning')return {data:{id:'provision-id',status:'proposed'},error:null};
   if(name==='propose_executive_delegation')return {data:{id:'delegation-id'},error:null};
   return {data:{id:'configured-or-mission',status:'running'},error:null};
  }
 };
 const exports={};
 vm.runInNewContext(js,{exports,require:name=>{
  if(name==='@/lib/data/supabase/admin')return {getSupabaseAdminClient:()=>db};
  if(name==='@/lib/data/persistence-store')return {saveMessage:async(_id,msg)=>saved.push(msg)};
  return require(name);
 },Date,console,Buffer});
 return {factory:exports,calls,saved};
}
test('Executive factory creates a real three-agent acceptance mission but does not self-activate',async()=>{
 const {factory,calls}=setup();
 const response=await factory.startSpecialistFactory({
  actorId:'actor',chatId:'chat',requestId:'request',message:'Create an operations orchestrator',
  intent:{domain:'operations',slug:'operations',capability:'operations_analysis'}
 });
 assert.match(response,/independent multi-agent acceptance mission/);
 const make=calls.find(c=>c.name==='create_mission');
 assert.ok(make,'a real mission must be created');
 assert.deepEqual(Array.from(make.args.p_agents),['lead','analyst','researcher']);
 assert.equal(make.args.p_repository,null);
 assert.ok(calls.some(c=>c.name==='control_mission'&&c.args.p_action==='start'));
 assert.ok(calls.some(c=>c.kind==='update'&&c.table==='executive_provisioning_requests'&&c.value.evidence.acceptanceMissionId));
 assert.equal(calls.some(c=>c.name==='transition_executive_provisioning'&&c.args.p_action==='activate'),false);
});
test('active specialists are reusable without duplicate provisioning',async()=>{
 const {factory,calls}=setup({registered:{id:'active',slug:'operations',status:'active'}});
 const response=await factory.startSpecialistFactory({
  actorId:'actor',chatId:'chat',requestId:'request',message:'Create an operations orchestrator',
  intent:{domain:'operations',slug:'operations',capability:'operations_analysis'}
 });
 assert.match(response,/already an active specialist/);
 assert.equal(calls.length,0);
});
test('specialist dispatch intent is narrow and never takes ordinary requests',()=>{
 const {factory}=setup();
 assert.deepEqual(JSON.parse(JSON.stringify(factory.specialistAssignmentIntent(
  'Ask the operations orchestrator to analyze the plant scheduling backlog.'))),
  {slug:'operations',objective:'analyze the plant scheduling backlog.'});
 for(const message of ['What is an operations orchestrator?','Create an operations orchestrator',
  'Analyze the plant scheduling backlog','Ask the operations orchestrator to fix']){
   assert.equal(factory.specialistAssignmentIntent(message),null,message);
 }
});
test('inactive specialist refuses work rather than claiming completion',async()=>{
 const {factory,calls}=setup({registered:{slug:'operations',status:'registered',capabilities:['operations_analysis']}});
 const response=await factory.startSpecialistAssignment({
  actorId:'actor',chatId:'chat',requestId:'request',message:'Ask the operations orchestrator to analyze plant scheduling.'
 });
 assert.match(response,/not active/);
 assert.equal(calls.some(c=>c.name==='create_mission'),false);
});

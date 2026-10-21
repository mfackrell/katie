import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
function runtime({review='pass',alreadyDelivered=false,provision=false,sourceStatus='completed',provisionCapability='research_synthesis',provisionObjective='Synthesize source reports',provisionSources=undefined}={}){
 const result='Reviewed evidence. '.repeat(900)+' COMPLETE_FINAL_SENTINEL',saved=[],writes=[],dispatches=[];
 const row={id:'record',actor_id:'eo',chat_id:'chat',request_id:'request',objective:'Complete an evidence-backed audit.',status:'running',detail:'Working',plan:{assignments:[{slug:'operations',objective:'Audit workflow',requiresRepository:false,requestId:'assignment',missionId:'mission'}],provision:[],unavailable:[],createdAt:'2026-10-20T00:00:00Z'}};
 if(provision)row.plan.provision.push({domain:'synthesis',capability:provisionCapability,objective:provisionObjective,sourceSlugs:provisionSources,requestId:'provision',started:true});
 const db={from(table){return{
  select(){return this;},eq(){return this;},in(){return this;},order(){return this;},limit(){return this;},
  async returns(){if(table==='executive_management_requests')return{data:[row],error:null};if(table==='mission_assignments')return{data:[{job_key:'review',result:{verdict:review},status:'completed'}],error:null};throw Error(table);},
  async maybeSingle(){if(table==='executive_orchestrators')return{data:{status:'active',capabilities:[provisionCapability]},error:null};if(table==='agent_missions')return{data:{status:sourceStatus,result,detail:'Review evidence absent'},error:null};if(table==='messages')return{data:alreadyDelivered?{id:'existing'}:null,error:null};throw Error(table);},
  async update(patch){writes.push(patch);return{error:null};}
 };}};
 const exports={};const js=ts.transpileModule(readFileSync('lib/executive/general.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(js,{exports,console,require(name){if(name==='node:crypto')return require(name);if(name==='@/lib/data/supabase/admin')return{getSupabaseAdminClient:()=>db};if(name==='@/lib/data/persistence-store')return{saveMessage:async(_,m)=>saved.push(m)};if(name==='./planner')return{};if(name==='./factory-runtime')return{startSpecialistAssignment:async input=>{dispatches.push(input);return'Mission: 22222222-2222-4222-8222-222222222222';}};throw Error(name);}});
 return{run:exports.reconcileExecutiveManagement,saved,writes,result,dispatches};
}
test('Executive delivers the full reviewed specialist result without cutting the approved artifact',async()=>{
 const r=runtime();const count=await r.run();assert.equal(count.completed,1);assert.equal(r.saved.length,1);assert.ok(r.saved[0].content.includes(r.result));assert.match(r.saved[0].content,/COMPLETE_FINAL_SENTINEL/);assert.equal(r.writes.at(-1).status,'completed');
});
test('Executive never accepts mission completion without a passing independent review',async()=>{
 const r=runtime({review:'changes_requested'});const count=await r.run();assert.equal(count.blocked,1);assert.equal(r.writes.at(-1).status,'blocked');assert.match(r.saved[0].content,/PARTIAL \/ BLOCKED/);assert.ok(!r.saved[0].content.includes(r.result));
});
test('Executive delivery remains idempotent after the message was saved before ledger completion',async()=>{
 const r=runtime({alreadyDelivered:true});await r.run();assert.equal(r.saved.length,0);assert.equal(r.writes.at(-1).status,'completed');
});


test('recovered Executive results get a new delivery receipt while repeated identical reports remain stable',async()=>{
 const blocked=runtime({review:'changes_requested'}),verified=runtime(),same=runtime();
 await blocked.run();await verified.run();await same.run();
 assert.notEqual(blocked.saved[0].id,verified.saved[0].id);
 assert.equal(verified.saved[0].id,same.saved[0].id);
});

test('commissioned synthesis waits for reviewed source work and receives its mission bindings',async()=>{
 const waiting=runtime({provision:true,sourceStatus:'running'});await waiting.run();assert.equal(waiting.dispatches.length,0);assert.equal(waiting.writes.at(-1).status,'running');
 const rejected=runtime({provision:true,review:'changes_requested'});await rejected.run();assert.equal(rejected.dispatches.length,0);assert.equal(rejected.writes.at(-1).status,'blocked');
 const ready=runtime({provision:true});await ready.run();assert.equal(ready.dispatches.length,1);assert.deepEqual(Array.from(ready.dispatches[0].sourceMissionIds),['mission']);assert.equal(ready.dispatches[0].requiresRepository,false);
});

test('unrelated commissioned work is not made dependent on existing source audits',async()=>{
 const r=runtime({provision:true,sourceStatus:'running',provisionCapability:'financial_analysis',provisionObjective:'Analyze the supplied liquidity forecast independently.'});
 await r.run();assert.equal(r.dispatches.length,1);assert.deepEqual(Array.from(r.dispatches[0].sourceMissionIds),[]);
});

test('explicit source links govern dependencies across domains, while [] keeps independent synthesis runnable',async()=>{
 const dependent=runtime({provision:true,sourceStatus:'running',provisionCapability:'financial_analysis',provisionObjective:'Analyze the operating report for financial impact.',provisionSources:['operations']});await dependent.run();assert.equal(dependent.dispatches.length,0);
 const independent=runtime({provision:true,sourceStatus:'running',provisionObjective:'Synthesize technical public-source reports independently.',provisionSources:[]});await independent.run();assert.equal(independent.dispatches.length,1);assert.deepEqual(Array.from(independent.dispatches[0].sourceMissionIds),[]);
});

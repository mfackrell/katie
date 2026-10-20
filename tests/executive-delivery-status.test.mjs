import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const js=ts.transpileModule(readFileSync('lib/executive/delivery.ts','utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;
function service(rows={}){
 const calls=[],exports={};
 const db={from(table){const filters=[];return {select(){return this;},eq(k,v){filters.push([k,v]);return this;},order(){return this;},async range(from,to){calls.push({table,filters,from,to});return {data:(rows[table]??[]).slice(from,to+1),error:rows.error??null};}};}};
 vm.runInNewContext(js,{exports,require:name=>name==='@/lib/data/supabase/admin'?{getSupabaseAdminClient:()=>db}:require(name),Set});
 return {...exports,calls};
}
const d={id:'003be4e4-de7c-46e8-a500-5744e388929a',status:'running',mission_id:'mission',request_key:'exec-specialist-task-test'};
test('terminal delegation waits for its durable reply, including transition/delivery races',()=>{
 const {executiveDeliveryPending,delegationReplyId}=service();
 assert.equal(delegationReplyId(d.id),'3f1d797d-8e1e-4da0-8d29-bf99ec6f7f6f');
 for(const status of ['running','submitted','verified','cancelled']){
  assert.equal(executiveDeliveryPending([{...d,status}],[],new Set()),true,status);
 }
 for(const status of ['verified','cancelled'])assert.equal(
  executiveDeliveryPending([{...d,status}],[],new Set([delegationReplyId(d.id)])),false,status);
 assert.equal(executiveDeliveryPending([{...d,request_key:'unrelated'}],[],new Set()),false);
});
test('factory completion waits for its existing durable activation or blocker message',()=>{
 const {executiveDeliveryPending,factoryReplyId}=service();
 const p={id:'request',route:'configure',status:'configured',evidence:{acceptanceMissionId:'mission'}};
 for(const status of ['configured','validated','activated','blocked'])assert.equal(
  executiveDeliveryPending([],[{...p,status}],new Set()),true,status);
 for(const status of ['activated','blocked'])assert.equal(
  executiveDeliveryPending([],[{...p,status}],new Set([factoryReplyId(p.id)])),false,status);
 assert.equal(executiveDeliveryPending([],[{...p,route:'commission',status:'commission_pending'}],new Set()),false);
 assert.equal(executiveDeliveryPending([],[{...p,evidence:{}}],new Set()),false,
  'a startup error without a linked acceptance mission must not poll forever');
});
test('delivery status reads only the requested actor/chat and reports read failures',async()=>{
 const x=service({executive_delegations:[d]});
 assert.equal(await x.hasPendingExecutiveDelivery('owner','chat',[]),true);
 assert.equal(x.calls.length,2);
 for(const call of x.calls)assert.deepEqual(JSON.parse(JSON.stringify(call.filters)),[['actor_id','owner'],['chat_id','chat']]);
 await assert.rejects(service({error:Error('offline')}).hasPendingExecutiveDelivery('owner','chat',[]),/unavailable/);
});
for(const table of ['executive_delegations','executive_provisioning_requests']){
 test(`pending work beyond 100 ${table} records keeps chat delivery polling`,async()=>{
  const terminal=Array.from({length:150},(_,i)=>table==='executive_delegations'
   ? {...d,id:'old-'+i,status:'verified'}
   : {id:'old-'+i,route:'configure',status:'activated',evidence:{acceptanceMissionId:'mission'}});
  const x=service({[table]:[...terminal,table==='executive_delegations'?d:
   {id:'pending',route:'configure',status:'configured',evidence:{acceptanceMissionId:'mission'}}]});
  const messages=terminal.map(r=>({id:table==='executive_delegations'?x.delegationReplyId(r.id):x.factoryReplyId(r.id)}));
  assert.equal(await x.hasPendingExecutiveDelivery('owner','chat',messages),true);
  assert.equal(x.calls.filter(c=>c.table===table).length,2);
 });
}

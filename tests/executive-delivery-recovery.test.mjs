import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const native=createRequire(import.meta.url);
function runtime({factory=false,fail=null,missionStatus='completed'}={}){
 const request={id:'request',actor_id:'actor',chat_id:'chat',specialist_slug:'operations',capability:'operations_analysis',
  status:factory?'configured':'running',evidence:{acceptanceMissionId:'mission'},mission_id:'mission',request_key:'exec-specialist-task-test',objective:'Read-only analysis'};
 const messages=new Map(),actions=[],updates=[];let failure=fail;
 const jobs=[{job_key:'review',role:'review',status:'completed',result:{verdict:'pass'}},
  ...['analyst','researcher'].map(agent_id=>({agent_id,role:'work',status:'completed',payload:{capability:'analysis'},result:{calculations:[{result:6}]}}))].map(job=>({...job,mission_id:'mission'}));
 const db={from(table){const filters=[];const query={
  select(){return this;},eq(k,v){filters.push([k,[v]]);return this;},in(k,v){filters.push([k,v]);return this;},order(){return this;},limit(){return this;},
  rows(){let rows=table==='messages'?[...messages.values()]:table==='agent_missions'?[{id:'mission',status:missionStatus,result:'Reviewed answer',detail:'Acceptance failed'}]:table==='mission_assignments'?jobs:[request];
   return rows.filter(row=>filters.every(([k,values])=>values.includes(row[k])));},
  async maybeSingle(){return {data:this.rows()[0]??null,error:null};},
  async returns(){return {data:this.rows(),error:null};},
  then(resolve,reject){return Promise.resolve({data:this.rows().map(r=>structuredClone(r)),error:null}).then(resolve,reject);},
  async update(value){if(failure==='upgrade'&&table==='executive_orchestrators'){failure=null;return {error:Error('interrupted upgrade')};}
   updates.push(table);if(table==='executive_provisioning_requests')Object.assign(request,value);return {error:null};}
 };return query;},
 async rpc(_name,args){actions.push(args.p_action);
  if(failure===args.p_action){failure=null;return {data:null,error:Error('interrupted transition')};}
  const next={submit:'submitted',verify:'verified',validate:'validated',activate:'activated',cancel:'cancelled'}[args.p_action];
  request.status=next;if(args.p_action==='validate')request.evidence=args.p_evidence;
  return {data:{status:next},error:null};}
 };
 const exports={};
 const source=readFileSync(factory?'lib/executive/factory-runtime.ts':'lib/executive/autonomous.ts','utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  exports,Date,Set,Buffer,console,require:name=>{
   if(name==='@/lib/data/supabase/admin')return {getSupabaseAdminClient:()=>db};
   if(name==='@/lib/data/persistence-store')return {saveMessage:async(_chat,message)=>{
    if(failure==='delivery'){failure=null;throw Error('interrupted chat write');}messages.set(message.id,message);
   }};
   if(name==='./delivery')return {delegationReplyId:id=>'delegation-'+id,factoryReplyId:id=>'factory-'+id};
   if(name==='./factory-runtime')return {reconcileSpecialistFactory:async()=>({activated:0,blocked:0})};
   if(name==='./release-control')return {reconcileExecutiveReleases:async()=>({verified:0})};
   if(name==='./provisioning-service')return {};
   return native(name);
  }
 });
 return {request,messages,actions,updates,run:factory?exports.reconcileSpecialistFactory:exports.reconcileExecutiveFinance};
}
test('submitted delegation recovers verification and delivers once without a new mission',async()=>{
 const x=runtime({fail:'verify'});await x.run();
 assert.equal(x.request.status,'submitted');assert.equal(x.messages.size,0);
 await x.run();assert.equal(x.request.status,'verified');assert.equal(x.messages.size,1);
 await x.run();assert.equal(x.messages.size,1);
 assert.deepEqual(x.actions,['submit','verify','verify']);
});
for(const failure of ['activate','upgrade','delivery']){
 test(`factory resumes after ${failure} interruption and delivers exactly once`,async()=>{
  const x=runtime({factory:true,fail:failure});await x.run().catch(error=>assert.match(error.message,/interrupted|configuration/));
  assert.equal(x.messages.size,0);assert.equal(x.request.status,failure==='activate'?'validated':'activated');
  await x.run();assert.equal(x.request.status,'activated');assert.equal(x.messages.size,1);
  assert.match([...x.messages.values()][0].content,/Executive activated operations/);
  await x.run();assert.equal(x.messages.size,1);assert.equal(x.actions.filter(a=>a==='validate').length,1);
 });
}
test('blocked factory retries only its failure notification and never activates',async()=>{
 const x=runtime({factory:true,fail:'delivery',missionStatus:'blocked'});
 await assert.rejects(x.run(),/interrupted chat write/);assert.equal(x.request.status,'blocked');
 await x.run();await x.run();assert.equal(x.messages.size,1);
 assert.match([...x.messages.values()][0].content,/could not activate/);assert.deepEqual(x.actions,[]);
});

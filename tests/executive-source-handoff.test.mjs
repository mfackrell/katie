import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
const id='11111111-1111-4111-8111-111111111111';
function fixture({linked=true,status='completed',verdict='pass',latest=null}={}){
 const filters=[],report='Complete reviewed source. '.repeat(900)+' END_OF_SOURCE';
 const db={from(table){const q={select(){return q;},eq(...a){filters.push([table,...a]);return q;},in(...a){filters.push([table,...a]);return q;},async returns(){
  if(table==='executive_delegations')return{data:linked?[{mission_id:id}]:[]};
  if(table==='agent_missions')return{data:[{id,objective:'Source audit',status,result:report,updated_at:'2026-10-21'}]};
  if(table==='mission_assignments')return{data:[{id:'review',mission_id:id,job_key:'review',status:'completed',result:{verdict}},...(latest?[{id:'again',mission_id:id,job_key:'review_again',status:latest.status,result:{verdict:latest.verdict}}]:[])]};
 },async maybeSingle(){return{data:{actor_id:'owner',chat_id:'chat',result:{sourceMissionIds:[id]}}};}};return q;}};
 const exports={};vm.runInNewContext(ts.transpileModule(readFileSync('lib/executive/source-handoff.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Set,Error,require:name=>{assert.equal(name,'@/lib/data/supabase/admin');return{getSupabaseAdminClient:()=>db};}});
 return{api:exports,filters,report};
}
test('source handoff carries complete independently reviewed reports from the same owning conversation',async()=>{
 const f=fixture(),reports=await f.api.sourceReportsForMission('synthesis-mission');assert.equal(reports[0].report,f.report);assert.match(reports[0].report,/END_OF_SOURCE$/);assert.equal(reports[0].reviewJobId,'review');
 assert.ok(f.filters.some(x=>x[0]==='executive_delegations'&&x[1]==='actor_id'&&x[2]==='owner'));
 assert.ok(f.filters.some(x=>x[0]==='executive_delegations'&&x[1]==='chat_id'&&x[2]==='chat'));
});
test('foreign, incomplete, unreviewed and superseded source reports cannot become synthesis evidence',async()=>{
 for(const options of [{linked:false},{status:'running'},{verdict:'changes_requested'},{latest:{status:'failed',verdict:'pass'}},{latest:{status:'completed',verdict:'changes_requested'}}]){
  const f=fixture(options);await assert.rejects(f.api.executiveSourceReports({actorId:'owner',chatId:'chat',missionIds:[id]}),/outside|independently reviewed/);
 }
 const f=fixture();for(const ids of [[],[id,id],['invented-source']])await assert.rejects(f.api.executiveSourceReports({actorId:'owner',chatId:'chat',missionIds:ids}),/Invalid Executive source/);
});

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// QA-only test driver for real competing owner RPCs. This is invoked after
// the synthetic 76/96-mission fixture and candidate migration are COMMITTED
// in a disposable PostgreSQL cluster. Both clients call the actual RPCs.
const ORIGINAL='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const NEW_RELEASE='b'.repeat(40);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const query=(client,sql,args=[])=>client.query(sql,args);
const scalar=async(client,sql,args=[])=> (await query(client,sql,args)).rows[0];
async function ensureWaiting(primary,rivalPid,stage) {
 let seen=false;
 for(let i=0;i<100;i++){
  const r=await scalar(primary,
   "select count(*)::int n from pg_locks where pid=$1 and not granted and locktype='advisory'",
   [rivalPid]);
  if(r.n>0){seen=true;break;}
  await sleep(25);
 }
 assert.equal(seen,true,stage+': actual second owner RPC must block on the transaction advisory lock');
 console.log('INDEPENDENT_QA_COMMITTED_RPC_LOCK_WAIT_PASS: '+stage);
}
async function concurrentPhase(primary,rival,statement,argsA,argsB,stage) {
 await query(primary,'begin');
 let first,second;
 try {
  first=await scalar(primary,statement,argsA);
  const competing=query(rival,statement,argsB).then(
   result=>({status:'fulfilled',value:result.rows[0]}),
   error=>({status:'rejected',error:String(error.message??error)})
  );
  const pid=await scalar(primary,"select pid from pg_stat_activity where backend_type='client backend' and pid<>pg_backend_pid() and query like 'select project_org_%blocked_owner%' order by query_start desc limit 1");
  // Repeatedly test for the rival's lock wait; use its known backend PID.
  const rivalPid=globalThis.__qaRivalPid;
  assert.ok(Number.isInteger(rivalPid));
  await ensureWaiting(primary,rivalPid,stage);
  await query(primary,'commit');
  second=await competing;
 }catch(e){
  await query(primary,'rollback').catch(()=>{});
  throw e;
 }
 assert.equal(second.status,'rejected',stage+': stale competing call must be rejected after single committed winner');
 assert.match(second.error,/authorization|owner|receipt|state|window|blocked|current|fresh|expired|resume|scope|cutoff|authority|changed/i,stage+': typed stale-authority rejection');
 return {first,second};
}
export async function qaCommittedOwnerRpcRace(db,rival,{owner,project,priorWindow,priorCutoff}) {
 assert.equal(project,ORIGINAL);
 await query(db,'set role service_role');
 await query(rival,'set role service_role');
 const functions=await scalar(rival,`select
  to_regprocedure('public.project_org_authorize_blocked_owner_window(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid,text)') is not null authorize_visible,
  to_regprocedure('public.project_org_resume_blocked_owner_confirmed(uuid,uuid,text,uuid,timestamptz,text)') is not null resume_visible`);
 assert.deepEqual(functions,{authorize_visible:true,resume_visible:true},
  'Both real owner RPCs must be visible from independent connection after committed DDL');
 const rivalPid=(await scalar(rival,'select pg_backend_pid() pid')).pid;
 globalThis.__qaRivalPid=rivalPid;
 const initial=await scalar(db,`select p.status,p.active_mission_id,p.max_missions,p.token_allowance,
  p.approved_hash, a.window_id from work_projects p join project_provider_execution a on a.project_id=p.id where p.id=$1`,[project]);
 assert.equal(initial.status,'blocked');assert.equal(initial.active_mission_id,null);
 assert.equal(initial.max_missions,96);assert.equal(initial.token_allowance,600000);
 assert.equal((await scalar(db,'select count(*)::int n from agent_missions where project_id=$1',[project])).n,76);
 assert.equal((await scalar(db,'select count(*)::int n from project_work_packages where project_id=$1',[project])).n,0);
 const beforeOffer=(await scalar(db,'select project_org_blocked_owner_offer($1,$2,$3) r',[owner,project,NEW_RELEASE])).r;
 assert.equal(beforeOffer.stage,'authorize');
 assert.equal(beforeOffer.priorWindowId,priorWindow);
 const cutoff=new Date(Date.now()+90*60*1000).toISOString();
 const authorizationA=randomUUID(),authorizationB=randomUUID();
 const authorize='select project_org_authorize_blocked_owner_window($1,$2,$3,$4,$5,$6,$7,$8) r';
 const base=[owner,project,NEW_RELEASE,priorWindow,priorCutoff,cutoff];
 const firstAuth=await concurrentPhase(db,rival,authorize,[...base,authorizationA,beforeOffer.stateHash],
  [...base,authorizationB,beforeOffer.stateHash],'authorization-different-IDs');
 assert.equal(firstAuth.first.r.authorizationId,authorizationA);
 assert.equal(firstAuth.first.r.stage,'resume');
 assert.equal((await scalar(db,'select count(*)::int n from project_blocked_owner_windows where project_id=$1',[project])).n,1);
 assert.equal((await scalar(db,'select count(*)::int n from project_organization_contract_changes where project_id=$1 and window_id=$2',[project,authorizationA])).n,13);
 assert.equal((await scalar(db,'select count(*)::int n from project_blocked_owner_resumes where project_id=$1',[project])).n,0);
 assert.equal((await scalar(db,'select count(*)::int n from agent_missions where project_id=$1',[project])).n,76);
 assert.equal((await scalar(db,'select status from work_projects where id=$1',[project])).status,'blocked');
 const pending=(await scalar(db,'select project_org_blocked_owner_offer($1,$2,$3) r',[owner,project,NEW_RELEASE])).r;
 assert.equal(pending.stage,'resume');assert.equal(pending.authorizationId,authorizationA);
 const resume='select project_org_resume_blocked_owner_confirmed($1,$2,$3,$4,$5,$6) r';
 const resumeArgs=[owner,project,NEW_RELEASE,authorizationA,cutoff,pending.stateHash];
 const firstResume=await concurrentPhase(db,rival,resume,resumeArgs,resumeArgs,'resume-same-receipt');
 assert.equal(firstResume.first.r.stage,'resumed');
 assert.equal(firstResume.first.r.existing,false);
 assert.equal((await scalar(db,'select count(*)::int n from project_blocked_owner_resumes where project_id=$1',[project])).n,1);
 assert.equal((await scalar(db,'select status from work_projects where id=$1',[project])).status,'running');
 assert.equal((await scalar(db,'select count(*)::int n from agent_missions where project_id=$1',[project])).n,76);
 assert.equal((await scalar(db,'select count(*)::int n from project_work_packages where project_id=$1',[project])).n,0);
 const unchanged=await scalar(db,'select max_missions,token_allowance,approved_hash from work_projects where id=$1',[project]);
 assert.equal(unchanged.max_missions,96);assert.equal(unchanged.token_allowance,600000);
 assert.equal(unchanged.approved_hash,initial.approved_hash);
 assert.equal((await scalar(db,'select count(*)::int n from project_organization_nodes where project_id=$1',[project])).n,13);
 const wake=await scalar(db,`select count(*)::int n from project_organization_nodes
  where project_id=$1 and decision_needed and area='game_delivery' and management_level='functional_director'`,[project]);
 assert.equal(wake.n,1,'Separate resume wakes only the existing responsible Game Delivery director');
 const fresh=await scalar(db,'select project_org_blocked_owner_offer($1,$2,$3) r',[owner,project,NEW_RELEASE]);
 assert.equal(fresh.r.stage,'resumed');
 console.log('INDEPENDENT_QA_COMMITTED_TWO_RPC_RACE_PASS: both RPCs executed on two live connections with visible committed schema; competing authorization and resume serialized; one receipt each; no mission, package, spending or cap reset');
}

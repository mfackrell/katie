// Exact Nov 6 production watchdog state in disposable PostgreSQL only.
// Original WIP and historical paid calls are preserved, not regenerated.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const blockId='888cacee-5ed6-456e-a770-38cad2c8467a';
const deadlineId='137d00e7-1fa9-47c4-898b-4bdd704c1c6d';
const reason='The original project or mission authorization deadline expired.';
const minimumAction='Obtain an explicit owner deadline authorization for this saved scope; no deadline was extended.';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const rpc=async(db,name,args)=>(await one(db,'select '+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') x',args)).x;
const denied=async(db,fn,pattern)=>{
 await db.query('savepoint rejected_watchdog_owner');
 try{await assert.rejects(fn(),pattern);}
 finally{
  await db.query('rollback to savepoint rejected_watchdog_owner');
  await db.query('release savepoint rejected_watchdog_owner');
 }
};
const rejectState=async(db,name,sql,params,proposal)=>{
 await db.query('savepoint '+name);
 try{
  await db.query('reset role');
  await db.query(sql,params);
  await db.query('set role service_role');
  const result=await proposal();
  assert.equal(result.ready,false,'Unsafe '+name+' must fail closed: '+JSON.stringify(result));
 }finally{
  await db.query('rollback to savepoint '+name);
  await db.query('release savepoint '+name);
  await db.query('set role service_role');
 }
};
export async function qualifyTask4aWatchdogFixture(db,{
 project,mission,task,wrong,owner,account,priorDigest,release,checkpoint,snapshot,limits
}){
 const args=[release,checkpoint,snapshot,limits],proposal=()=>rpc(db,'task4a_postpaid_proposal',args);
 // The fixture already proved the historical running-state preview.
 // Now reproduce the real watchdog-blocked state, task still DISPATCHING.
 await db.query('reset role');
 await db.query(`update work_projects set status='blocked',detail=$2,
  impediment=$3::jsonb,progress_signature=$4,
  progress_since='2026-11-06T16:46:40.041792Z'::timestamptz,
  updated_at='2026-11-06T18:46:46.067435Z'::timestamptz where id=$1`,
  [project,reason,JSON.stringify({kind:'blocked',step:'development',
   attempted:['Inspected the saved task, scope, leases, checkpoints and max(actual,reserved) charges.'],
   impediment:reason,minimumAction}),'18e5502e1cccf1e238849031b622f1f8']);
 await db.query(`update agent_missions set status='blocked',detail=$2,
  updated_at='2026-11-06T18:46:46.067435Z'::timestamptz where id=$1`,[mission,reason]);
 await db.query(`update mission_assignments set status='failed',
  updated_at='2026-11-06T18:46:46.067435Z'::timestamptz where id=$1`,[task]);
 await db.query(`update agent_tasks set status='dispatching',
  updated_at='2026-11-06T18:44:41.819198Z'::timestamptz where id=$1`,[task]);
 await db.query('set role service_role');
 const noReceipts=await proposal();
 assert.equal(noReceipts.ready,false,'Blocked state without exact watchdog receipts is ineligible');
 assert.equal(noReceipts.reason,'original_postpaid_evidence_unavailable');
 const block={detail:'No new completed artifact or external execution transition for 02:00:00 in development. Work is blocked; saved results and charges are retained.',
  impediment:{kind:'blocked',step:'development',
   attempted:['Inspected persisted assignment artifacts and external task transitions; repeated polling is not execution.'],
   impediment:'Saved execution has made no observable progress for 02:00:00.',
   minimumAction:'Restore the stalled worker or external workflow for saved mission '+mission+', then resume within the existing authorization.'}};
 const expired={key:'c5f6d7a4ce2130ff303fcbe9c8211f4481057ded20fc6e6771236fe105a52409',
  task,reason,minimumAction};
 await db.query('reset role');
 await db.query(`insert into project_events(id,project_id,event,created_at,data)
  values($1,$2,'block','2026-11-06T18:46:40.086190Z'::timestamptz,$3::jsonb)`,
  [blockId,project,JSON.stringify(block)]);
 await db.query(`insert into project_events(id,project_id,event,created_at,data)
  values($1,$2,'development_dispatch_recovery_blocked',
  '2026-11-06T18:46:46.067435Z'::timestamptz,$3::jsonb)`,
  [deadlineId,project,JSON.stringify(expired)]);
 await db.query('set role service_role');
 const ready=await proposal();
 assert.equal(ready.ready,true,JSON.stringify(ready));
 assert.equal(ready.proposal.watchdogBlockedRecovery.version,'task4a_exact_watchdog_block_v1');
 assert.equal(ready.proposal.watchdogBlockedRecovery.blockEventId,blockId);
 assert.equal(ready.proposal.watchdogBlockedRecovery.deadlineEventId,deadlineId);
 assert.equal(ready.proposal.mistakenGenericApproval.approvalId,wrong);
 assert.equal(ready.proposal.settledCalls,4);
 assert.equal(ready.proposal.settledTokens,49620);
 assert.equal(ready.proposal.protectedAssessmentTokens,60000);
 assert.equal(ready.proposal.protectedCompletionTokens,60000);
 assert.equal((await one(db,'select count(*)::int n from benchmark_budget_calls where account_id=$1',[account])).n,4);
 assert.equal((await one(db,'select spent_tokens from benchmark_budget_accounts where id=$1',[account])).spent_tokens.toString(),'49620');
 assert.notEqual(ready.digest,priorDigest,'Running-state consent must be stale after watchdog');
 await denied(db,()=>rpc(db,'task4a_postpaid_authorize',[randomUUID(),ready.digest,...args]),
  /TASK4A_POSTPAID_OWNER_CONSENT_DENIED/);
 await denied(db,()=>rpc(db,'task4a_postpaid_authorize',[owner,priorDigest,...args]),
  /TASK4A_POSTPAID_OWNER_CONSENT_DENIED/);
 await rejectState(db,'wrong_project_status',"update work_projects set status='running' where id=$1",[project],proposal);
 await rejectState(db,'wrong_mission_status',"update agent_missions set status='running' where id=$1",[mission],proposal);
 await rejectState(db,'wrong_assignment_status',"update mission_assignments set status='waiting_external' where id=$1",[task],proposal);
 await rejectState(db,'wrong_task_status',"update agent_tasks set status='blocked' where id=$1",[task],proposal);
 await rejectState(db,'wrong_watchdog_signature',"update work_projects set progress_signature='changed' where id=$1",[project],proposal);
 await rejectState(db,'wrong_expired_mission',"update agent_missions set deadline=now()+interval '2 hours' where id=$1",[mission],proposal);
 await rejectState(db,'expired_generic_approval',"update benchmark_native_spending_approvals set deadline=now()-interval '1 second' where id=$1",[wrong],proposal);
 await rejectState(db,'expired_official_price',
  "update model_registry set pricing_verified_at=now()-interval '25 hours' where provider_name='openai' and model_id='gpt-5.3-codex'",[],proposal);
 await rejectState(db,'later_unverified_watchdog',
  "insert into project_events(project_id,event,created_at,data) values($1,'block',clock_timestamp(),'{}'::jsonb)",[project],proposal);
 const again=await proposal();
 assert.equal(again.ready,true,'Negative tests must preserve the real watcher receipts');
 assert.equal(again.digest,ready.digest);
 console.log('TASK4A_EXACT_WATCHDOG_PRODUCTION_STATE_NEGATIVE_AND_EXPIRY_POSTGRES_PASS');
 return ready.digest;
}

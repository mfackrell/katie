import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
const project='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const mission='d3fd3d95-7287-4bfc-8c97-c105fde46c36';
const task='d0e41ff5-149e-4319-9e65-dcc605fb75da';
const checkpoint='8e53ce01693303fc50daf5da1567e93e725f9b2d';
const release='d530aa94dd8d9c2bc442b43b324ace312d0d62b9';
const snapshot='f'.repeat(64);
const wrong='919a68f0-3fb9-423c-80f2-4a3a51407bf0';
const wrongReceipt='3120cdbf-ec74-4f1a-b314-8ec3e0f0d0c1';
const wrongProposal='337de31bffd378298086f0fcdc66a13ea5033c2f4676a26af2cefaa17be9c914';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const rpc=async(db,name,args)=>(await one(db,'select '+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') val',args)).val;
const negative=async(db,fn,pattern)=>{
 await db.query('savepoint rejected');
 try{await assert.rejects(fn(),pattern);}
 finally{await db.query('rollback to savepoint rejected');await db.query('release savepoint rejected');}
};
export async function verifyTask4aPostpaidPostgres(db,{connect,owner,account,approval}){
 assert.equal(typeof connect,'function','Requires two independent real PostgreSQL connections');
 // Build historical four-settled-call fixture in this disposable test cluster.
 await db.query('reset role');
 await db.query('alter table benchmark_execution_grants add column if not exists account_id uuid');
 await db.query('alter table benchmark_dollar_exposures add column if not exists call_id uuid, add column if not exists exposure_microusd numeric');
 await db.query('alter table benchmark_lifecycle_proposals add column if not exists snapshot_hash text, add column if not exists fingerprint text, add column if not exists proposal jsonb, add column if not exists checkpoint jsonb, add column if not exists expires_at timestamptz');
 const oldGrant=randomUUID();
 await db.query('alter table benchmark_execution_grants disable trigger user');
 await db.query("insert into benchmark_execution_grants(id,token_digest,account_id,developer_approval_id,project_id,mission_assignment_id,execution_epoch,deadline) values($1,$2,$3,$4,$5,$6,1,now()+interval '2 hours')",
  [oldGrant,'a'.repeat(64),account,approval,project,task]);
 await db.query('alter table benchmark_execution_grants enable trigger user');
 await db.query('alter table mission_calls disable trigger user');
 const tokens=[7312,11950,15000,15358],reserved=[12364,16959,19906,20374],exposure=[13629,22273,28872,28151];
 for(let i=0;i<4;i++){
  const id=randomUUID(),op=randomUUID();
  await db.query("insert into mission_calls(id,job_id,lease,model,reserved_tokens,actual_tokens,status) values($1,$2,$3,'gpt-5.3-codex',$4,$5,'completed')",
    [id,task,oldGrant,reserved[i],tokens[i]]);
  await db.query("insert into benchmark_budget_calls(id,account_id,request_key,model,reserved_tokens,actual_tokens,state,legacy_mission_call_id,provider_request_id,provider_usage) values($1,$2,$3,'gpt-5.3-codex',$4,$5,'settled',$6,$7,$8)",
    [op,account,id,reserved[i],tokens[i],id,'fixture-provider-response-'+i,JSON.stringify({input_tokens:tokens[i]-1000,output_tokens:1000,total_tokens:tokens[i]})]);
  await db.query('insert into benchmark_dollar_exposures(account_id,call_id,exposure_microusd) values($1,$2,$3)',
    [account,op,exposure[i]]);
 }
 await db.query('alter table mission_calls enable trigger user');
 await db.query('update benchmark_native_spending_approvals set consumed_at=now() where id=$1',[approval]);
 await db.query('update benchmark_budget_accounts set spent_tokens=49620 where id=$1',[account]);
 await db.query("update agent_missions set status='blocked',actual_tokens=49620,reserved_tokens=49620,calls=4,routing_calls=0 where id=$1",[mission]);
 await db.query("update mission_assignments set status='failed' where id=$1",[task]);
 await db.query("update work_projects set status='blocked' where id=$1",[project]);
 await db.query("update agent_tasks set status='blocked',external=external||jsonb_build_object('receipt',jsonb_build_object('run_id',42102615797,'outcome','BLOCKED','pr_url',null)) where id=$1",[task]);
 // Existing Task4A chain requires predecessor expiry before a new successor.
 // Simulate natural expiration ONLY in disposable PostgreSQL by constructing
 // the fixture before installing the new read/consent code.
 await db.query('alter table project_continuation_authorizations disable trigger user');
 await db.query("update project_continuation_authorizations set authorized_at=now()-interval '2 hours',deadline=now()-interval '5 minutes' where id=task4a_current_continuation_id($1)",[project]);
 await db.query('alter table project_continuation_authorizations enable trigger user');
 await db.query(readFileSync('supabase/migrations/20261105224500_task4a_postpaid_same_task_continuation.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261106173000_task4a_generic_owner_approval_conflict.sql','utf8'));
 // Validate the ENTIRE install-only migration on a disposable PostgreSQL
 // instance, independently of owner-recovery and concurrency qualification.
 if(process.env.KATIE_TEST_ONLY_TASK4A_POSTPAID_VALIDATE==='1'){
  const compiled=(await db.query(`select p.proname,pg_get_functiondef(p.oid) body
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in
    ('task4a_postpaid_proposal','task4a_postpaid_authorize','benchmark_lifecycle_decide')
    order by p.proname`)).rows;
  assert.deepEqual(compiled.map(x=>x.proname),[
   'benchmark_lifecycle_decide','task4a_postpaid_authorize','task4a_postpaid_proposal']);
  const named=name=>compiled.find(x=>x.proname===name).body;
  assert.match(named('benchmark_lifecycle_decide'),/TASK4A_GENERIC_LIFECYCLE_FORBIDDEN/);
  assert.match(named('task4a_postpaid_proposal'),/mistakenGenericApproval/);
  assert.match(named('task4a_postpaid_proposal'),/wrong\.previous_developer_approval_id/);
  assert.match(named('task4a_postpaid_authorize'),/coalesce\(wrong\.id,a\.id\)/);
  assert.match(named('task4a_postpaid_authorize'),/pg_advisory_xact_lock/);
  await db.query('set role service_role');
  const preview=await rpc(db,'task4a_postpaid_proposal',[
   release,checkpoint,snapshot,{
    cumulativeTokens:289620,developmentTokens:229620,developmentCalls:16,
    assessmentTokens:60000,completionTokens:60000,assessmentCalls:4,completionCalls:4,
    perCallMicrousd:1680000,ceilingMicrousd:9000000,durationSeconds:14400
   }]);
  assert.equal(preview.ready,true,JSON.stringify(preview));
  assert.equal(preview.proposal.settledTokens,49620);
  assert.equal(preview.proposal.newContinuationTokenCap,240000);
  assert.equal(preview.proposal.newContinuationCallCap,24);
  await db.query('commit');
  console.log('TASK4A_FULL_CONFLICT_MIGRATION_POSTGRES_VALIDATED_NO_RECOVERY_OR_DISPATCH');
  return;
 }
 await db.query('set role service_role');
 const limits={cumulativeTokens:240000,developmentTokens:180000,developmentCalls:24,
  assessmentTokens:60000,completionTokens:60000,assessmentCalls:4,completionCalls:4,
  perCallMicrousd:1680000,ceilingMicrousd:6000000,durationSeconds:14400};
 const args=[release,checkpoint,snapshot,limits];
 const offer=await rpc(db,'task4a_postpaid_proposal',args);
 assert.equal(offer.ready,true,JSON.stringify(offer));
 assert.equal(offer.proposal.settledCalls,4);
 assert.equal(offer.proposal.settledTokens,49620);
 assert.equal(offer.proposal.protectedAssessmentTokens,60000);
 assert.equal(offer.proposal.protectedCompletionTokens,60000);
 assert.equal(offer.proposal.checkpointSha,checkpoint);
 assert.ok(offer.digest);
 let auth=[owner,offer.digest,...args];
 await negative(db,()=>rpc(db,'task4a_postpaid_authorize',[randomUUID(),offer.digest,...args]),/TASK4A_POSTPAID_OWNER_CONSENT_DENIED/);
 await negative(db,()=>rpc(db,'task4a_postpaid_authorize',[owner,'0'.repeat(64),...args]),/TASK4A_POSTPAID_OWNER_CONSENT_DENIED/);
 await db.query('savepoint unverified_price');
 await db.query('reset role');
 await db.query("update model_registry set pricing_status='estimated' where model_id='gpt-5.3-codex'");
 await db.query('set role service_role');
 assert.equal((await rpc(db,'task4a_postpaid_proposal',args)).ready,false);
 await db.query('rollback to savepoint unverified_price');
 await db.query('release savepoint unverified_price');
 await db.query('set role service_role');
 assert.equal((await rpc(db,'task4a_postpaid_proposal',[release,checkpoint,snapshot,{...limits,cumulativeTokens:180000}])).ready,false);
 // Recreate November 6's incorrect GENERIC lifecycle approval in this
 // disposable Postgres fixture, preserving the prior paid grant and four calls.
 // This is not a production repair and makes no provider/GitHub request.
 // The parent disposable fixture is already inside a transaction, and a
 // previous negative test explicitly switched this constraint to IMMEDIATE.
 // Restore DEFERRABLE mode for the historical approval+owner decision pair;
 // force it IMMEDIATE after all evidence is written to prove the real guard.
 // No constraint triggers are disabled or bypassed.
 await db.query('set constraints developer_approval_decision deferred');
 await db.query('reset role');
 const genericLimits={...limits,cumulativeTokens:180000,developmentTokens:120000,
  developmentCalls:16,ceilingMicrousd:2520000,durationSeconds:86400};
 await db.query(`insert into benchmark_lifecycle_proposals
  (id,owner_id,task_id,project_id,snapshot_hash,fingerprint,proposal,checkpoint,expires_at)
  values($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '1 hour')`,
  [wrongProposal,owner,task,project,'e'.repeat(64),wrongProposal,
   JSON.stringify({version:'lifecycle-owner-proposal-v1',proposed:genericLimits}),
   JSON.stringify({approvalId:approval,runId:'42102615797'})]);
 await db.query(`insert into benchmark_native_spending_approvals(
  id,owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,
  max_tokens,deadline,project_id,mission_assignment_id,task_id,developer_authority,
  previous_developer_approval_id,developer_proposal_id)
  select $1,owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,
   180000,now()+interval '24 hours',project_id,mission_assignment_id,task_id,
   developer_authority||jsonb_build_object('limits',$2::jsonb,
    'checkpoint',jsonb_build_object('approvalId',id,'runId','42102615797')),
   id,$3 from benchmark_native_spending_approvals where id=$4`,
  [wrong,JSON.stringify(genericLimits),wrongProposal,approval]);
 await db.query(`insert into benchmark_lifecycle_decisions(
   proposal_id,owner_id,decision,developer_approval_id)
   values($1,$2,'approved',$3)`,[wrongProposal,owner,wrong]);
 await db.query(`insert into project_events(id,project_id,event,data)
   values($1,$2,'lifecycle_amendment_authorized',
    jsonb_build_object('taskId',$3::uuid,'ownerId',$4::uuid,'approvalId',$5::uuid,
     'previousApprovalId',$6::uuid,'proposalId',$7::text,'limits',$8::jsonb))`,
   [wrongReceipt,project,task,owner,wrong,approval,wrongProposal,JSON.stringify(genericLimits)]);
 await db.query('set constraints developer_approval_decision immediate');
 await db.query("update benchmark_execution_grants set stopped_at=clock_timestamp() where developer_approval_id=$1",[approval]);
 await db.query(`update work_projects set status='running',
    deadline=(select deadline from benchmark_native_spending_approvals where id=$2)
    where id=$1`,[project,wrong]);
 await db.query(`update agent_missions set status='running',
    deadline=(select deadline from project_continuation_authorizations
      where id=task4a_current_continuation_id($1))
    where id=$2`,[project,mission]);
 await db.query("update mission_assignments set status='waiting_external' where id=$1",[task]);
 await db.query(`update agent_tasks set status='dispatching',
    external=(external-'developerReleaseSha')||
     jsonb_build_object('developerApprovalId',$2::text,'lifecycleProposalId',$3::text)
    where id=$1`,[task,wrong,wrongProposal]);
 await db.query('set role service_role');
 const conflict=await rpc(db,'task4a_postpaid_proposal',args);
 assert.equal(conflict.ready,true,JSON.stringify(conflict));
 assert.equal(conflict.proposal.mistakenGenericApproval.approvalId,wrong);
 assert.equal(conflict.proposal.mistakenGenericApproval.receiptId,wrongReceipt);
 assert.equal(conflict.proposal.settledTokens,49620);
 assert.notEqual(conflict.digest,offer.digest,'Mistaken lifecycle record changes owner consent digest');
 auth=[owner,conflict.digest,...args];
 await negative(db,()=>rpc(db,'benchmark_lifecycle_decide',
  [owner,task,wrongProposal,'approved',release]),/TASK4A_GENERIC_LIFECYCLE_FORBIDDEN/);
 await negative(db,()=>rpc(db,'task4a_postpaid_authorize',
  [randomUUID(),conflict.digest,...args]),/TASK4A_POSTPAID_OWNER_CONSENT_DENIED/);
 await negative(db,()=>rpc(db,'task4a_postpaid_authorize',
  [owner,offer.digest,...args]),/TASK4A_POSTPAID_OWNER_CONSENT_DENIED/);
 await db.query('savepoint generic_expired');
 await db.query('reset role');
 await db.query("update benchmark_native_spending_approvals set deadline=now()-interval '1 second' where id=$1",[wrong]);
 await db.query('set role service_role');
 assert.equal((await rpc(db,'task4a_postpaid_proposal',args)).ready,false,
  'Expired generic authority must never qualify for correction');
 await db.query('rollback to savepoint generic_expired');
 await db.query('release savepoint generic_expired');
 await db.query('set role service_role');
 // Synthetic fixture is committed ONLY to the ephemeral isolated test server.
 await db.query('commit');
 const rivals=await Promise.all([connect(),connect()]);
 try{
  await Promise.all(rivals.map(c=>c.query('set role service_role')));
  const answers=await Promise.allSettled(rivals.map(c=>rpc(c,'task4a_postpaid_authorize',auth)));
  console.log('TASK4A_POSTPAID_CONSENT_RACE_DIAGNOSTICS',JSON.stringify(answers.map(x=>x.status==='rejected'?{status:x.status,sqlstate:x.reason?.code,error:String(x.reason?.message).slice(0,350)}:{status:x.status,authorized:x.value?.authorized})));
  assert.equal(answers.filter(x=>x.status==='fulfilled'&&x.value.authorized===true).length,1,
   'One and only one successor may survive two concurrent approvals');
  assert.equal(answers.filter(x=>x.status==='rejected').length,1);
  assert.equal((await one(db,"select count(*)::int n from project_events where project_id=$1 and event='task4a_postpaid_owner_authorized'",[project])).n,1);
  assert.equal((await one(db,'select count(*)::int n from benchmark_budget_calls where account_id=$1',[account])).n,4);
  assert.equal((await one(db,'select spent_tokens from benchmark_budget_accounts where id=$1',[account])).spent_tokens.toString(),'49620');
  assert.equal((await one(db,'select count(*)::int n from benchmark_execution_grants where project_id=$1',[project])).n,1);
  assert.equal((await one(db,'select status from agent_tasks where id=$1',[task])).status,'blocked');
  assert.equal((await one(db,'select status from work_projects where id=$1',[project])).status,'blocked');
  assert.equal((await one(db,'select status from agent_missions where id=$1',[mission])).status,'blocked');
  assert.equal((await one(db,'select status from mission_assignments where id=$1',[task])).status,'failed');
  const newApproval=(await one(db,"select (data->>'newApprovalId')::uuid as id from project_events where project_id=$1 and event='task4a_postpaid_owner_authorized'",[project])).id;
  assert.equal((await one(db,'select previous_developer_approval_id from benchmark_native_spending_approvals where id=$1',[newApproval])).previous_developer_approval_id,wrong);
  assert.ok((await one(db,'select revoked_at from benchmark_native_spending_approvals where id=$1',[wrong])).revoked_at,
   "Generic approval remains auditable but is revoked by the owner\'s exact successor");
  assert.equal((await one(db,'select count(*)::int n from project_events where id=$1',[wrongReceipt])).n,1);
  assert.equal((await one(db,'select count(*)::int n from benchmark_lifecycle_decisions where proposal_id=$1 and decision=\'approved\'',[wrongProposal])).n,1);
  const dates=await one(db,'select p.deadline project_deadline,m.deadline mission_deadline from work_projects p join agent_missions m on m.id=p.active_mission_id where p.id=$1',[project]);
  assert.equal(String(dates.project_deadline),String(dates.mission_deadline));
  const successor=await one(db,'select a.* from project_continuation_authorizations a where a.id=task4a_current_continuation_id($1)',[project]);
  assert.equal(Number(successor.assessment_reserve_tokens),60000);
  assert.equal(Number(successor.completion_reserve_tokens),60000);
  assert.equal(successor.assessment_reserve_calls,6);
  assert.equal(successor.completion_reserve_calls,6);
  assert.equal((await rpc(db,'task4a_postpaid_proposal',args)).ready,false,'No second successor');
  // Savepoints require an explicit transaction; make prior owner receipts
  // visible to both fresh PostgreSQL clients before their one-shot claim race.
  await db.query('begin');
  const dispatch=await rpc(db,'task4a_postpaid_redispatch_proposal',[release]);
  assert.equal(dispatch.ready,true,JSON.stringify(dispatch));
  await negative(db,()=>rpc(db,'task4a_postpaid_authorize_redispatch',[randomUUID(),dispatch.digest,release]),/TASK4A_POSTPAID_REDISPATCH_DENIED/);
  assert.equal((await rpc(db,'task4a_postpaid_paid_proposal',[release])).ready,false);
  const d=await rpc(db,'task4a_postpaid_authorize_redispatch',[owner,dispatch.digest,release]);
  assert.equal(d.dispatched,false);
  await db.query('savepoint postpaid_expired_authority');
  await db.query('reset role');
  await db.query("update benchmark_native_spending_approvals set deadline=now()-interval '1 second' where id=(select (data->>'newApprovalId')::uuid from project_events where project_id=$1 and event='task4a_postpaid_owner_authorized')",[project]);
  await db.query('set role service_role');
  assert.equal((await rpc(db,'task4a_postpaid_paid_proposal',[release])).ready,false,'Expired authority must fail closed');
  await db.query('rollback to savepoint postpaid_expired_authority');
  await db.query('release savepoint postpaid_expired_authority');
  await db.query('savepoint postpaid_unavailable_model');
  await db.query('reset role');
  await db.query("update model_registry set is_active=false where provider_name='openai' and model_id='gpt-5.3-codex'");
  await db.query('set role service_role');
  assert.equal((await rpc(db,'task4a_postpaid_paid_proposal',[release])).ready,false,'Unavailable Codex must fail closed');
  await db.query('rollback to savepoint postpaid_unavailable_model');
  await db.query('release savepoint postpaid_unavailable_model');
  await db.query('set role service_role');
  const paid=await rpc(db,'task4a_postpaid_paid_proposal',[release]);
  assert.equal(paid.ready,true,JSON.stringify(paid));
  assert.notEqual(paid.digest,dispatch.digest);
  await negative(db,()=>rpc(db,'task4a_postpaid_authorize_paid',[owner,'a'.repeat(64),release]),/TASK4A_POSTPAID_PAID_INFERENCE_DENIED/);
  assert.equal(await rpc(db,'task4a_postpaid_claim',[release]),false,'Paid approval missing');
  assert.equal((await rpc(db,'task4a_postpaid_authorize_paid',[owner,paid.digest,release])).authorized,true);
  await db.query('commit');
  const claims=await Promise.all(rivals.map(c=>rpc(c,'task4a_postpaid_claim',[release])));
  assert.equal(claims.filter(Boolean).length,1,'Only one one-shot claim');
  assert.equal((await rpc(db,'task4a_postpaid_record_submitted',[release])),true);
  assert.equal((await rpc(db,'task4a_postpaid_record_submitted',[release])),false);
  assert.equal((await one(db,'select count(*)::int n from benchmark_budget_calls where account_id=$1',[account])).n,4);
  assert.equal((await one(db,'select count(*)::int n from benchmark_execution_grants where project_id=$1',[project])).n,1);
  console.log('TASK4A_POSTPAID_TWO_CONNECTION_OWNER_CLAIM_POSTGRES_PASS');
 }finally{await Promise.allSettled(rivals.map(c=>c.end()));}
}

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
const project='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const mission='d3fd3d95-7287-4bfc-8c97-c105fde46c36';
const task='d0e41ff5-149e-4319-9e65-dcc605fb75da';
const checkpoint='8e53ce01693303fc50daf5da1567e93e725f9b2d';
const release='d530aa94dd8d9c2bc442b43b324ace312d0d62b9';
const snapshot='f'.repeat(64);
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
 await db.query(readFileSync('supabase/migrations/20261105224500_task4a_postpaid_same_task_continuation.sql','utf8'));
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
 const auth=[owner,offer.digest,...args];
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
 // Synthetic fixture is committed ONLY to the ephemeral isolated test server.
 await db.query('commit');
 const rivals=await Promise.all([connect(),connect()]);
 try{
  await Promise.all(rivals.map(c=>c.query('set role service_role')));
  const answers=await Promise.allSettled(rivals.map(c=>rpc(c,'task4a_postpaid_authorize',auth)));
  assert.equal(answers.filter(x=>x.status==='fulfilled'&&x.value.authorized===true).length,1,
   'One and only one successor may survive two concurrent approvals');
  assert.equal(answers.filter(x=>x.status==='rejected').length,1);
  assert.equal((await one(db,"select count(*)::int n from project_events where project_id=$1 and event='task4a_postpaid_owner_authorized'",[project])).n,1);
  assert.equal((await one(db,'select count(*)::int n from benchmark_budget_calls where account_id=$1',[account])).n,4);
  assert.equal((await one(db,'select spent_tokens from benchmark_budget_accounts where id=$1',[account])).spent_tokens.toString(),'49620');
  assert.equal((await one(db,'select count(*)::int n from benchmark_execution_grants where project_id=$1',[project])).n,1);
  assert.equal((await one(db,'select status from agent_tasks where id=$1',[task])).status,'blocked');
  const successor=await one(db,'select a.* from project_continuation_authorizations a where a.id=task4a_current_continuation_id($1)',[project]);
  assert.equal(Number(successor.assessment_reserve_tokens),60000);
  assert.equal(Number(successor.completion_reserve_tokens),60000);
  assert.equal(successor.assessment_reserve_calls,6);
  assert.equal(successor.completion_reserve_calls,6);
  assert.equal((await rpc(db,'task4a_postpaid_proposal',args)).ready,false,'No second successor');
  const dispatch=await rpc(db,'task4a_postpaid_redispatch_proposal',[release]);
  assert.equal(dispatch.ready,true,JSON.stringify(dispatch));
  await negative(db,()=>rpc(db,'task4a_postpaid_authorize_redispatch',[randomUUID(),dispatch.digest,release]),/TASK4A_POSTPAID_REDISPATCH_DENIED/);
  assert.equal((await rpc(db,'task4a_postpaid_paid_proposal',[release])).ready,false);
  const d=await rpc(db,'task4a_postpaid_authorize_redispatch',[owner,dispatch.digest,release]);
  assert.equal(d.dispatched,false);
  const paid=await rpc(db,'task4a_postpaid_paid_proposal',[release]);
  assert.equal(paid.ready,true,JSON.stringify(paid));
  assert.notEqual(paid.digest,dispatch.digest);
  await negative(db,()=>rpc(db,'task4a_postpaid_authorize_paid',[owner,'a'.repeat(64),release]),/TASK4A_POSTPAID_PAID_INFERENCE_DENIED/);
  assert.equal(await rpc(db,'task4a_postpaid_claim',[release]),false,'Paid approval missing');
  assert.equal((await rpc(db,'task4a_postpaid_authorize_paid',[owner,paid.digest,release])).authorized,true);
  const claims=await Promise.all(rivals.map(c=>rpc(c,'task4a_postpaid_claim',[release])));
  assert.equal(claims.filter(Boolean).length,1,'Only one one-shot claim');
  assert.equal((await rpc(db,'task4a_postpaid_record_submitted',[release])),true);
  assert.equal((await rpc(db,'task4a_postpaid_record_submitted',[release])),false);
  assert.equal((await one(db,'select count(*)::int n from benchmark_budget_calls where account_id=$1',[account])).n,4);
  assert.equal((await one(db,'select count(*)::int n from benchmark_execution_grants where project_id=$1',[project])).n,1);
  console.log('TASK4A_POSTPAID_TWO_CONNECTION_OWNER_CLAIM_POSTGRES_PASS');
 }finally{await Promise.allSettled(rivals.map(c=>c.end()));}
}

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const project='6d1c29f1-b31e-47a5-aabb-cbcf1326f388',task='d0e41ff5-149e-4319-9e65-dcc605fb75da',mission='d3fd3d95-7287-4bfc-8c97-c105fde46c36';
const replacement='2cbdbff0-cc11-4dd8-8a62-95b0e8ae2534',release='e'.repeat(40);
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const rpc=async(db,name,args)=>(await one(db,'select '+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') v',args)).v;
const denied=async(db,fn,pattern)=>{await db.query('savepoint denied_capacity');try{await assert.rejects(fn(),pattern);}finally{await db.query('rollback to savepoint denied_capacity');await db.query('release savepoint denied_capacity');}};
export async function verifyTask4aCapacityPostgres(db,{connect,owner,account,approval}){
 // Reproduce the next failed paid run ONLY in disposable PG, before installing
 // new code. No operation here contacts a provider or a production database.
 await db.query('reset role');
 const prior=(await one(db,'select developer_authority from benchmark_native_spending_approvals where id=$1',[approval])).developer_authority;
 const continuation=prior.task4aContinuationId;
 const grant=await one(db,'select * from benchmark_execution_grants where developer_approval_id=$1',[approval]);
 await db.query('alter table project_events disable trigger user');
 await db.query("update project_events set id=$2 where project_id=$1 and event='task4a_replacement_claimed'",[project,replacement]);
 await db.query('alter table project_events enable trigger user');
 await db.query('alter table project_continuation_authorizations disable trigger user');
 await db.query("update project_continuation_authorizations set authorized_at=now()-interval '5 hours',deadline=now()-interval '1 hour' where id=$1",[continuation]);
 await db.query('alter table project_continuation_authorizations enable trigger user');
 await db.query('alter table benchmark_native_spending_approvals disable trigger user');
 await db.query("update benchmark_native_spending_approvals set deadline=now()-interval '1 hour' where id=$1",[approval]);
 await db.query('alter table benchmark_native_spending_approvals enable trigger user');
 await db.query('alter table mission_calls disable trigger user');
 for(const [i,tokens] of [13000,13000,12000,15005].entries()){
  const id=randomUUID(),op=randomUUID(),cost=i===3?30831:25000;
  await db.query("insert into mission_calls(id,job_id,lease,model,reserved_tokens,actual_tokens,status,project_continuation_id,project_actual_microusd) values($1,$2,$3,'gpt-5.3-codex',$4,$4,'completed',$5,$6)",[id,task,grant.id,tokens,continuation,cost]);
  await db.query("insert into benchmark_budget_calls(id,account_id,request_key,model,reserved_tokens,actual_tokens,state,legacy_mission_call_id,provider_request_id,provider_usage) values($1,$2,$3,'gpt-5.3-codex',$4,$4,'settled',$5,$6,$7)",[op,account,id,tokens,id,'fixture-latest-'+i,{input_tokens:tokens-1000,output_tokens:1000,total_tokens:tokens}]);
  await db.query('insert into benchmark_dollar_exposures(account_id,call_id,exposure_microusd) values($1,$2,$3)',[account,op,cost]);
 }
 await db.query('alter table mission_calls enable trigger user');
 await db.query('update benchmark_budget_accounts set spent_tokens=102625 where id=$1',[account]);
 await db.query("update agent_missions set status='blocked',actual_tokens=102625,reserved_tokens=102625,calls=8,routing_calls=0,deadline=now()-interval '1 hour' where id=$1",[mission]);
 await db.query("update work_projects set status='blocked',deadline=now()-interval '1 hour' where id=$1",[project]);
 await db.query("update mission_assignments set status='failed' where id=$1",[task]);
 await db.query("update agent_tasks set status='blocked',external=external||jsonb_build_object('task4aReplacementClaimId',$2::text,'receipt',jsonb_build_object('run_id',42405698589,'outcome','BLOCKED','pr_url',null)) where id=$1",[task,replacement]);
 const original=readFileSync('supabase/migrations/20261101160000_ordinary_developer_authority.sql','utf8');
 const at=original.indexOf('create function developer_claim_dispatch('),end=original.indexOf('end $$;',at);
 assert.ok(at>=0&&end>at);await db.query(original.slice(at,end+7).replace('create function','create or replace function'));
 await db.query(readFileSync('supabase/migrations/20261107204151_task4a_capacity_only_successor.sql','utf8'));
 const checkpoint={checkpointSha:'2667a81d4f18452e9ca59498c8805670b04cfe47',runId:'42405698589',approvalId:approval,scopeHash:'debdfd441a9bb6b1106d2e09c56b6e7a2c494ce81f23890e104a625c8633c685',releaseSha:'3c148a4ea9a2f8bee9d35b7e430eee0f66ff58a0',sourceTreeSha:'26869fb977fd29b4f96652b9de3d47e0f0e0ffeb',completedCheckpointSha:'49c8a5f791e66c351436bb97839193b53d7a1cd1',grantId:grant.id};
 const history=await db.query('select id,event,data from project_events where project_id=$1 order by id',[project]);
 const before=(await one(db,'select to_jsonb(a) a from benchmark_native_spending_approvals a where id=$1',[approval])).a;
 const continuationBefore=(await one(db,'select to_jsonb(a) a from project_continuation_authorizations a where id=$1',[continuation])).a;
 const ledgers=async()=>({calls:(await db.query('select to_jsonb(c) c from benchmark_budget_calls c where account_id=$1 order by id',[account])).rows,exposures:(await db.query('select to_jsonb(e) e from benchmark_dollar_exposures e where account_id=$1 order by call_id',[account])).rows,grants:(await db.query('select to_jsonb(g) g from benchmark_execution_grants g where account_id=$1 order by id',[account])).rows});
 const ledgerBefore=await ledgers();
 await db.query('set role service_role');
 const offer=await rpc(db,'task4a_capacity_proposal',[release,checkpoint]);assert.equal(offer.ready,true,JSON.stringify(offer));
 assert.equal((await one(db,"select prosecdef v from pg_proc where oid='public.task4a_capacity_authorize(uuid,text,text,jsonb)'::regprocedure")).v,true,'Consent uses narrow privileged RPC');
 for(const table of ['benchmark_lifecycle_proposals','benchmark_lifecycle_decisions'])assert.equal((await one(db,"select has_table_privilege('service_role',$1,'INSERT') v",[table])).v,false,'No broad lifecycle INSERT permission');
 assert.equal(offer.proposal.remainingNativeCalls,8);assert.equal(offer.proposal.remainingNativeTokens,66995);
 for(const role of ['anon','authenticated'])assert.equal((await one(db,"select has_function_privilege($1,'public.task4a_capacity_authorize(uuid,text,text,jsonb)','EXECUTE') v",[role])).v,false);
 await db.query('begin');
 await denied(db,()=>rpc(db,'task4a_capacity_authorize',[randomUUID(),offer.digest,release,checkpoint]),/CONSENT_DENIED/);
 await denied(db,()=>rpc(db,'task4a_capacity_authorize',[owner,'0'.repeat(64),release,checkpoint]),/CONSENT_DENIED/);
 for(const patch of [{runId:'42102615797'},{checkpointSha:'0'.repeat(40)},{scopeHash:'0'.repeat(64)},{grantId:randomUUID()}])assert.equal((await rpc(db,'task4a_capacity_proposal',[release,{...checkpoint,...patch}])).ready,false);
 for(const [sql,args] of [
  ["update benchmark_budget_calls set state='uncertain' where id=(select id from benchmark_budget_calls where account_id=$1 limit 1)",[account]],
  ["update benchmark_dollar_exposures set exposure_microusd=exposure_microusd+1 where call_id=(select call_id from benchmark_dollar_exposures where account_id=$1 limit 1)",[account]],
  ["update work_projects set approved_hash=repeat('0',64) where id=$1",[project]],
  ["update work_projects set completion_contract=jsonb_build_object('changedForCapacityTest',true) where id=$1",[project]],
  ["update agent_missions set routing_calls=1 where id=$1",[mission]],
  ["update model_registry set pricing_verified_at=now()-interval '2 days' where provider_name='openai' and model_id='gpt-5.3-codex'",[]],
  ["update model_registry set pricing_verified_at=null where provider_name='openai' and model_id='gpt-5.3-codex'",[]]
 ]){
  await db.query('savepoint changed_capacity');await db.query('reset role');
  // Production normally regenerates this field; simulate corruption solely
  // inside the disposable savepoint to exercise the new binding comparison.
  if(sql.includes('set completion_contract='))await db.query('alter table work_projects disable trigger user');
  await db.query(sql,args);await db.query('set role service_role');
  assert.equal((await rpc(db,'task4a_capacity_proposal',[release,checkpoint])).ready,false,'Changed evidence denies stale consent: '+sql);
  await denied(db,()=>rpc(db,'task4a_capacity_authorize',[owner,offer.digest,release,checkpoint]),/CONSENT_DENIED/);
  await db.query('rollback to savepoint changed_capacity');await db.query('release savepoint changed_capacity');
 }
 await db.query('commit');
 const clients=await Promise.all([connect(),connect()]);
 try{
  for(const c of clients)await c.query('set role service_role');
  const decisions=await Promise.all(clients.map(c=>rpc(c,'task4a_capacity_authorize',[owner,offer.digest,release,checkpoint])));
  assert.deepEqual(decisions[0],decisions[1],'Concurrent replay returns same IDs and immutable deadline');
  const result=decisions[0];assert.equal(result.dispatchAuthorized,false);assert.equal(result.paidInferenceAuthorized,false);
  assert.ok(Date.parse(result.deadline)>Date.now()+14390000&&Date.parse(result.deadline)<=Date.now()+14401000,'Four hours begins at real consent commit');
  assert.deepEqual(await rpc(db,'task4a_capacity_authorize',[owner,offer.digest,release,checkpoint]),result);
  assert.equal((await one(db,"select count(*)::int n from project_events where project_id=$1 and event='task4a_capacity_owner_authorized'",[project])).n,1);
  const fresh=(await one(db,'select to_jsonb(a) a from benchmark_native_spending_approvals a where id=$1',[result.approvalId])).a;
  assert.deepEqual(fresh.developer_authority.limits,{...before.developer_authority.limits,developmentCalls:20});
  assert.equal(fresh.previous_developer_approval_id,approval);assert.equal(fresh.consumed_at,null);assert.equal(fresh.max_tokens,before.max_tokens);
  assert.equal(fresh.model,before.model);assert.equal(fresh.account_id,before.account_id);
  assert.deepEqual(fresh.developer_authority.binding,before.developer_authority.binding);assert.deepEqual(fresh.developer_authority.completionContract,before.developer_authority.completionContract);
  const successor=(await one(db,'select to_jsonb(a) a from project_continuation_authorizations a where id=$1',[result.continuationId])).a;
  assert.equal(successor.predecessor_id,continuation);
  for(const k of ['assessment_reserve_tokens','completion_reserve_tokens','assessment_reserve_calls','completion_reserve_calls','allowed_models'])assert.deepEqual(successor[k],continuationBefore[k]);
  assert.equal(Number(successor.incremental_tokens),186995);assert.equal(successor.incremental_calls,20);assert.equal(Number(successor.incremental_microusd),8894169);
  assert.equal(Number(successor.historical_tokens),Number(continuationBefore.historical_tokens)+53005);assert.equal(successor.historical_calls,continuationBefore.historical_calls+4);
  assert.deepEqual((await one(db,'select to_jsonb(a) a from benchmark_native_spending_approvals a where id=$1',[approval])).a,before);
  assert.deepEqual((await one(db,'select to_jsonb(a) a from project_continuation_authorizations a where id=$1',[continuation])).a,continuationBefore);
  assert.deepEqual(await ledgers(),ledgerBefore,'No accounting, provider call or grant mutation');
  assert.deepEqual((await db.query("select id,event,data from project_events where project_id=$1 and event<>'task4a_capacity_owner_authorized' order by id",[project])).rows,history.rows);
  const state=await one(db,'select p.status p,m.status m,t.status t,j.status j,m.calls,m.actual_tokens from work_projects p join agent_missions m on m.id=p.active_mission_id join agent_tasks t on t.id=$2 join mission_assignments j on j.id=t.id where p.id=$1',[project,task]);
  assert.deepEqual(state,{p:'blocked',m:'blocked',t:'blocked',j:'failed',calls:8,actual_tokens:102625});
  assert.equal(await rpc(db,'developer_claim_dispatch',[result.approvalId,release]),false);
  assert.equal(await rpc(db,'developer_gateway_execution_live',[grant.token_digest,project,grant.execution_epoch]),false);
  await db.query('begin');
  await denied(db,()=>rpc(db,'developer_issue_execution_grant',[result.approvalId,task,'b'.repeat(64),release]),/dispatch binding/);
  await denied(db,()=>rpc(db,'task4a_capacity_authorize',[randomUUID(),offer.digest,release,checkpoint]),/CONSENT_DENIED/);
  await db.query('reset role');
  await denied(db,()=>db.query("update project_events set data='{}' where project_id=$1 and event='task4a_capacity_owner_authorized'",[project]),/IMMUTABLE/);
  await db.query("update work_projects set status='running' where id=$1",[project]);await db.query("update agent_missions set status='running' where id=$1",[mission]);
  await db.query("update agent_tasks set external=external||jsonb_build_object('developerReleaseSha',$2::text) where id=$1",[task,release]);
  await db.query("insert into project_events(project_id,event,data) values($1,'developer_native_dispatch_claimed',jsonb_build_object('approvalId',$2::text,'releaseSha',$3::text))",[project,result.approvalId,release]);
  await db.query('set role service_role');
  assert.equal(await rpc(db,'developer_claim_dispatch',[result.approvalId,release]),false);
  await denied(db,()=>rpc(db,'developer_issue_execution_grant',[result.approvalId,task,'b'.repeat(64),release]),/CAPACITY_ONLY_EXECUTION_FORBIDDEN/);
  await db.query('rollback');
  console.log('TASK4A_CAPACITY_ONLY_REAL_POSTGRES_TWO_CONNECTION_CONSENT_AND_EXECUTION_DENIAL_PASS');
 }finally{await Promise.allSettled(clients.map(c=>c.end()));}
}

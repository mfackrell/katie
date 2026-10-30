import {assertRenewalCompletionLifecycle} from './assert-renewal-completion-lifecycle.mjs';
import {assertAmendmentSuccessor} from './assert-amendment-successor.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

// Disposable PostgreSQL fixture only. This is not production authorization,
// inference, game implementation, or evidence of functional acceptance.
export async function assertCompletionBudgetControls(db,rival,{project,mission,task,grant,trial,owner}){
 const account=grant.account_id,release='6'.repeat(40),runtime='provider-input-count-v1';
 await db.query('reset role');
 // Reproduce the current checkpoint: expired executed predecessor, followed by
 // an unused ordinary renewal. Historical fixture amounts normalize to195941.
 await db.query('alter table benchmark_full_continuations disable trigger benchmark_continuation_immutable');
 await db.query("update benchmark_full_continuations set created_at=now()-interval '5 hours',deadline=now()-interval '1 hour' where id=$1",[grant.continuation_id]);
 await db.query('alter table benchmark_full_continuations enable trigger benchmark_continuation_immutable');
 await db.query("update benchmark_native_spending_approvals set deadline=now()-interval '1 hour' where continuation_id=$1",[grant.continuation_id]);
 await db.query("update benchmark_execution_grants set deadline=now()-interval '1 hour' where continuation_id=$1",[grant.continuation_id]);
 const delta=195941-Number((await db.query('select spent_tokens from benchmark_budget_accounts where id=$1',[account])).rows[0].spent_tokens);
 await db.query("update benchmark_budget_calls set actual_tokens=actual_tokens+$2,reserved_tokens=greatest(reserved_tokens,actual_tokens+$2) where id=(select id from benchmark_budget_calls where account_id=$1 and legacy_mission_call_id is null order by created_at limit 1)",[account,delta]);
 await db.query('update benchmark_budget_accounts set spent_tokens=195941 where id=$1',[account]);
 await db.query("update work_projects set deadline=now()+interval '8 hours' where id=$1",[project]);
 await db.query('set role service_role');
 const ordinary='select benchmark_dashboard_continuation($1,$2,$3,$4) r';
 const offer=(await db.query(ordinary,[owner,null,null,false])).rows[0].r;
 assert.equal(offer.approved,false);
 await db.query(ordinary,[owner,project,offer.planHash,true]);
 await db.query("update agent_tasks set status='blocked' where id=$1",[task]);
 await db.query("update mission_assignments set status='failed' where id=$1",[task]);
 await db.query("update agent_missions set status='blocked' where id=$1",[mission]);
 await db.query("update work_projects set status='blocked' where id=$1",[project]);
 await db.query('reset role');
 await db.query(readFileSync('supabase/migrations/20261030143925_benchmark_cumulative_execution_controls.sql','utf8'));
 await db.query('set role service_role');
 const snapshot=async()=>(await db.query(`select jsonb_build_object('account',(select to_jsonb(a) from benchmark_budget_accounts a where id=$1),'calls',(select jsonb_agg(to_jsonb(b) order by id) from benchmark_budget_calls b where account_id=$1),'approvals',(select jsonb_agg(to_jsonb(x) order by id) from benchmark_native_spending_approvals x where account_id=$1),'continuations',(select jsonb_agg(to_jsonb(x) order by id) from benchmark_full_continuations x where account_id=$1)) s`,[account])).rows[0].s;
 const before=await snapshot();
 const rpc='select benchmark_dashboard_development_amendment($1,$2,$3,$4,$5,$6) r';
 const args=[owner,null,null,false,release,runtime];
 const plan=(await db.query(rpc,args)).rows[0].r;
 assert.ok(plan,'exact current checkpoint must produce an offer');
 assert.equal(plan.approved,false);assert.equal(plan.deadline,null);
 assert.equal(plan.plan.cumulativeTokenCap,550000);assert.equal(plan.plan.developmentRemainingTokens,294059);
 assert.equal(plan.plan.assessmentTokens,60000);assert.equal(plan.plan.callsRemaining,15);
 assert.equal(plan.plan.dollarCeilingMicrousd,10000000);assert.equal(plan.plan.durationSeconds,14400);
 assert.deepEqual(await snapshot(),before,'GET must not activate or alter historical authority');
 assert.equal((await db.query('select benchmark_effective_account_cap($1) n',[account])).rows[0].n,'350000');
 await assert.rejects(db.query(rpc,[randomUUID(),...args.slice(1)]),/owner/);
 await assert.rejects(db.query(rpc,[owner,project,'f'.repeat(64),true,release,runtime]),/exact current/);
 const approve=[owner,project,plan.planHash,true,release,runtime];
 const approved=await Promise.all([db.query(rpc,approve),rival.query(rpc,approve)]);
 const c=approved[0].rows[0].r;assert.equal(c.id,approved[1].rows[0].r.id);
 const am=(await db.query('select * from benchmark_development_resource_amendments where continuation_id=$1',[c.id])).rows[0];
 const record=(await db.query('select * from benchmark_full_continuations where id=$1',[c.id])).rows[0];
 assert.equal(record.deadline.getTime()-record.created_at.getTime(),14400000);
 assert.equal((await db.query('select benchmark_effective_account_cap($1) n',[account])).rows[0].n,'550000');
 const after=await snapshot();assert.deepEqual(after.account,before.account);assert.deepEqual(after.calls,before.calls);
 for(const old of before.approvals){const updated=after.approvals.find(x=>x.id===old.id);if(old.id===plan.plan.previousApprovalId){assert.ok(updated.revoked_at);assert.deepEqual({...updated,revoked_at:old.revoked_at},old);assert.deepEqual(am.source_snapshot.approval,old);}else assert.deepEqual(updated,old);}
 for(const old of before.continuations)assert.deepEqual(after.continuations.find(x=>x.id===old.id),old);
 const fresh=(await db.query('select * from benchmark_native_spending_approvals where id=$1',[am.approval_id])).rows[0];assert.equal(Number(fresh.max_tokens),550000);
 assert.equal((await db.query('select benchmark_development_amendment_ready($1,$2) ok',[am.id,release])).rows[0].ok,true);
 const claim=await Promise.all([db.query('select benchmark_claim_development_amendment($1,$2) ok',[am.id,release]),rival.query('select benchmark_claim_development_amendment($1,$2) ok',[am.id,release])]);assert.equal(claim.filter(x=>x.rows[0].ok).length,1);
 const issue='select benchmark_issue_development_amendment_grant($1,$2,$3,$4,$5) r';
 const granted=await Promise.allSettled([db.query(issue,[am.id,'7'.repeat(64),am.approval_id,task,release]),rival.query(issue,[am.id,'8'.repeat(64),am.approval_id,task,release])]);
 assert.equal(granted.filter(x=>x.status==='fulfilled').length,1);
 const gid=granted.find(x=>x.status==='fulfilled').value.rows[0].r.grantId;
 const g=(await db.query('select * from benchmark_execution_grants where id=$1',[gid])).rows[0];
 if(process.env.KATIE_TEST_AMENDMENT_SUCCESSOR==='1'){await assertAmendmentSuccessor(db,rival,{am,g,project,mission,task,trial,owner,account});return;}
 const reserve='select benchmark_full_native_reserve($1,$2,$3,$4,$5,$6) id';
 const native=(client,tokens)=>client.query(reserve,[g.token_digest,trial,g.execution_epoch,randomUUID(),'gpt-5.3-codex',tokens]);
 await assert.rejects(db.query(reserve,[grant.token_digest,trial,grant.execution_epoch,randomUUID(),'gpt-5.3-codex',1]),/unauthorized/);
 // Pricing denial must roll back all token/call/dollar counters atomically.
 for(const sql of ["pricing_status='unknown'","pricing_verified_at=now()-interval '25 hours'","pricing_input_per_1m=null","pricing_output_per_1m=29"]){
  await db.query('begin');await db.query('update model_registry set '+sql+" where provider_name='openai' and model_id='gpt-5.3-codex'");
  await assert.rejects(native(db,100),/pricing|admission/);await db.query('rollback');
 }
 // Fractional prices reserve and settle with identical upward rounding.
 await db.query('reset role');await db.query('begin');
 const firstExposure=(await db.query('select call_id from benchmark_dollar_exposures where account_id=$1 order by call_id limit 1',[account])).rows[0].call_id;
 const totalExposure=Number((await db.query('select sum(exposure_microusd) n from benchmark_dollar_exposures where account_id=$1',[account])).rows[0].n);
 await db.query('update benchmark_dollar_exposures set exposure_microusd=exposure_microusd+$2 where call_id=$1',[firstExposure,10000000-13.5-totalExposure]);
 await db.query("update model_registry set pricing_input_per_1m=1,pricing_output_per_1m=13.5 where provider_name='openai' and model_id='gpt-5.3-codex'");
 await db.query('set role service_role');await db.query('savepoint fractional_limit');
 await assert.rejects(native(db,1),/dollar ceiling/);await db.query('rollback to savepoint fractional_limit');
 await db.query('reset role');await db.query('update benchmark_dollar_exposures set exposure_microusd=exposure_microusd-0.5 where call_id=$1',[firstExposure]);await db.query('set role service_role');
 const fraction=(await native(db,1)).rows[0].id;
 assert.equal(Number((await db.query('select exposure_microusd from benchmark_dollar_exposures where call_id=$1',[fraction])).rows[0].exposure_microusd),14);
 await db.query('rollback');await db.query('set role service_role');
 for(const lock of ["select pg_advisory_xact_lock(hashtextextended('katie.mission.state',0))","select * from model_registry where provider_name='openai' and model_id='gpt-5.3-codex' for update"]){
 // A transaction begun before expiry must fail if it waits past the deadline.
 await db.query('reset role');
 await db.query("update benchmark_execution_grants set deadline=clock_timestamp()+interval '500 milliseconds' where id=$1",[g.id]);
 await db.query('set role service_role');
 await db.query('begin');await db.query(lock);
 await rival.query('begin');
 const delayed=native(rival,100).then(()=>({accepted:true}),error=>({error}));
 await new Promise(resolve=>setTimeout(resolve,650));await db.query('commit');
 const expired=await delayed;assert.ok(expired.error);assert.match(expired.error.message,/expired|unauthorized/);await rival.query('rollback');
 await db.query('reset role');await db.query('update benchmark_execution_grants set deadline=(select deadline from benchmark_full_continuations where id=$2) where id=$1',[g.id,c.id]);await db.query('set role service_role');
 }
 // Dollar race: fixture raises historical provision to leave exactly one100token
 // hold. Two separate connections compete; exactly one may reserve.
 await db.query('reset role');
 const original=(await db.query('select * from benchmark_dollar_exposures where account_id=$1 order by call_id limit 1',[account])).rows[0];
 const sum=Number((await db.query('select sum(exposure_microusd) n from benchmark_dollar_exposures where account_id=$1',[account])).rows[0].n);
 await db.query('update benchmark_dollar_exposures set exposure_microusd=exposure_microusd+$2 where call_id=$1',[original.call_id,10000000-1400-sum]);
 await db.query('set role service_role');
 const race=await Promise.allSettled([native(db,100),native(rival,100)]);assert.equal(race.filter(x=>x.status==='fulfilled').length,1,JSON.stringify(race.map(x=>x.status==='rejected'?{message:x.reason.message,where:x.reason.where}:x.value.rows)));
 const id=race.find(x=>x.status==='fulfilled').value.rows[0].id;
 const linked=(await db.query('select legacy_mission_call_id from benchmark_budget_calls where id=$1',[id])).rows[0].legacy_mission_call_id;
 const held=(await db.query('select exposure_microusd from benchmark_dollar_exposures where call_id=$1',[id])).rows[0].exposure_microusd;
 await db.query('select benchmark_finish_mission_call($1,null)',[linked]);
 assert.equal((await db.query('select exposure_microusd from benchmark_dollar_exposures where call_id=$1',[id])).rows[0].exposure_microusd,held);
 await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-dollar-race',{input_tokens:60,output_tokens:10,total_tokens:70}]);
 assert.equal(Number((await db.query('select exposure_microusd from benchmark_dollar_exposures where call_id=$1',[id])).rows[0].exposure_microusd),245);
 await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-dollar-race',{input_tokens:60,output_tokens:10,total_tokens:70}]);
 await db.query('reset role');await db.query('update benchmark_dollar_exposures set exposure_microusd=$2 where call_id=$1',[original.call_id,original.exposure_microusd]);await db.query('set role service_role');
 // Ten more native turns + initial race=eleven, with realistic full-size receipts.
 for(let i=0;i<10;i++){
  const id=(await native(db,22000)).rows[0].id;
  const linked=(await db.query('select legacy_mission_call_id from benchmark_budget_calls where id=$1',[id])).rows[0].legacy_mission_call_id;
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-completion-'+id,{input_tokens:15994,output_tokens:4096,total_tokens:20090}]);
 }
 await assert.rejects(native(db,1),/closure capacity/);
 assert.equal((await db.query('select count(*)::int n from benchmark_budget_calls bc join mission_calls mc on mc.id=bc.legacy_mission_call_id join mission_assignments j on j.id=mc.job_id where j.mission_id=$1',[mission])).rows[0].n,20);
 assert.equal(Number((await db.query('select sum(exposure_microusd) n from benchmark_dollar_exposures where account_id=$1',[account])).rows[0].n)<10000000,true);
 await assertRenewalCompletionLifecycle(db,{project,mission,task,c,cumulativeCap:550000});
 await db.query('reset role');await db.query('set role authenticated');await assert.rejects(db.query(rpc,approve),/permission denied/);await assert.rejects(db.query('select * from benchmark_dollar_exposures'),/permission denied/);await db.query('reset role');await db.query('set role service_role');
 console.log('COMPLETION_CONTROL_POSTGRES_PASS: owner concurrency, grants, pricing, dollar race, retained uncertainty, settlement, native closure reserve');
}


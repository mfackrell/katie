import {assertRenewalCompletionLifecycle} from './assert-renewal-completion-lifecycle.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
// Only disposable PostgreSQL fixtures call this helper. Never production authority.
export async function assertCapacityRenewal(db,rival,{am,ng,project,mission,task,trial,owner,account}){
 const reserve='select benchmark_full_native_reserve($1,$2,$3,$4,$5,$6) id';
 for(const actual of [7216,11529,11682,14795]){
  const id=(await db.query(reserve,[ng.token_digest,trial,ng.execution_epoch,randomUUID(),'gpt-5.3-codex',actual+5120])).rows[0].id;
  const linked=(await db.query('select legacy_mission_call_id from benchmark_budget_calls where id=$1',[id])).rows[0].legacy_mission_call_id;
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-latest-failure-'+id,{input_tokens:actual-100,output_tokens:100,total_tokens:actual}]);
 }
 await db.query("update agent_tasks set status='blocked',external=jsonb_set(external,'{receipt,run_id}','130') where id=$1",[task]);
 await db.query("update mission_assignments set status='failed',lease=null,lease_until=null where id=$1",[task]);
 await db.query("update agent_missions set status='blocked' where id=$1",[mission]);
 await db.query("update work_projects set status='blocked',lease=null,lease_until=null where id=$1",[project]);
 await db.query('reset role');
 await db.query('alter table benchmark_full_continuations disable trigger benchmark_continuation_immutable');
 await db.query("update benchmark_full_continuations set created_at=now()-interval '5 hours',deadline=now()-interval '1 hour' where id=$1",[am.continuation_id]);
 await db.query('alter table benchmark_full_continuations enable trigger benchmark_continuation_immutable');
 await db.query("update benchmark_native_spending_approvals set deadline=(select deadline from benchmark_full_continuations where id=continuation_id) where id=$1",[am.approval_id]);
 await db.query("update benchmark_execution_grants set deadline=(select deadline from benchmark_full_continuations where id=continuation_id) where id=$1",[ng.id]);
 await db.query(readFileSync('supabase/migrations/20261030220000_benchmark_capacity_renewal.sql','utf8'));
 await db.query('set role service_role');
 const snapshot=async()=>(await db.query(`select jsonb_build_object('account',(select to_jsonb(x) from benchmark_budget_accounts x where id=$1),'calls',(select jsonb_agg(to_jsonb(x) order by id) from benchmark_budget_calls x where account_id=$1),'exposure',(select jsonb_agg(to_jsonb(x) order by call_id) from benchmark_dollar_exposures x where account_id=$1),'mission',(select jsonb_build_object('calls',calls,'actual',actual_tokens,'reserved',reserved_tokens,'allowance',token_allowance,'maxCalls',max_calls,'deadline',deadline) from agent_missions where id=$2),'approvals',(select jsonb_agg(to_jsonb(x) order by id) from benchmark_native_spending_approvals x where account_id=$1),'continuations',(select jsonb_agg(to_jsonb(x) order by id) from benchmark_full_continuations x where account_id=$1)) s`,[account,mission])).rows[0].s;
 const before=await snapshot();assert.equal(before.account.spent_tokens,287895);assert.equal(before.mission.calls,17);
 const rpc='select benchmark_dashboard_capacity_renewal($1,$2,$3,$4,$5,$6,$7) r',release='b'.repeat(40);
 const args=[owner,null,null,false,release,'provider-input-count-v1',null];
 const offer=(await db.query(rpc,args)).rows[0].r;

 assert.ok(offer,'expired paid successor must offer exact renewal');
 assert.equal(offer.approved,false);assert.equal(offer.deadline,null);assert.equal(offer.plan.cumulativeTokenCap,625000);assert.equal(offer.plan.maxCalls,32);assert.equal(offer.plan.nativeCallsRemaining,11);assert.equal(offer.plan.developmentRemainingTokens,277105);assert.equal(offer.plan.assessmentTokens,60000);
 assert.deepEqual(await snapshot(),before,'Viewing does not change authority or spending');
 const run={id:130,head_sha:'a'.repeat(40)},approve=[owner,project,offer.planHash,true,release,'provider-input-count-v1',run];
 await assert.rejects(db.query(rpc,[randomUUID(),...approve.slice(1)]),/owner/);
 await assert.rejects(db.query(rpc,[owner,project,'f'.repeat(64),...approve.slice(3)]),/exact current/);
 await assert.rejects(db.query(rpc,[...approve.slice(0,6),{...run,id:999}]),/terminal run/);
 for(const sql of ["update benchmark_budget_calls set state='unresolved' where id=(select id from benchmark_budget_calls where account_id='"+account+"' limit 1)","update agent_missions set calls=calls+1 where id='"+mission+"'", "update benchmark_native_spending_approvals set revoked_at=now() where id='"+am.approval_id+"'"]){await db.query('begin');await db.query(sql);await assert.rejects(db.query(rpc,approve),/unavailable|current/);await db.query('rollback');}
 const results=await Promise.all([db.query(rpc,approve),rival.query(rpc,approve)]);const approved=results[0].rows[0].r;assert.equal(approved.id,results[1].rows[0].r.id);
 const after=await snapshot();for(const key of ['account','calls','exposure','mission'])assert.deepEqual(after[key],before[key]);for(const key of ['approvals','continuations'])for(const old of before[key])assert.deepEqual(after[key].find(x=>x.id===old.id),old);
 const next=(await db.query('select * from benchmark_development_resource_amendments where continuation_id=$1',[approved.id])).rows[0];
 const c=(await db.query('select * from benchmark_full_continuations where id=$1',[approved.id])).rows[0];assert.equal(c.deadline-c.created_at,14400000);
 assert.equal((await db.query('select benchmark_effective_account_cap($1) n',[account])).rows[0].n,'625000');
 assert.equal((await db.query('select benchmark_effective_mission_call_limit($1,$2) n',[mission,c.id])).rows[0].n,32);
 assert.equal((await db.query('select benchmark_full_monetary_control($1,$2) r',[account,c.id])).rows[0].r.cumulativeTokenCap,625000);
 const claim=await Promise.all([db.query('select benchmark_claim_development_amendment($1,$2) ok',[next.id,release]),rival.query('select benchmark_claim_development_amendment($1,$2) ok',[next.id,release])]);assert.equal(claim.filter(x=>x.rows[0].ok).length,1);
 if(process.env.KATIE_TEST_TASK2C==='1'){
  // Preserve benchmark regression state and stop its fixture through its normal
  // control before independently qualifying an ordinary original authorization.
  const parked=(await db.query('select actor_id,chat_id from work_projects where id=$1',[project])).rows[0];
  await db.query("select control_work_project($1,$2,$3,'stop')",[project,parked.actor_id,parked.chat_id]);
  await db.query('reset role');await db.query(readFileSync('supabase/migrations/20261101123639_lifecycle_owner_authorization.sql','utf8'));await db.query('set role service_role');
  await (await import('./assert-ordinary-authority.mjs')).assertOrdinaryAuthority(db,rival,{initialLifecycle:async(ids,authority)=>
   (await import('./qualify-resource-lifecycle.mjs')).qualifyResourceLifecycle(db,rival,ids,authority)});return;
 }
 const issue='select benchmark_issue_development_amendment_grant($1,$2,$3,$4,$5) r',grantArgs=[next.id,'c'.repeat(64),next.approval_id,task,release];
 const granted=await Promise.allSettled([db.query(issue,grantArgs),rival.query(issue,[next.id,'d'.repeat(64),...grantArgs.slice(2)])]);assert.equal(granted.filter(x=>x.status==='fulfilled').length,1,JSON.stringify(granted));
 const g=(await db.query('select * from benchmark_execution_grants where id=$1',[granted.find(x=>x.status==='fulfilled').value.rows[0].r.grantId])).rows[0];
 await assert.rejects(db.query(reserve,[ng.token_digest,trial,ng.execution_epoch,randomUUID(),'gpt-5.3-codex',1]),/unauthorized/);
 await assert.rejects(db.query(issue,grantArgs),/unavailable/);
 await db.query('begin');await db.query(reserve,[g.token_digest,trial,g.execution_epoch,randomUUID(),'gpt-5.3-codex',120000]);await assert.rejects(db.query(reserve,[g.token_digest,trial,g.execution_epoch,randomUUID(),'gpt-5.3-codex',98000]),/closure|capacity/);await db.query('rollback');
 for(let i=0;i<11;i++){
  const id=(await db.query(reserve,[g.token_digest,trial,g.execution_epoch,randomUUID(),'gpt-5.3-codex',22000])).rows[0].id;
  const linked=(await db.query('select legacy_mission_call_id from benchmark_budget_calls where id=$1',[id])).rows[0].legacy_mission_call_id;
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-renewal-'+id,{input_tokens:13000,output_tokens:4000,total_tokens:17000}]);
 }
 await assert.rejects(db.query(reserve,[g.token_digest,trial,g.execution_epoch,randomUUID(),'gpt-5.3-codex',1]),/closure/);
 assert.equal((await db.query('select calls from agent_missions where id=$1',[mission])).rows[0].calls,28);
 if(process.env.KATIE_TEST_LIFECYCLE_AUTHORIZATION==='1'){
  await (await import('./assert-lifecycle-authorization.mjs')).assertLifecycleAuthorization(db,rival,{project,mission,task,trial,owner,account,grant:g});return;
 }
 await assertRenewalCompletionLifecycle(db,{project,mission,task,c:{id:c.id,planHash:c.plan_hash},cumulativeCap:625000});
 await db.query('reset role');await db.query('set role authenticated');await assert.rejects(db.query(rpc,approve),/permission denied/);await db.query('reset role');await db.query('set role service_role');
 console.log('CAPACITY_RENEWAL_POSTGRES_PASS: append-only625k/32calls/4hours, unchanged dollars, owner identity, exact ledger, concurrent approval/dispatch/grant and native closure fence');
}

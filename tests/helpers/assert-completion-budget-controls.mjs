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
 for(const old of before.approvals)assert.deepEqual(after.approvals.find(x=>x.id===old.id),old);
 for(const old of before.continuations)assert.deepEqual(after.continuations.find(x=>x.id===old.id),old);
 const fresh=(await db.query('select * from benchmark_native_spending_approvals where id=$1',[am.approval_id])).rows[0];assert.equal(Number(fresh.max_tokens),550000);
 assert.equal((await db.query('select benchmark_development_amendment_ready($1,$2) ok',[am.id,release])).rows[0].ok,true);
 const claim=await Promise.all([db.query('select benchmark_claim_development_amendment($1,$2) ok',[am.id,release]),rival.query('select benchmark_claim_development_amendment($1,$2) ok',[am.id,release])]);assert.equal(claim.filter(x=>x.rows[0].ok).length,1);
 const issue='select benchmark_issue_development_amendment_grant($1,$2,$3,$4,$5) r';
 const granted=await Promise.allSettled([db.query(issue,[am.id,'7'.repeat(64),am.approval_id,task,release]),rival.query(issue,[am.id,'8'.repeat(64),am.approval_id,task,release])]);
 assert.equal(granted.filter(x=>x.status==='fulfilled').length,1);
 const gid=granted.find(x=>x.status==='fulfilled').value.rows[0].r.grantId;
 const g=(await db.query('select * from benchmark_execution_grants where id=$1',[gid])).rows[0];
 const reserve='select benchmark_full_native_reserve($1,$2,$3,$4,$5,$6) id';
 const native=(client,tokens)=>client.query(reserve,[g.token_digest,trial,g.execution_epoch,randomUUID(),'gpt-5.3-codex',tokens]);
 await assert.rejects(db.query(reserve,[grant.token_digest,trial,grant.execution_epoch,randomUUID(),'gpt-5.3-codex',1]),/unauthorized/);
 // Pricing denial must roll back all token/call/dollar counters atomically.
 for(const sql of ["pricing_status='unknown'","pricing_verified_at=now()-interval '25 hours'","pricing_input_per_1m=null","pricing_output_per_1m=29"]){
  await db.query('begin');await db.query('update model_registry set '+sql+" where provider_name='openai' and model_id='gpt-5.3-codex'");
  await assert.rejects(native(db,100),/pricing|admission/);await db.query('rollback');
 }
 // Dollar race: fixture raises historical provision to leave exactly one100token
 // hold. Two separate connections compete; exactly one may reserve.
 await db.query('reset role');
 const original=(await db.query('select * from benchmark_dollar_exposures where account_id=$1 order by call_id limit 1',[account])).rows[0];
 const sum=Number((await db.query('select sum(exposure_microusd) n from benchmark_dollar_exposures where account_id=$1',[account])).rows[0].n);
 await db.query('update benchmark_dollar_exposures set exposure_microusd=exposure_microusd+$2 where call_id=$1',[original.call_id,10000000-1400-sum]);
 await db.query('set role service_role');
 const race=await Promise.allSettled([native(db,100),native(rival,100)]);assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
 const id=race.find(x=>x.status==='fulfilled').value.rows[0].id;
 const linked=(await db.query('select legacy_mission_call_id from benchmark_budget_calls where id=$1',[id])).rows[0].legacy_mission_call_id;
 const held=(await db.query('select exposure_microusd from benchmark_dollar_exposures where call_id=$1',[id])).rows[0].exposure_microusd;
 await db.query('select benchmark_finish_mission_call($1,null)',[linked]);
 assert.equal((await db.query('select exposure_microusd from benchmark_dollar_exposures where call_id=$1',[id])).rows[0].exposure_microusd,held);
 await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-dollar-race',{input_tokens:60,output_tokens:10,total_tokens:70}]);
 assert.equal(Number((await db.query('select exposure_microusd from benchmark_dollar_exposures where call_id=$1',[id])).rows[0].exposure_microusd),980);
 await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-dollar-race',{input_tokens:60,output_tokens:10,total_tokens:70}]);
 await db.query('reset role');await db.query('update benchmark_dollar_exposures set exposure_microusd=$2 where call_id=$1',[original.call_id,original.exposure_microusd]);await db.query('set role service_role');
 // Ten more native turns + initial race=eleven, with realistic full-size receipts.
 for(let i=0;i<10;i++){
  const id=(await native(db,22000)).rows[0].id;
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,false)',[id,'synthetic-completion-'+id,{input_tokens:15994,output_tokens:4096,total_tokens:20090}]);
 }
 await assert.rejects(native(db,1),/closure capacity/);
 assert.equal((await db.query('select count(*)::int n from benchmark_budget_calls bc join mission_calls mc on mc.id=bc.legacy_mission_call_id join mission_assignments j on j.id=mc.job_id where j.mission_id=$1',[mission])).rows[0].n,20);
 assert.equal(Number((await db.query('select sum(exposure_microusd) n from benchmark_dollar_exposures where account_id=$1',[account])).rows[0].n)<10000000,true);
 await db.query('begin');
 const team=(await db.query('select team from agent_missions where id=$1',[mission])).rows[0].team;
 const head='a'.repeat(40),contractHash='b'.repeat(64);
 // This startup fixture only supplied scopeHash; add synthetic immutable-head
 // acceptance metadata here to exercise lifecycle gates, never production proof.
 await db.query("update project_runs set binding=binding||jsonb_build_object('contractHash',$2::text) where mission_id=$1",[mission,contractHash]);
 await db.query('update mission_assignments set available_at=now() where id=$1',[task]);
 const developer=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(developer.job.id,task);
 const verification={testedHeadSha:head,reviewedHeadSha:head,observedHeadSha:head,projectAcceptance:{passed:true,headSha:head,contractHash,projectId:project}};
 const children=[{key:'amendment_compose',role:'compose',agent_id:team[0].id,instruction:'Summarize the synthetic verified fixture.',dependencies:[developer.job.job_key],payload:{}},{key:'amendment_review',role:'review',agent_id:team[1].id,instruction:'Review the synthetic verified fixture.',dependencies:['amendment_compose'],payload:{}}];
 assert.equal((await db.query("select commit_mission_work($1,$2,$3,$4,'completed',null,null) ok",[task,developer.job.lease,{verification},JSON.stringify(children)])).rows[0].ok,true);
 const composer=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(composer.job.role,'compose');
 for(const routing of [true,false]){
  const call=randomUUID();const op=(await db.query('select benchmark_reserve_mission_call($1,$2,$3,$4,15000,$5) id',[composer.job.id,composer.job.lease,call,'openai:gpt-5.3-codex',routing])).rows[0].id;assert.ok(op);
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[call,'synthetic-closure-'+call,{input_tokens:7000,output_tokens:2000,total_tokens:9000}]);
 }

 assert.equal((await db.query("select commit_mission_work($1,$2,$3,'[]','completed',null,null) ok",[composer.job.id,composer.job.lease,{text:'Synthetic completed code and browser receipt.'}])).rows[0].ok,true);
 const review=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(review.job.role,'review');
 for(const routing of [true,false]){
  const call=randomUUID();const op=(await db.query('select benchmark_reserve_mission_call($1,$2,$3,$4,15000,$5) id',[review.job.id,review.job.lease,call,'openai:gpt-5.3-codex',routing])).rows[0].id;assert.ok(op);
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[call,'synthetic-closure-'+call,{input_tokens:7000,output_tokens:2000,total_tokens:9000}]);
 }
 await db.query('savepoint call_limit');
 await assert.rejects(db.query('select benchmark_reserve_mission_call($1,$2,$3,$4,1,true)',[review.job.id,review.job.lease,randomUUID(),'openai:gpt-5.3-codex']),/billable call ceiling/);await db.query('rollback to savepoint call_limit');

 assert.equal((await db.query("select commit_mission_work($1,$2,$3,'[]','completed','completed',$4) ok",[review.job.id,review.job.lease,{verdict:'pass'},'Synthetic independently reviewed fixture.'])).rows[0].ok,true);
 assert.equal((await db.query('select status from agent_missions where id=$1',[mission])).rows[0].status,'completed');
 const projectClaim=(await db.query('select claim_work_project() p')).rows[0].p;assert.equal(projectClaim.id,project);
 assert.equal((await db.query("select finish_work_project($1,$2,'advance',$3) ok",[project,projectClaim.lease,{head}])).rows[0].ok,true);
 assert.equal((await db.query('select verified_sha from work_projects where id=$1',[project])).rows[0].verified_sha,head);
 // Stand in for the separately tested deployment/browser receipt, then use the
 // real coordinator's assessment child creation and ordinary reservation path.
 await db.query("update work_projects set phase='assessment' where id=$1",[project]);
 const nextProjectClaim=(await db.query('select claim_work_project() p')).rows[0].p;assert.equal(nextProjectClaim.id,project);
 assert.equal((await db.query("select finish_work_project($1,$2,'child',$3) ok",[project,nextProjectClaim.lease,{kind:'assessment',objective:'Synthetic preserved assessment',evidence:{benchmarkContinuationId:c.id,benchmarkContinuationPlanHash:c.planHash}}])).rows[0].ok,true);
 const assessmentWork=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(assessmentWork.mission.project_kind,'assessment');assert.equal(assessmentWork.mission.token_allowance,60000);
 const assessmentCall=randomUUID();
 const reserved=(await db.query('select benchmark_reserve_mission_call($1,$2,$3,$4,60000,false) id',[assessmentWork.job.id,assessmentWork.job.lease,assessmentCall,'openai:gpt-5.3-codex'])).rows[0].id;assert.ok(reserved);
 assert.equal((await db.query('select continuation_id from benchmark_budget_calls where id=$1',[reserved])).rows[0].continuation_id,c.id);
 assert.equal((await db.query('select benchmark_reserve_mission_call($1,$2,$3,$4,1,false) id',[assessmentWork.job.id,assessmentWork.job.lease,randomUUID(),'openai:gpt-5.3-codex'])).rows[0].id,null);
 await db.query('rollback');
 await db.query('reset role');await db.query('set role authenticated');await assert.rejects(db.query(rpc,approve),/permission denied/);await assert.rejects(db.query('select * from benchmark_dollar_exposures'),/permission denied/);await db.query('reset role');await db.query('set role service_role');
 console.log('COMPLETION_CONTROL_POSTGRES_PASS: owner concurrency, grants, pricing, dollar race, retained uncertainty, settlement, native closure reserve');
}

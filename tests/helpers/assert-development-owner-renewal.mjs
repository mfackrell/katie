import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function assertDevelopmentOwnerRenewal(db,rival,{project,account,trial,owner,actor,continuation,protocol}){
 await db.query('reset role');
 for(const table of ['benchmark_development_renewals','benchmark_development_renewal_dispatches','benchmark_development_renewal_grants']){
  const acl=(await db.query("select has_table_privilege('service_role',$1,'SELECT') readable,has_table_privilege('service_role',$1,'INSERT') appendable,has_table_privilege('service_role',$1,'UPDATE,DELETE,TRUNCATE') mutable",[table])).rows[0];
  assert.deepEqual(acl,{readable:true,appendable:true,mutable:false});
 }
 const old=(await db.query('select * from benchmark_native_spending_approvals where project_id=$1 order by created_at desc limit 1',[project])).rows[0];
 const task=old.task_id,mission=(await db.query('select mission_id from mission_assignments where id=$1',[task])).rows[0].mission_id;
 const receipt={version:1,repository:'mfackrell/katie',run_id:125,issue_number:829,outcome:'BLOCKED',pr_url:null,tested_head_sha:null,reviewed_head_sha:null,checks:{build:'failure',test:'',review:'',repair:'skipped',retest:'',final_review:''}};
 await db.query("update agent_missions set status='blocked' where project_id=$1",[project]);
 await db.query("update work_projects set status='blocked',deadline=now()+interval '8 hours',lease=null,lease_until=null where id=$1",[project]);
 await db.query("update agent_missions set token_allowance=120000,calls=2,actual_tokens=14419,reserved_tokens=14419,deadline=now()-interval '1 hour' where id=$1",[mission]);
 await db.query("update mission_assignments set status='failed' where id=$1",[task]);
 await db.query("update agent_tasks set status='blocked',external=jsonb_set(external,'{receipt}',$2::jsonb) where id=$1",[task,receipt]);
 await db.query("update benchmark_native_spending_approvals set deadline=now()-interval '1 hour' where id=$1",[old.id]);
 await db.query("update benchmark_execution_grants set deadline=now()-interval '1 hour' where account_id=$1",[account]);
 await db.query('alter table benchmark_full_continuations disable trigger benchmark_continuation_immutable');
 await db.query("update benchmark_full_continuations set created_at=now()-interval '5 hours',deadline=now()-interval '1 hour' where id=$1",[continuation]);
 await db.query('alter table benchmark_full_continuations enable trigger benchmark_continuation_immutable');
 await db.query("insert into benchmark_development_dispatches(task_id,trial_id,contract_hash,benchmark_contract_hash,baseline_sha,status) values($1,$2,repeat('c',64),$3,$4,'qualified')",[task,trial,protocol.contract_sha256,protocol.baselineSha]);
 const binding=(await db.query('select account_id,baseline_sha from benchmark_mission_bindings where mission_id=$1',[mission])).rows[0];
 assert.equal(binding.account_id,account);assert.equal(binding.baseline_sha,protocol.baselineSha);
 // Advance only this disposable fixture to the observed paid-before-replay failure.
 await db.query('alter table benchmark_budget_calls disable trigger user');
 for(const tokens of [7206,7213]){
  const call=randomUUID();
  await db.query("insert into mission_calls(id,job_id,lease,model,reserved_tokens,actual_tokens,status) values($1,$2,$3,'gpt-5.3-codex',43104,$4,'completed')",[call,task,randomUUID(),tokens]);
  await db.query("insert into benchmark_budget_calls(account_id,request_key,model,reserved_tokens,actual_tokens,state,legacy_mission_call_id,continuation_id) values($1,$2::uuid::text,'gpt-5.3-codex',43104,$3,'settled',$2::uuid,$4)",[account,call,tokens,continuation]);
 }
 await db.query('alter table benchmark_budget_calls enable trigger user');
 await db.query('update benchmark_budget_accounts set spent_tokens=spent_tokens+14419 where id=$1',[account]);
 const original=(await db.query(`select jsonb_build_object('approval',(select to_jsonb(a) from benchmark_native_spending_approvals a where id=$1),
 'mission',(select jsonb_build_object('deadline',deadline,'calls',calls,'actual_tokens',actual_tokens,'reserved_tokens',reserved_tokens,'token_allowance',token_allowance) from agent_missions where id=$2),
 'attempts',(select attempts from mission_assignments where id=$3),'spent',(select spent_tokens from benchmark_budget_accounts where id=$4)) v`,[old.id,mission,task,account])).rows[0].v;
 const rpc='select benchmark_dashboard_continuation($1,$2,$3,$4) r';
 await db.query('set role service_role');
 const countBefore=(await db.query('select count(*)::int n from benchmark_full_continuations')).rows[0].n;
 const plan=(await db.query(rpc,[owner,null,null,false])).rows[0].r;
 const diagnostic=(await db.query(`select jsonb_build_object('mission',to_jsonb(m),'project',to_jsonb(p),'account',to_jsonb(a),'task',to_jsonb(t),'assignment',to_jsonb(j),'approval',to_jsonb(ap),'provenance',benchmark_full_task_provenance(t.id,p.id),'missionSpent',(select sum(greatest(actual_tokens,reserved_tokens)) from agent_missions where project_id=p.id),'accountSpent',(select sum(actual_tokens) from benchmark_budget_calls where account_id=a.id),'runCount',(select count(*) from project_runs where project_id=p.id)) d from agent_missions m join work_projects p on p.id=m.project_id join mission_assignments j on j.id=$2 join agent_tasks t on t.id=j.id join benchmark_native_spending_approvals ap on ap.id=$3 join benchmark_budget_accounts a on a.id=$4 where m.id=$1`,[mission,task,old.id,account])).rows[0].d;
 assert.equal(plan.approved,false,JSON.stringify(diagnostic));assert.equal(plan.plan.kind,'development-renewal');
 assert.equal(plan.plan.developmentSpentTokens,14419);assert.equal(plan.plan.developmentRemainingTokens,105581);
 assert.equal(plan.plan.additionalTokenCap,165581);assert.equal(plan.plan.assessmentTokens,60000);assert.equal(plan.plan.specificationTokens,0);
 assert.equal(plan.plan.taskId,task);assert.equal(plan.plan.missionId,mission);assert.equal(plan.plan.newFunds,0);
 assert.equal((await db.query('select count(*)::int n from benchmark_full_continuations')).rows[0].n,countBefore,'GET cannot authorize work');
 await assert.rejects(db.query(rpc,[randomUUID(),project,plan.planHash,true]),/owner/);
 await assert.rejects(db.query(rpc,[owner,project,'f'.repeat(64),true]),/current development/);
 await db.query('begin');await db.query("update work_projects set approved_hash=repeat('f',64) where id=$1",[project]);
 await assert.rejects(db.query(rpc,[owner,project,plan.planHash,true]),/eligible/);await db.query('rollback');
 await db.query('begin');await db.query("update benchmark_budget_calls set state='unresolved' where account_id=$1",[account]);
 await assert.rejects(db.query(rpc,[owner,project,plan.planHash,true]),/eligible/);await db.query('rollback');
 const approved=await Promise.all([db.query(rpc,[owner,project,plan.planHash,true]),rival.query(rpc,[owner,project,plan.planHash,true])]);
 const c=approved[0].rows[0].r;assert.equal(c.id,approved[1].rows[0].r.id);assert.equal(c.live,true);
 const r=(await db.query('select * from benchmark_development_renewals where continuation_id=$1',[c.id])).rows[0];
 assert.equal(r.previous_approval_id,old.id);assert.equal(r.task_id,task);assert.equal(r.mission_id,mission);assert.deepEqual(r.receipt,receipt);
 const after=(await db.query(`select jsonb_build_object('approval',(select to_jsonb(a) from benchmark_native_spending_approvals a where id=$1),
 'mission',(select jsonb_build_object('deadline',deadline,'calls',calls,'actual_tokens',actual_tokens,'reserved_tokens',reserved_tokens,'token_allowance',token_allowance) from agent_missions where id=$2),
 'attempts',(select attempts from mission_assignments where id=$3),'spent',(select spent_tokens from benchmark_budget_accounts where id=$4)) v`,[old.id,mission,task,account])).rows[0].v;
 assert.deepEqual(after,original,'Renewal does not erase prior consent, deadline, attempts or paid calls');
 assert.equal((await db.query('select benchmark_effective_mission_deadline($1)>now() ok',[mission])).rows[0].ok,true);
 const claim=(await db.query('select claim_mission_work() c')).rows[0].c;
 assert.equal(claim.job.id,task);assert.equal(claim.mission.id,mission);
 assert.ok(Date.parse(claim.mission.deadline)>Date.now());
 const saved=(await db.query("select save_project_development_dispatch($1,$2,'dispatching','Waiting for owner-renewed dispatch',(select external from agent_tasks where id=$1)) saved",[task,claim.job.lease])).rows[0].saved;
 assert.equal(saved.id,task,'Leased reconciliation can persist on the renewed same task');
 assert.equal((await db.query("select commit_mission_work($1,$2,$3,'[]','waiting_external',null,null) ok",[task,claim.job.lease,{detail:'Awaiting separately authorized renewed native execution'}])).rows[0].ok,true);
 assert.equal((await db.query('select deadline<now() old from agent_missions where id=$1',[mission])).rows[0].old,true);
 // Exercise saved review/evidence checkpoints on this renewed mission without
 // changing its expired physical deadline; roll back the disposable role setup.
 await db.query('begin');
 const checkpointLease=randomUUID();
 await db.query("update mission_assignments set role='review',status='running',lease=$2,lease_until=now()+interval '5 minutes',payload='{}' where id=$1",[task,checkpointLease]);
 const evidence={kind:'scoped_workflow_trace',observedAt:new Date().toISOString()};
 const review={text:'Independent review complete',sources:[],calculations:[],model:'gpt-5.3-codex'};
 assert.equal((await db.query('select checkpoint_mission_operational_evidence($1,$2,$3) ok',[task,checkpointLease,evidence])).rows[0].ok,true);
 assert.equal((await db.query('select checkpoint_mission_review_model($1,$2,$3,$4) ok',[task,checkpointLease,'c'.repeat(64),review])).rows[0].ok,true);
 await db.query('reset role');await db.query('alter table benchmark_full_continuations disable trigger benchmark_continuation_immutable');
 await db.query("update benchmark_full_continuations set created_at=now()-interval '5 hours',deadline=now()-interval '1 hour' where id=$1",[c.id]);
 await db.query('alter table benchmark_full_continuations enable trigger benchmark_continuation_immutable');await db.query('set local role service_role');
 assert.equal((await db.query('select checkpoint_mission_operational_evidence($1,$2,$3) ok',[task,checkpointLease,evidence])).rows[0].ok,false);
 assert.equal((await db.query('select checkpoint_mission_review_model($1,$2,$3,$4) ok',[task,checkpointLease,'c'.repeat(64),review])).rows[0].ok,false);
 await db.query('rollback');
 const release='8'.repeat(40),issue='select benchmark_issue_development_renewal_grant($1,$2,$3,$4,$5) g';
 await assert.rejects(db.query(issue,[r.id,'a'.repeat(64),r.approval_id,task,release]),/unavailable/);
 assert.equal((await db.query('select benchmark_claim_development_renewal_dispatch($1,$2,$3) ok',[r.id,{...receipt,run_id:126},release])).rows[0].ok,false);
 const claims=await Promise.all([db.query('select benchmark_claim_development_renewal_dispatch($1,$2,$3) ok',[r.id,receipt,release]),rival.query('select benchmark_claim_development_renewal_dispatch($1,$2,$3) ok',[r.id,receipt,release])]);
 assert.equal(claims.filter(x=>x.rows[0].ok).length,1);
 await assert.rejects(db.query(issue,[r.id,'a'.repeat(64),r.approval_id,randomUUID(),release]),/unavailable/);
 await assert.rejects(db.query(issue,[r.id,'a'.repeat(64),r.approval_id,task,'7'.repeat(40)]),/unavailable/);
 await db.query('begin');await db.query('update benchmark_native_spending_approvals set revoked_at=now() where id=$1',[r.approval_id]);
 assert.equal((await db.query('select benchmark_effective_mission_deadline($1)>now() ok',[mission])).rows[0].ok,false);
 await assert.rejects(db.query(issue,[r.id,'a'.repeat(64),r.approval_id,task,release]),/unavailable/);await db.query('rollback');
 await db.query('begin');await db.query("update work_projects set approved_hash=repeat('f',64) where id=$1",[project]);
 await assert.rejects(db.query(issue,[r.id,'a'.repeat(64),r.approval_id,task,release]),/unavailable/);await db.query('rollback');
 await db.query('begin');await db.query('reset role');await db.query('alter table benchmark_full_continuations disable trigger benchmark_continuation_immutable');
 await db.query("update benchmark_full_continuations set created_at=now()-interval '5 hours',deadline=now()-interval '1 hour' where id=$1",[c.id]);
 await db.query('alter table benchmark_full_continuations enable trigger benchmark_continuation_immutable');await db.query('set local role service_role');
 assert.equal((await db.query('select benchmark_effective_mission_deadline($1)>now() ok',[mission])).rows[0].ok,false);
 await assert.rejects(db.query(issue,[r.id,'a'.repeat(64),r.approval_id,task,release]),/unavailable/);await db.query('rollback');
 const grants=await Promise.allSettled([db.query(issue,[r.id,'a'.repeat(64),r.approval_id,task,release]),rival.query(issue,[r.id,'b'.repeat(64),r.approval_id,task,release])]);
 assert.equal(grants.filter(x=>x.status==='fulfilled').length,1);
 const g=grants.find(x=>x.status==='fulfilled').value.rows[0].g;
 const grant=(await db.query('select * from benchmark_execution_grants where id=$1',[g.grantId])).rows[0];
 assert.equal(grant.continuation_id,c.id);assert.equal(grant.mission_assignment_id,task);assert.equal(grant.execution_epoch,'4');
 const reserve='select benchmark_full_native_reserve($1,$2,$3,$4,$5,$6) id';
 await assert.rejects(db.query(reserve,[grant.token_digest,trial,4,randomUUID(),'gpt-5.3-codex',105582]),/capacity/,'Prior paid calls reduce stage capacity');
 const call=randomUUID(),reserved=(await db.query(reserve,[grant.token_digest,trial,4,call,'gpt-5.3-codex',100])).rows[0].id;
 assert.ok(reserved);assert.equal((await db.query('select continuation_id from benchmark_budget_calls where id=$1',[reserved])).rows[0].continuation_id,c.id);
 assert.equal((await db.query('select deadline<now() old_deadline, reserved_tokens from agent_missions where id=$1',[mission])).rows[0].old_deadline,true);
 await assert.rejects(db.query('delete from benchmark_development_renewals where id=$1',[r.id]),/permission denied/);
 await db.query('reset role');await db.query('set role authenticated');
 await assert.rejects(db.query(rpc,[owner,project,plan.planHash,true]),/permission denied/);
 await assert.rejects(db.query(issue,[r.id,'c'.repeat(64),r.approval_id,task,release]),/permission denied/);
 await db.query('reset role');await db.query('set role service_role');
}

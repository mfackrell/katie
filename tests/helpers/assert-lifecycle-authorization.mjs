import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {lifecycleProposalFromSnapshot} from '../../scripts/benchmark/lifecycle-owner-proposal.mjs';

// Isolated PostgreSQL only. Every decision below is synthetic test consent.
export async function assertLifecycleAuthorization(db,rival,{project,mission,task,trial,owner,account,grant}) {
 await db.query('reset role');
 await db.query(readFileSync('supabase/migrations/20261101123639_lifecycle_owner_authorization.sql','utf8'));
 await db.query("update agent_tasks set status='blocked',external=jsonb_set(external,'{receipt,run_id}','131') where id=$1",[task]);
 await db.query("update mission_assignments set status='failed',lease=null,lease_until=null where id=$1",[task]);
 await db.query("update agent_missions set status='blocked' where id=$1",[mission]);
 await db.query("update work_projects set status='blocked',lease=null,lease_until=null where id=$1",[project]);
 await db.query('set role service_role');
 const snapshot=async()=> (await db.query('select benchmark_lifecycle_snapshot($1) s',[task])).rows[0].s;
 const initial=await snapshot();
 assert.equal(initial.position.developmentCalls-initial.position.developmentConsumedCalls,4);
 assert.equal(initial.position.completionCalls,4);assert.equal(initial.position.assessmentCalls,null);
 const record={taskId:task,projectId:project,originalBaselineSha:initial.binding.baselineSha,
  approvedScopeHash:initial.binding.scopeHash,approvedScope:{contractHash:initial.binding.contractHash},
  checkpointSha:'d'.repeat(40),phase:'repair'};
 const checkpoint={...record,scopeHash:initial.binding.scopeHash,runId:'131',releaseSha:'b'.repeat(40)};
 const planned=lifecycleProposalFromSnapshot({snapshot:initial,record});
 assert.equal(planned.state,'awaiting_owner_approval');assert.equal(planned.proposal.additions.nativeCalls,2);
 assert.equal(planned.proposal.proposed.developmentCalls,34);
 assert.equal(planned.proposal.proposed.completionCalls,4);
 const offer=async(p=planned.proposal)=>(await db.query('select benchmark_lifecycle_offer($1,$2,$3) p',[task,p,checkpoint])).rows[0].p;
 const saved=await offer();assert.equal((await offer()).id,saved.id);
 const decision='select benchmark_lifecycle_decide($1,$2,$3,$4,$5) r';
 const args=[owner,task,saved.id,'approved','e'.repeat(40)];
 assert.deepEqual(await snapshot(),initial,'offer/ignored proposal does not alter accounting or authority');
 await assert.rejects(db.query(decision,[randomUUID(),...args.slice(1)]),/denied/);
 await assert.rejects(db.query(decision,[owner,randomUUID(),...args.slice(2)]),/denied/);
 for(const [sql,params] of [
  ["update work_projects set approved_hash=repeat('f',64) where id=$1",[project]],
  ['update agent_missions set calls=calls+1 where id=$1',[mission]],
  ['update benchmark_native_spending_approvals set revoked_at=now() where id=$1',[initial.approvalId]],
  ["update benchmark_budget_calls set state='unresolved' where id=(select id from benchmark_budget_calls where account_id=$1 limit 1)",[account]],
 ]) {
  await db.query('begin');await db.query(sql,params);await assert.rejects(db.query(decision,args),/stale|unavailable|inconsistent|required|denied/);await db.query('rollback');
 }
 await db.query('begin');
 const rejection=(await db.query(decision,[...args.slice(0,3),'rejected',args[4]])).rows[0].r;
 assert.equal(rejection.state,'rejected');assert.deepEqual(await snapshot(),initial);
 await assert.rejects(db.query(decision,args),/already decided/);await db.query('rollback');
 // A second connection races the same actual transaction, not a JS ledger mock.
 const race=await Promise.all([db.query(decision,args),rival.query(decision,args)]);
 const approved=race[0].rows[0].r;assert.equal(approved.continuationId,race[1].rows[0].r.continuationId);
 assert.equal((await db.query('select count(*)::int n from benchmark_lifecycle_decisions')).rows[0].n,1);
 assert.equal((await db.query(decision,args)).rows[0].r.continuationId,approved.continuationId);
 const after=await snapshot();assert.deepEqual(after.snapshot.calls,initial.snapshot.calls);assert.deepEqual(after.snapshot.exposures,initial.snapshot.exposures);
 assert.equal(after.position.developmentConsumedCalls,28);assert.equal(after.position.developmentCalls,34);
 assert.equal((await db.query('select benchmark_continuation_live($1,$2,$3) ok',[approved.continuationId,account,project])).rows[0].ok,true);
 const amendment=(await db.query('select * from benchmark_development_resource_amendments where continuation_id=$1',[approved.continuationId])).rows[0];
 const claims=await Promise.all([db.query('select benchmark_claim_development_amendment($1,$2) ok',[amendment.id,args[4]]),rival.query('select benchmark_claim_development_amendment($1,$2) ok',[amendment.id,args[4]])]);
 assert.equal(claims.filter(r=>r.rows[0].ok).length,1);
 const issue='select benchmark_issue_development_amendment_grant($1,$2,$3,$4,$5) r';
 const issues=await Promise.allSettled([db.query(issue,[amendment.id,'e'.repeat(64),amendment.approval_id,task,args[4]]),rival.query(issue,[amendment.id,'f'.repeat(64),amendment.approval_id,task,args[4]])]);
 assert.equal(issues.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(issues));
 const next=(await db.query('select * from benchmark_execution_grants where id=$1',[issues.find(r=>r.status==='fulfilled').value.rows[0].r.grantId])).rows[0];
 const reserve='select benchmark_full_native_reserve($1,$2,$3,$4,$5,$6) id';
 await assert.rejects(db.query(reserve,[grant.token_digest,trial,grant.execution_epoch,randomUUID(),'gpt-5.3-codex',100]),/unauthorized/);
 for(let i=0;i<2;i++) {
  const id=(await db.query(reserve,[next.token_digest,trial,next.execution_epoch,randomUUID(),'gpt-5.3-codex',100])).rows[0].id;
  const linked=(await db.query('select legacy_mission_call_id from benchmark_budget_calls where id=$1',[id])).rows[0].legacy_mission_call_id;
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-lifecycle-'+id,{input_tokens:60,output_tokens:10,total_tokens:70}]);
 }
 await assert.rejects(db.query(reserve,[next.token_digest,trial,next.execution_epoch,randomUUID(),'gpt-5.3-codex',1]),/closure/);
 assert.equal((await db.query('select calls from agent_missions where id=$1',[mission])).rows[0].calls,30);
 await db.query('reset role');await db.query('set role authenticated');
 await assert.rejects(db.query(decision,args),/permission denied/);
 await assert.rejects(db.query('select * from benchmark_lifecycle_proposals'),/permission denied/);
 await db.query('reset role');await db.query('set role service_role');
 console.log('LIFECYCLE_AUTHORIZATION_POSTGRES_PASS: synthetic consent only; duplicate/concurrent exact amendment; historical calls retained; native admission usable; four completion calls protected');
}

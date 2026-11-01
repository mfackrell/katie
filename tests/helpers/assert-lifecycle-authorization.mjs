import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {lifecycleProposalFromSnapshot} from '../../scripts/benchmark/lifecycle-owner-proposal.mjs';

// Isolated PostgreSQL only. Every decision below is synthetic test consent.
export async function assertLifecycleAuthorization(db,rival,{project,mission,task,trial,owner,account,grant}) {
 await db.query('reset role');
 try{await db.query(readFileSync('supabase/migrations/20261101123639_lifecycle_owner_authorization.sql','utf8'));}catch(error){console.error('Lifecycle migration error',JSON.stringify(error));throw error;}
 await db.query("update agent_tasks set status='blocked',external=jsonb_set(external,'{receipt,run_id}','131') where id=$1",[task]);
 await db.query("update mission_assignments set status='failed',lease=null,lease_until=null where id=$1",[task]);
 await db.query("update agent_missions set status='blocked' where id=$1",[mission]);
 await db.query("update work_projects set status='blocked',lease=null,lease_until=null where id=$1",[project]);
 // This isolated accounting fixture predates durable Git evidence; bind its synthetic frozen contract explicitly.
 await db.query("update project_runs set binding=binding||jsonb_build_object('taskId',$2::text,'projectId',$3::text,'baselineSha',(select baseline_sha from benchmark_three_arm_trials where id=$4),'contractHash',repeat('b',64),'contract',jsonb_build_object('path','/pilot','scenarios',jsonb_build_array())) where mission_id=$1",[mission,task,project,trial]);
 await db.query('set role service_role');
 const snapshot=async()=> (await db.query('select benchmark_lifecycle_snapshot($1) s',[task])).rows[0].s;
 const hostFixture=process.env.KATIE_TEST_LIFECYCLE_HOST==='1'?await (await import('./qualify-lifecycle-continuation.mjs')).createLifecycleCheckpoint(db,{project,mission,task,trial,account,grant}):null;
 const initial=await snapshot();
 assert.equal(initial.position.developmentCalls-initial.position.developmentConsumedCalls,4);
 assert.equal(initial.position.completionCalls,4);assert.equal(initial.position.assessmentCalls,null);
 const record=hostFixture?.record??{taskId:task,projectId:project,originalBaselineSha:initial.binding.baselineSha,
  approvedScopeHash:initial.binding.scopeHash,approvedScope:{contractHash:initial.binding.contractHash},
  checkpointSha:'d'.repeat(40),phase:'repair'};
 const checkpoint=hostFixture?.checkpoint??{...record,scopeHash:initial.binding.scopeHash,runId:'131',releaseSha:'b'.repeat(40)};
 const planned=lifecycleProposalFromSnapshot({snapshot:initial,record,observations:hostFixture?.observations??[]});
 assert.equal(planned.state,'awaiting_owner_approval',JSON.stringify(planned.reasons));assert.equal(planned.proposal.additions.nativeCalls,hostFixture?4:2);
 assert.equal(planned.proposal.proposed.developmentCalls,hostFixture?36:34);
 assert.equal(planned.proposal.proposed.completionCalls,4);
 const offer=async(p=planned.proposal)=>(await db.query('select benchmark_lifecycle_offer($1,$2,$3) p',[task,p,checkpoint])).rows[0].p;
 const saved=await offer();assert.equal((await offer()).id,saved.id);
 const decision='select benchmark_lifecycle_decide($1,$2,$3,$4,$5) r';
 const args=[owner,task,saved.id,'approved','e'.repeat(40)];
 assert.deepEqual(await snapshot(),initial,'offer/ignored proposal does not alter accounting or authority');
 await assert.rejects(db.query(decision,[randomUUID(),...args.slice(1)]),/denied/);
 await assert.rejects(db.query(decision,[...args.slice(0,3),null,args[4]]),/denied/);
 // Expired immutable proposals cannot authorize; replacement is distinct.
 await db.query('begin');
 const expiring=structuredClone(planned.proposal);expiring.proposed.developmentCalls++;expiring.additions.nativeCalls++;expiring.expiresAt=Date.now()+100;
 const expired=await offer(expiring);await db.query('select pg_sleep(0.15)');await db.query('savepoint expired_decision');
 await assert.rejects(db.query(decision,[owner,task,expired.id,'approved',args[4]]),/expired/);await db.query('rollback to savepoint expired_decision');
 expiring.expiresAt=Date.now()+3600000;assert.notEqual((await offer(expiring)).id,expired.id);await db.query('rollback');
 await assert.rejects(db.query(decision,[owner,randomUUID(),...args.slice(2)]),/denied/);
 for(const [sql,params] of [
  ["update work_projects set approved_hash=repeat('f',64) where id=$1",[project]],
  ['update agent_missions set calls=calls+1 where id=$1',[mission]],
  ["update project_runs set binding=jsonb_set(binding,'{contractHash}',to_jsonb(repeat('f',64))) where mission_id=$1",[mission]],
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
 assert.equal(after.position.developmentConsumedCalls,28);assert.equal(after.position.developmentCalls,hostFixture?36:34);
 assert.equal((await db.query('select benchmark_continuation_live($1,$2,$3) ok',[approved.continuationId,account,project])).rows[0].ok,true);
 const amendment=(await db.query('select * from benchmark_development_resource_amendments where continuation_id=$1',[approved.continuationId])).rows[0];
 const claims=await Promise.all([db.query('select benchmark_claim_development_amendment($1,$2) ok',[amendment.id,args[4]]),rival.query('select benchmark_claim_development_amendment($1,$2) ok',[amendment.id,args[4]])]);
 assert.equal(claims.filter(r=>r.rows[0].ok).length,1);
 if(hostFixture){await (await import('./qualify-lifecycle-continuation.mjs')).qualifyLifecycleContinuation(db,{project,mission,task,trial,account},hostFixture,amendment);return;}
 const issue='select benchmark_issue_development_amendment_grant($1,$2,$3,$4,$5) r';
 const issues=await Promise.allSettled([db.query(issue,[amendment.id,randomBytes(32).toString('hex'),amendment.approval_id,task,args[4]]),rival.query(issue,[amendment.id,randomBytes(32).toString('hex'),amendment.approval_id,task,args[4]])]);
 assert.equal(issues.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(issues));
 const next=(await db.query('select * from benchmark_execution_grants where id=$1',[issues.find(r=>r.status==='fulfilled').value.rows[0].r.grantId])).rows[0];
 const reserve='select benchmark_full_native_reserve($1,$2,$3,$4,$5,$6) id';
 // Exercise the actual insert admission trigger for both native and DO models.
 // No inference: roll back these synthetic candidate reservations completely.
 for(const model of ['gpt-5.3-codex','openai:gpt-5.3-codex']){
  await db.query('begin');const call=randomUUID(),tokens=after.position.cumulativeTokens-after.position.accountEncumberedTokens-after.position.assessmentTokens-(model==='gpt-5.3-codex'?after.position.completionTokens:0)+1;
  await db.query('insert into mission_calls(id,job_id,lease,model,reserved_tokens) values($1,$2,$3,$4,$5)',[call,task,next.id,model,tokens]);
  await assert.rejects(db.query('insert into benchmark_budget_calls(account_id,request_key,model,reserved_tokens,legacy_mission_call_id,continuation_id) values($1,$2::uuid::text,$3,$4,$2::uuid,$5)',[account,call,model,tokens,approved.continuationId]),/Protected lifecycle account reserves/);await db.query('rollback');
 }
 await assert.rejects(db.query(reserve,[grant.token_digest,trial,grant.execution_epoch,randomUUID(),'gpt-5.3-codex',100]),/unauthorized/);
 // Three competing reservations share only two newly authorized native slots.
 const reservations=await Promise.allSettled([db,rival,db].map(connection=>connection.query(reserve,[next.token_digest,trial,next.execution_epoch,randomUUID(),'gpt-5.3-codex',100])));
 assert.equal(reservations.filter(r=>r.status==='fulfilled').length,2);
 assert.equal(reservations.filter(r=>r.status==='rejected').length,1);
 assert.match(reservations.find(r=>r.status==='rejected').reason.message,/closure/);
 for(const result of reservations.filter(r=>r.status==='fulfilled')) {
  const id=result.value.rows[0].id;
  const linked=(await db.query('select legacy_mission_call_id from benchmark_budget_calls where id=$1',[id])).rows[0].legacy_mission_call_id;
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-lifecycle-'+id,{input_tokens:60,output_tokens:10,total_tokens:70}]);
 }
 await assert.rejects(db.query(reserve,[next.token_digest,trial,next.execution_epoch,randomUUID(),'gpt-5.3-codex',1]),/closure/);
 assert.equal((await db.query('select calls from agent_missions where id=$1',[mission])).rows[0].calls,30);
 await (await import('./assert-renewal-completion-lifecycle.mjs')).assertRenewalCompletionLifecycle(db,{project,mission,task,c:{id:approved.continuationId,planHash:after.snapshot.continuation.plan_hash},cumulativeCap:after.position.cumulativeTokens});
 await db.query('reset role');await db.query('set role authenticated');
 await assert.rejects(db.query(decision,args),/permission denied/);
 await assert.rejects(db.query('select * from benchmark_lifecycle_proposals'),/permission denied/);
 await db.query('reset role');await db.query('set role service_role');
 if(process.env.KATIE_TEST_ORDINARY_AUTHORITY==='1')await (await import('./assert-ordinary-authority.mjs')).assertOrdinaryAuthority(db,rival);
 console.log('LIFECYCLE_AUTHORIZATION_POSTGRES_PASS: synthetic consent only; duplicate/concurrent exact amendment; historical calls retained; native admission usable; four completion calls protected');
}

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function assertDevelopmentResourceAmendment(db,rival,{renewal,project,mission,task,grant,trial,receipt}){
 const reserve='select benchmark_full_native_reserve($1,$2,$3,$4,$5,$6) id';
 // Complete the isolated fixture's nine genuine linked operations at 79,220.
 for(const actual of [12936,12936,12936,12936,12937]){
  const id=(await db.query(reserve,[grant.token_digest,trial,5,randomUUID(),'gpt-5.3-codex',16000])).rows[0].id;
  const linked=(await db.query('select legacy_mission_call_id from benchmark_budget_calls where id=$1',[id])).rows[0].legacy_mission_call_id;
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-amendment-predecessor-'+id,{input_tokens:actual-10,output_tokens:10,total_tokens:actual}]);
 }
 const failed={...receipt,run_id:128},release='4'.repeat(40),runtime='provider-input-count-v1';
 await db.query("update agent_tasks set status='blocked',external=jsonb_set(external,'{receipt}',$2::jsonb) where id=$1",[task,failed]);
 await db.query("update mission_assignments set status='failed',lease=null,lease_until=null where id=$1",[task]);
 await db.query("update agent_missions set status='blocked' where id=$1",[mission]);
 await db.query("update work_projects set status='blocked' where id=$1",[project]);
 const approval=(await db.query('select * from benchmark_native_spending_approvals where id=$1',[renewal.approval_id])).rows[0],owner=approval.owner_id;
 const rpc='select benchmark_dashboard_development_amendment($1,$2,$3,$4,$5,$6) r';
 const planArgs=[owner,null,null,false,release,runtime];
 const snapshot=async()=>(await db.query(`select jsonb_build_object('approval',(select to_jsonb(a) from benchmark_native_spending_approvals a where id=$1),'continuation',(select to_jsonb(c) from benchmark_full_continuations c where id=$2),'mission',(select jsonb_build_object('deadline',deadline,'calls',calls,'actual',actual_tokens,'reserved',reserved_tokens,'limit',token_allowance,'maxCalls',max_calls) from agent_missions where id=$3),'spent',(select spent_tokens from benchmark_budget_accounts where id=$4),'calls',(select jsonb_agg(to_jsonb(c) order by id) from benchmark_budget_calls c where account_id=$4)) s`,[approval.id,approval.continuation_id,mission,grant.account_id])).rows[0].s;
 await assert.rejects(db.query("insert into benchmark_full_continuations select (jsonb_populate_record(null::benchmark_full_continuations,to_jsonb(c)||jsonb_build_object('id',gen_random_uuid(),'deadline',c.deadline+interval '1 second'))).* from benchmark_full_continuations c where previous_continuation_id is null limit 1"),/benchmark_full_continuations_check/);
 const before=await snapshot();assert.equal(before.mission.calls,9);assert.equal(before.mission.actual,79220);
 const plan=(await db.query(rpc,planArgs)).rows[0].r;
 assert.equal(plan.approved,false);assert.equal(plan.plan.resourceAmendment,true);assert.equal(plan.plan.developmentRemainingTokens,90780);assert.equal(plan.plan.assessmentTokens,60000);assert.equal(plan.plan.additionalTokenCap,150780);assert.equal(plan.plan.allocationIncreaseTokens,50000);assert.equal(plan.plan.maxCalls,24);assert.equal(plan.plan.callsRemaining,15);assert.equal(Date.parse(plan.deadline),approval.deadline.getTime());
 assert.deepEqual(await snapshot(),before,'GET does not change authority, balances, original limits or calls');
 assert.equal((await db.query('select count(*)::int n from benchmark_development_resource_amendments')).rows[0].n,0);
 assert.equal((await db.query('select benchmark_effective_mission_allowance($1,$2) n',[mission,approval.continuation_id])).rows[0].n,'120000');
 await assert.rejects(db.query(rpc,[randomUUID(),...planArgs.slice(1)]),/owner/);
 const approve=[owner,project,plan.planHash,true,release,runtime];
 await assert.rejects(db.query(rpc,[owner,project,'f'.repeat(64),true,release,runtime]),/exact current/);
 assert.equal((await db.query(rpc,[owner,null,null,false,release,'unknown'])).rows[0].r,null);
 for(const [sql,args] of [
  ['update benchmark_native_spending_approvals set revoked_at=now() where id=$1',[approval.id]],
  ["update benchmark_native_spending_approvals set deadline=now()-interval '1 second' where id=$1",[approval.id]],
  ['update benchmark_execution_grants set stopped_at=now() where id=$1',[grant.id]],
  ['update agent_missions set calls=calls+1 where id=$1',[mission]],
  ['update benchmark_budget_accounts set spent_tokens=spent_tokens+1 where id=$1',[grant.account_id]],
  ["update benchmark_budget_calls set state='unresolved' where id=$1",[before.calls[0].id]],
  ["update work_projects set approved_hash=repeat('f',64) where id=$1",[project]],
 ]){await db.query('begin');await db.query(sql,args);await assert.rejects(db.query(rpc,approve),/unavailable|current/);await db.query('rollback');}
 await db.query('begin');await db.query("update agent_tasks set external=external||'{\"amendmentTestStamp\":\"changed\"}'::jsonb where id=$1",[task]);await assert.rejects(db.query(rpc,approve),/exact current/);await db.query('rollback');
 const approvals=await Promise.all([db.query(rpc,approve),rival.query(rpc,approve)]),accepted=approvals[0].rows[0].r;
 assert.equal(accepted.id,approvals[1].rows[0].r.id);assert.equal(accepted.live,true);assert.notEqual(accepted.id,approval.continuation_id);
 assert.deepEqual(await snapshot(),before,'Owner amendment preserves every prior authority record and cumulative counter');
 const am=(await db.query('select * from benchmark_development_resource_amendments where project_id=$1',[project])).rows[0];
 assert.ok(!JSON.stringify(am.source_snapshot).includes('token_digest'));assert.equal(am.source_snapshot.mission.token_allowance,120000);assert.equal(am.source_snapshot.mission.max_calls,12);
 await assert.rejects(db.query("insert into benchmark_full_continuations select (jsonb_populate_record(null::benchmark_full_continuations,to_jsonb(c)||jsonb_build_object('id',gen_random_uuid(),'plan',c.plan-'deadline'))).* from benchmark_full_continuations c where id=$1",[accepted.id]),/benchmark_full_continuations_check/);
 await assert.rejects(db.query("insert into benchmark_full_continuations select (jsonb_populate_record(null::benchmark_full_continuations,to_jsonb(c)||jsonb_build_object('id',gen_random_uuid(),'previous_continuation_id',null))).* from benchmark_full_continuations c where id=$1",[accepted.id]),/check/);
 assert.equal((await db.query('select benchmark_continuation_live($1,$2,$3) ok',[accepted.id,grant.account_id,project])).rows[0].ok,true);
 assert.equal((await db.query('select benchmark_effective_mission_allowance($1,$2) n',[mission,accepted.id])).rows[0].n,'170000');
 assert.equal((await db.query('select benchmark_effective_mission_call_limit($1,$2) n',[mission,accepted.id])).rows[0].n,24);
 assert.equal((await db.query('select benchmark_effective_mission_allowance($1,$2) n',[mission,approval.continuation_id])).rows[0].n,'120000');
 await assert.rejects(db.query(reserve,[grant.token_digest,trial,5,randomUUID(),'gpt-5.3-codex',1]),/external session unauthorized/);
 // Neither legacy automatic retry route may consume the fresh owner approval.
 assert.equal((await db.query('select benchmark_development_pregrant_unused($1) ok',[am.renewal_id])).rows[0].ok,false);
 await assert.rejects(db.query('select benchmark_prepare_development_pregrant_recovery($1,$2,$3,$4,$5)',[am.renewal_id,129,{...failed,run_id:129},release,'3'.repeat(40)]),/unavailable/);
 await assert.rejects(db.query('select benchmark_claim_development_renewal_dispatch($1,$2,$3)',[am.renewal_id,failed,release]),/Resource amendment/);
 await assert.rejects(db.query('select benchmark_issue_development_renewal_grant($1,$2,$3,$4,$5)',[am.renewal_id,'7'.repeat(64),am.approval_id,task,release]),/Resource amendment/);
 const issue='select benchmark_issue_development_amendment_grant($1,$2,$3,$4,$5) g',issueArgs=[am.id,'7'.repeat(64),am.approval_id,task,release];
 await assert.rejects(db.query(issue,issueArgs),/unavailable/);
 assert.equal((await db.query('select benchmark_claim_development_amendment($1,$2) ok',[am.id,'3'.repeat(40)])).rows[0].ok,false);
 const work=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(work.job.id,task);
 const capacity=(await db.query('select mission_call_capacity($1,$2) c',[task,work.job.lease])).rows[0].c;assert.equal(capacity.remainingTokens,90780);assert.equal(capacity.callsRemaining,15);
 await db.query('begin');assert.equal((await db.query('select try_reserve_mission_capacity($1,$2,$3,$4,60000,false) ok',[task,work.job.lease,randomUUID(),'openai:gpt-5.3-codex'])).rows[0].ok,true);await db.query('rollback');
 assert.equal((await db.query("select save_project_development_dispatch($1,$2,'dispatching','Waiting for owner amendment dispatch',(select external from agent_tasks where id=$1)) t",[task,work.job.lease])).rows[0].t.id,task);
 assert.equal((await db.query("select commit_mission_work($1,$2,'{}','[]','waiting_external',null,null) ok",[task,work.job.lease])).rows[0].ok,true);
 const claims=await Promise.all([db.query('select benchmark_claim_development_amendment($1,$2) ok',[am.id,release]),rival.query('select benchmark_claim_development_amendment($1,$2) ok',[am.id,release])]);assert.equal(claims.filter(x=>x.rows[0].ok).length,1);
 for(const [index,value] of [[2,randomUUID()],[3,randomUUID()],[4,'3'.repeat(40)]]){const bad=[...issueArgs];bad[index]=value;await assert.rejects(db.query(issue,bad),/unavailable/);}
 await db.query('begin');await db.query('update benchmark_native_spending_approvals set revoked_at=now() where id=$1',[am.approval_id]);await assert.rejects(db.query(issue,issueArgs),/unavailable/);await db.query('rollback');
 await db.query('begin');await db.query("update benchmark_native_spending_approvals set deadline=now()-interval '1 second' where id=$1",[am.approval_id]);await assert.rejects(db.query(issue,issueArgs),/unavailable/);await db.query('rollback');
 const grants=await Promise.allSettled([db.query(issue,issueArgs),rival.query(issue,[am.id,'8'.repeat(64),am.approval_id,task,release])]);assert.equal(grants.filter(x=>x.status==='fulfilled').length,1);
 const issued=grants.find(x=>x.status==='fulfilled').value.rows[0].g,newGrant=(await db.query('select * from benchmark_execution_grants where id=$1',[issued.grantId])).rows[0];
 assert.equal(newGrant.execution_epoch,'6');assert.deepEqual(newGrant.deadline,grant.deadline);
 assert.equal((await db.query('select benchmark_development_paid_successor_capacity($1,$2) ok',[am.renewal_id,newGrant.id])).rows[0].ok,false);
 await assert.rejects(db.query(reserve,[newGrant.token_digest,trial,6,randomUUID(),'gpt-5.3-codex',90781]),/capacity/);
 const charged=[];
 for(let i=0;i<15;i++){
  const request=randomUUID(),tokenHold=i===0?60000:100;
  const id=(await db.query(reserve,[newGrant.token_digest,trial,6,request,'gpt-5.3-codex',tokenHold])).rows[0].id;charged.push(id);
  const linked=(await db.query('select legacy_mission_call_id from benchmark_budget_calls where id=$1',[id])).rows[0].legacy_mission_call_id;
  if(i===0)await assert.rejects(db.query(reserve,[newGrant.token_digest,trial,6,randomUUID(),'gpt-5.3-codex',40000]),/capacity/,'Concurrent holds share cumulative ceiling');
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-amendment-call-'+id,{input_tokens:60,output_tokens:10,total_tokens:70}]);
  if(i===4){
   await db.query('update mission_assignments set available_at=now() where id=$1',[task]);
   const work=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(work.job.id,task);
   const view=(await db.query('select mission_call_capacity($1,$2) c',[task,work.job.lease])).rows[0].c;assert.equal(view.callsRemaining,10);assert.equal(view.remainingTokens,90780-350);
   await db.query('begin');assert.equal((await db.query('select try_reserve_mission_capacity($1,$2,$3,$4,50000,false) ok',[task,work.job.lease,randomUUID(),'openai:gpt-5.3-codex'])).rows[0].ok,true);await db.query('rollback');
   assert.equal((await db.query("select commit_mission_work($1,$2,'{}','[]','waiting_external',null,null) ok",[task,work.job.lease])).rows[0].ok,true);
  }

 }
 await assert.rejects(db.query(reserve,[newGrant.token_digest,trial,6,randomUUID(),'gpt-5.3-codex',1]),/capacity/,'Cumulative call24 stops further calls');
 const after=await snapshot();assert.equal(after.mission.calls,24);assert.equal(after.mission.actual,79220+15*70);assert.equal(after.mission.limit,120000);assert.equal(after.mission.maxCalls,12);assert.equal(after.spent,before.spent+15*70);
 // Follow-through: the ordinary assessment reservation retains exactly60,000.
 await db.query('begin');
 const assessment=randomUUID(),team=(await db.query('select team from agent_missions where id=$1',[mission])).rows[0].team;
 await db.query('select create_mission($1,$2,$3,60,null)',[assessment,'Synthetic preserved assessment',team]);
 await db.query("update agent_missions set project_id=$2,project_kind='assessment',status='running',token_allowance=60000,deadline=least(now()+interval '1 hour',$3::timestamptz),project_evidence=jsonb_build_object('benchmarkContinuationId',$4::uuid) where id=$1",[assessment,project,accepted.deadline,accepted.id]);
 await db.query("update agent_missions set status='completed' where id=$1",[mission]);
 await db.query("update work_projects set phase='assessment',active_mission_id=$2 where id=$1",[project,assessment]);
 const assessmentJob=(await db.query('select id from mission_assignments where mission_id=$1 order by created_at,id limit 1',[assessment])).rows[0].id,lease=randomUUID();
 await db.query("update mission_assignments set status='running',role='compose',lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[assessmentJob,lease]);
 const assessmentCall=randomUUID();
 const reserved=(await db.query('select benchmark_reserve_mission_call($1,$2,$3,$4,60000,false) id',[assessmentJob,lease,assessmentCall,'openai:gpt-5.3-codex'])).rows[0].id;assert.ok(reserved);
 assert.equal((await db.query('select continuation_id from benchmark_budget_calls where id=$1',[reserved])).rows[0].continuation_id,accepted.id);
 assert.equal((await db.query('select benchmark_reserve_mission_call($1,$2,$3,$4,1,false) id',[assessmentJob,lease,randomUUID(),'openai:gpt-5.3-codex'])).rows[0].id,null);
 await db.query('rollback');
 for(const table of ['benchmark_development_resource_amendments','benchmark_development_amendment_dispatches','benchmark_development_amendment_grants'])assert.equal((await db.query("select has_table_privilege('service_role',$1,'UPDATE,DELETE,TRUNCATE') mutable",[table])).rows[0].mutable,false);
 await db.query('reset role');await db.query('set role authenticated');await assert.rejects(db.query(rpc,approve),/permission denied/);await assert.rejects(db.query(issue,issueArgs),/permission denied/);await db.query('reset role');await db.query('set role service_role');
}

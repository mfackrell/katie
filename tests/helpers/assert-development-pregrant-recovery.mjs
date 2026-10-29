import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function assertDevelopmentPregrantRecovery(db,rival,{renewal,project,mission,task,release,receipt,continuation}){
 const corrected='6'.repeat(40),failed={...receipt,run_id:126};
 await db.query("update agent_tasks set status='blocked',external=jsonb_set(external,'{receipt}',$2::jsonb) where id=$1",[task,failed]);
 await db.query("update mission_assignments set status='failed' where id=$1",[task]);
 await db.query("update agent_missions set status='blocked' where id=$1",[mission]);
 await db.query("update work_projects set status='blocked' where id=$1",[project]);
 const snapshot=async()=>(await db.query(`select jsonb_build_object('approval',(select to_jsonb(a) from benchmark_native_spending_approvals a where id=$1),'continuation',(select to_jsonb(c) from benchmark_full_continuations c where id=$2),'mission',(select jsonb_build_object('deadline',deadline,'calls',calls,'actual_tokens',actual_tokens,'reserved_tokens',reserved_tokens,'token_allowance',token_allowance) from agent_missions where id=$3),'dispatch',(select to_jsonb(d) from benchmark_development_renewal_dispatches d where renewal_id=$4),'account',(select to_jsonb(a) from benchmark_budget_accounts a join benchmark_full_continuations c on c.account_id=a.id where c.id=$2),'attempts',(select attempts from mission_assignments where id=$5)) s`,[renewal.approval_id,continuation,mission,renewal.id,task])).rows[0].s;
 const before=await snapshot();
 const prepare='select benchmark_prepare_development_pregrant_recovery($1,$2,$3,$4,$5) r',args=[renewal.id,126,failed,release,corrected];
 await assert.rejects(db.query(prepare,[renewal.id,126,failed,release,release]),/evidence/);
 await assert.rejects(db.query(prepare,[renewal.id,127,{...failed,run_id:127},release,corrected]),/evidence/);
 await db.query('begin');await db.query("update model_registry set pricing_status='estimated' where provider_name='openai' and model_id='gpt-5.3-codex'");
 await assert.rejects(db.query(prepare,args),/unavailable/);await db.query('rollback');
 await db.query('begin');await db.query('update benchmark_native_spending_approvals set consumed_at=now() where id=$1',[renewal.approval_id]);
 await assert.rejects(db.query(prepare,args),/unavailable/);await db.query('rollback');
 await db.query('begin');await db.query('update agent_missions set actual_tokens=actual_tokens+1 where id=$1',[mission]);
 await assert.rejects(db.query(prepare,args),/unavailable/);await db.query('rollback');
 await db.query('begin');await db.query('reset role');await db.query('alter table benchmark_budget_calls disable trigger user');
 await db.query("insert into benchmark_budget_calls(account_id,request_key,model,reserved_tokens,actual_tokens,state,continuation_id) select account_id,$2,'gpt-5.3-codex',1,0,'settled',id from benchmark_full_continuations where id=$1",[continuation,randomUUID()]);
 await db.query('set local role service_role');await assert.rejects(db.query(prepare,args),/unavailable/);await db.query('rollback');
 await db.query('begin');await db.query("update benchmark_native_spending_approvals set deadline=now()-interval '1 second' where id=$1",[renewal.approval_id]);
 await assert.rejects(db.query(prepare,args),/unavailable/);await db.query('rollback');
 await db.query('begin');await db.query('reset role');
 await db.query("insert into benchmark_execution_grants select (jsonb_populate_record(null::benchmark_execution_grants,to_jsonb(g)||jsonb_build_object('id',gen_random_uuid(),'token_digest',repeat('0',64),'continuation_id',$1::uuid,'execution_epoch',4,'created_at',now()))).* from benchmark_execution_grants g where mission_assignment_id=$2 limit 1",[continuation,task]);
 await db.query('set local role service_role');await assert.rejects(db.query(prepare,args),/unavailable/);await db.query('rollback');
 const records=await Promise.all([db.query(prepare,args),rival.query(prepare,args)]),rec=records[0].rows[0].r;
 assert.equal(rec.id,records[1].rows[0].r.id);assert.equal(rec.failed_run,126);assert.deepEqual(rec.receipt,failed);
 assert.deepEqual(await snapshot(),before,'Recovery does not renew authority, reset original deadlines/counters or erase the failed dispatch');
 await assert.rejects(db.query(prepare,[renewal.id,127,{...failed,run_id:127},release,corrected]),/already prepared/);
 await assert.rejects(db.query('select benchmark_issue_development_renewal_grant($1,$2,$3,$4,$5)',[renewal.id,'a'.repeat(64),renewal.approval_id,task,release]),/recovery transport/);
 const issue='select benchmark_issue_development_pregrant_recovery_grant($1,$2,$3,$4,$5) g';
 await assert.rejects(db.query(issue,[rec.id,'a'.repeat(64),renewal.approval_id,task,corrected]),/unavailable/);
 const claim=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(claim.job.id,task);assert.ok(Date.parse(claim.mission.deadline)>Date.now());
 const saved=(await db.query("select save_project_development_dispatch($1,$2,'dispatching','Pregrant recovery awaiting dispatch',(select external from agent_tasks where id=$1)) t",[task,claim.job.lease])).rows[0].t;assert.equal(saved.id,task);
 assert.equal((await db.query("select commit_mission_work($1,$2,'{}','[]','waiting_external',null,null) ok",[task,claim.job.lease])).rows[0].ok,true);
 assert.equal((await db.query('select benchmark_claim_development_pregrant_dispatch($1,$2) ok',[rec.id,release])).rows[0].ok,false);
 const claims=await Promise.all([db.query('select benchmark_claim_development_pregrant_dispatch($1,$2) ok',[rec.id,corrected]),rival.query('select benchmark_claim_development_pregrant_dispatch($1,$2) ok',[rec.id,corrected])]);assert.equal(claims.filter(x=>x.rows[0].ok).length,1);
 await assert.rejects(db.query(issue,[rec.id,'a'.repeat(64),renewal.approval_id,randomUUID(),corrected]),/unavailable/);
 await assert.rejects(db.query(issue,[rec.id,'a'.repeat(64),renewal.approval_id,task,release]),/unavailable/);
 await db.query('begin');await db.query('update benchmark_native_spending_approvals set revoked_at=now() where id=$1',[renewal.approval_id]);await assert.rejects(db.query(issue,[rec.id,'a'.repeat(64),renewal.approval_id,task,corrected]),/unavailable/);await db.query('rollback');
 await db.query('begin');await db.query("update benchmark_native_spending_approvals set deadline=now()-interval '1 second' where id=$1",[renewal.approval_id]);await assert.rejects(db.query(issue,[rec.id,'a'.repeat(64),renewal.approval_id,task,corrected]),/unavailable/);await db.query('rollback');
 for(const table of ['benchmark_development_pregrant_recoveries','benchmark_development_pregrant_dispatches']){
  assert.equal((await db.query("select has_table_privilege('service_role',$1,'UPDATE,DELETE,TRUNCATE') mutable",[table])).rows[0].mutable,false);
 }
 await db.query('reset role');await db.query('set role authenticated');await assert.rejects(db.query(prepare,args),/permission denied/);await assert.rejects(db.query(issue,[rec.id,'a'.repeat(64),renewal.approval_id,task,corrected]),/permission denied/);await db.query('reset role');await db.query('set role service_role');
 return {id:rec.id,release:corrected,issue};
}

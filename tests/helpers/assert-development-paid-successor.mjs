import {assertDevelopmentResourceAmendment} from './assert-development-resource-amendment.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function assertDevelopmentPaidSuccessor(db,rival,{renewal,project,mission,task,grant,trial,receipt,reserved}){
 const corrected='5'.repeat(40),failed={...receipt,run_id:127};
 const prepare='select benchmark_prepare_development_paid_successor($1,$2,$3,$4,$5,$6,$7,$8,$9) r';
 await db.query("update agent_tasks set status='blocked',external=jsonb_set(external,'{receipt}',$2::jsonb) where id=$1",[task,failed]);
 await db.query("update mission_assignments set status='failed',lease=null,lease_until=null where id=$1",[task]);
 await db.query("update agent_missions set status='blocked' where id=$1",[mission]);
 await db.query("update work_projects set status='blocked' where id=$1",[project]);
 const timing=(await db.query("select created_at-interval '1 second' started,clock_timestamp() finished from benchmark_execution_grants where id=$1",[grant.id])).rows[0];
 const args=[renewal.id,grant.id,127,failed,'6'.repeat(40),corrected,timing.started,timing.finished,'bounded-schema-v1'];
 await assert.rejects(db.query(prepare,args),/capacity unavailable/,'Unsettled hold prevents successor');
 const linked=(await db.query('select legacy_mission_call_id from benchmark_budget_calls where id=$1',[reserved])).rows[0].legacy_mission_call_id;
 await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-paid-successor-predecessor',{input_tokens:40,output_tokens:10,total_tokens:50}]);
 const snapshot=async()=>(await db.query(`select jsonb_build_object('approval',(select to_jsonb(a) from benchmark_native_spending_approvals a where id=$1),'renewalGrant',(select to_jsonb(g) from benchmark_development_renewal_grants g where renewal_id=$2),'mission',(select jsonb_build_object('deadline',deadline,'calls',calls,'actual',actual_tokens,'reserved',reserved_tokens,'limit',token_allowance,'maxCalls',max_calls) from agent_missions where id=$3),'account',(select to_jsonb(a) from benchmark_budget_accounts a where id=$4),'calls',(select jsonb_agg(to_jsonb(b) order by id) from benchmark_budget_calls b where account_id=$4)) s`,[renewal.approval_id,renewal.id,mission,grant.account_id])).rows[0].s;
 const before=await snapshot();
 for(const [sql,values] of [
  ['update benchmark_native_spending_approvals set revoked_at=now() where id=$1',[renewal.approval_id]],
  ["update benchmark_native_spending_approvals set deadline=now()-interval '1 second' where id=$1",[renewal.approval_id]],
  ["update work_projects set approved_hash=repeat('f',64) where id=$1",[project]],
  ['update agent_missions set actual_tokens=actual_tokens+1 where id=$1',[mission]],
  ['update benchmark_budget_accounts set spent_tokens=spent_tokens+1 where id=$1',[grant.account_id]],
  ["update benchmark_budget_calls set state='unresolved' where id=$1",[reserved]],
 ]){await db.query('begin');await db.query(sql,values);await assert.rejects(db.query(prepare,args),/capacity unavailable/);await db.query('rollback');}
 await db.query('begin');await db.query('update benchmark_execution_grants set stopped_at=now() where id=$1',[grant.id]);await assert.rejects(db.query(prepare,args),/Stopped execution/);await db.query('rollback');
 await db.query('begin');
 await db.query("insert into benchmark_execution_grants select (jsonb_populate_record(null::benchmark_execution_grants,to_jsonb(g)||jsonb_build_object('id',gen_random_uuid(),'token_digest',repeat('9',64),'execution_epoch',99,'created_at',now(),'stopped_at',null))).* from benchmark_execution_grants g where id=$1",[grant.id]);
 await assert.rejects(db.query(prepare,args),/capacity unavailable/,'Another active grant fences recovery');await db.query('rollback');
 await assert.rejects(db.query(prepare,[...args.slice(0,5),args[4],...args.slice(6)]),/evidence/);
 const records=await Promise.all([db.query(prepare,args),rival.query(prepare,args)]),rec=records[0].rows[0].r;
 assert.equal(rec.id,records[1].rows[0].r.id);assert.equal(rec.source_snapshot.oldGrant.token_digest,undefined);
 assert.deepEqual(await snapshot(),before,'Approval consumption, original grant link, balances and history unchanged');
 assert.ok((await db.query('select stopped_at from benchmark_execution_grants where id=$1',[grant.id])).rows[0].stopped_at);
 const reserve='select benchmark_full_native_reserve($1,$2,$3,$4,$5,$6) id';
 await assert.rejects(db.query(reserve,[grant.token_digest,trial,4,randomUUID(),'gpt-5.3-codex',1]),/external session unauthorized/);
 const issue='select benchmark_issue_development_paid_successor_grant($1,$2,$3,$4,$5) g',issueArgs=[rec.id,'c'.repeat(64),renewal.approval_id,task,corrected];
 await assert.rejects(db.query(issue,issueArgs),/unavailable/);
 assert.equal((await db.query('select benchmark_claim_development_paid_successor($1,$2) ok',[rec.id,'4'.repeat(40)])).rows[0].ok,false);
 const claims=await Promise.all([db.query('select benchmark_claim_development_paid_successor($1,$2) ok',[rec.id,corrected]),rival.query('select benchmark_claim_development_paid_successor($1,$2) ok',[rec.id,corrected])]);assert.equal(claims.filter(x=>x.rows[0].ok).length,1);
 for(const [index,value] of [[2,randomUUID()],[3,randomUUID()],[4,'4'.repeat(40)]]){const bad=[...issueArgs];bad[index]=value;await assert.rejects(db.query(issue,bad),/unavailable/);}
 await db.query('begin');await db.query('update benchmark_native_spending_approvals set revoked_at=now() where id=$1',[renewal.approval_id]);await assert.rejects(db.query(issue,issueArgs),/unavailable/);await db.query('rollback');
 await db.query('begin');await db.query("update benchmark_native_spending_approvals set deadline=now()-interval '1 second' where id=$1",[renewal.approval_id]);await assert.rejects(db.query(issue,issueArgs),/unavailable/);await db.query('rollback');
 const grants=await Promise.allSettled([db.query(issue,issueArgs),rival.query(issue,[rec.id,'d'.repeat(64),renewal.approval_id,task,corrected])]);assert.equal(grants.filter(x=>x.status==='fulfilled').length,1);
 const g=grants.find(x=>x.status==='fulfilled').value.rows[0].g,newGrant=(await db.query('select * from benchmark_execution_grants where id=$1',[g.grantId])).rows[0];
 assert.equal(newGrant.execution_epoch,'5');assert.deepEqual(newGrant.deadline,grant.deadline);assert.equal(newGrant.continuation_id,grant.continuation_id);assert.deepEqual(await snapshot(),before);
 await assert.rejects(db.query(prepare,[renewal.id,newGrant.id,...args.slice(2)]),/capacity unavailable/,'Successor cannot recursively recover');
 const remaining=120000-Number(before.mission.actual);
 await assert.rejects(db.query(reserve,[newGrant.token_digest,trial,5,randomUUID(),'gpt-5.3-codex',remaining+1]),/capacity/);
 const next=(await db.query(reserve,[newGrant.token_digest,trial,5,randomUUID(),'gpt-5.3-codex',100])).rows[0].id;
 const nextLinked=(await db.query('select legacy_mission_call_id from benchmark_budget_calls where id=$1',[next])).rows[0].legacy_mission_call_id;
 await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[nextLinked,'synthetic-paid-successor-call',{input_tokens:60,output_tokens:10,total_tokens:70}]);
 const after=await snapshot();assert.equal(after.mission.calls,before.mission.calls+1);assert.equal(after.mission.actual,before.mission.actual+70);assert.equal(after.mission.reserved,after.mission.actual);assert.equal(after.account.spent_tokens,before.account.spent_tokens+70);assert.deepEqual(after.approval,before.approval);
 await assertDevelopmentResourceAmendment(db,rival,{renewal,project,mission,task,grant:newGrant,trial,receipt});
 for(const table of ['benchmark_development_paid_successors','benchmark_development_paid_successor_dispatches','benchmark_development_paid_successor_grants'])assert.equal((await db.query("select has_table_privilege('service_role',$1,'UPDATE,DELETE,TRUNCATE') mutable",[table])).rows[0].mutable,false);
 await db.query('reset role');await db.query('set role authenticated');await assert.rejects(db.query(prepare,args),/permission denied/);await assert.rejects(db.query(issue,issueArgs),/permission denied/);await db.query('reset role');await db.query('set role service_role');
}

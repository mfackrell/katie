import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
export async function assertAmendmentSuccessor(db,rival,{am,g,project,mission,task,trial,owner,account}){
 await db.query('reset role');
 await db.query(readFileSync('supabase/migrations/20261030173250_benchmark_owner_amendment_successor.sql','utf8'));
 await db.query('set role service_role');
 const reserve='select benchmark_full_native_reserve($1,$2,$3,$4,$5,$6) id';
 for(const actual of [7207,11569,13845,14111]){
  const id=(await db.query(reserve,[g.token_digest,trial,g.execution_epoch,randomUUID(),'gpt-5.3-codex',actual+1000])).rows[0].id;
  const linked=(await db.query('select legacy_mission_call_id from benchmark_budget_calls where id=$1',[id])).rows[0].legacy_mission_call_id;
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-failed-'+id,{input_tokens:actual-100,output_tokens:100,total_tokens:actual}]);
 }
 const receipt={version:1,repository:'mfackrell/katie',run_id:129,issue_number:Number((await db.query("select external->>'issueNumber' n from agent_tasks where id=$1",[task])).rows[0].n),pr_url:null,outcome:'BLOCKED',tested_head_sha:null,reviewed_head_sha:null,checks:{build:'failure',test:'',review:'',repair:'skipped',retest:'',final_review:''}};
 await db.query("update agent_tasks set status='blocked',external=external||jsonb_build_object('receipt',$2::jsonb) where id=$1",[task,receipt]);
 await db.query("update mission_assignments set status='failed',lease=null,lease_until=null where id=$1",[task]);
 await db.query("update agent_missions set status='blocked' where id=$1",[mission]);
 await db.query("update work_projects set status='blocked',lease=null,lease_until=null where id=$1",[project]);
 const snapshot=async()=>(await db.query(`select jsonb_build_object('account',(select to_jsonb(a) from benchmark_budget_accounts a where id=$1),'calls',(select jsonb_agg(to_jsonb(x) order by id) from benchmark_budget_calls x where account_id=$1),'exposures',(select jsonb_agg(to_jsonb(x) order by call_id) from benchmark_dollar_exposures x where account_id=$1),'approvals',(select jsonb_agg(to_jsonb(x) order by id) from benchmark_native_spending_approvals x where account_id=$1),'continuations',(select jsonb_agg(to_jsonb(x) order by id) from benchmark_full_continuations x where account_id=$1),'mission',(select jsonb_build_object('actual',actual_tokens,'reserved',reserved_tokens,'calls',calls,'limit',token_allowance,'max',max_calls,'deadline',deadline) from agent_missions where id=$2)) s`,[account,mission])).rows[0].s;
 const before=await snapshot();assert.equal(before.account.spent_tokens,242673);
 const rpc='select benchmark_dashboard_amendment_successor($1,$2,$3,$4,$5,$6) r',release='a'.repeat(40);
 const offer=(await db.query(rpc,[owner,release,null,null,false,null])).rows[0].r;
 assert.ok(offer);assert.equal(offer.approved,false);assert.equal(offer.plan.developmentRemainingTokens,247327);assert.equal(offer.plan.callsRemaining,11);assert.equal(offer.plan.nativeCallsRemaining,7);assert.equal(offer.plan.assessmentTokens,60000);assert.equal(Date.parse(offer.deadline),g.deadline.getTime());
 assert.deepEqual(await snapshot(),before);
 assert.equal((await db.query('select benchmark_development_paid_successor_capacity($1,$2) ok',[am.renewal_id,g.id])).rows[0].ok,false);
 const run={id:129,head_sha:am.release_sha,started_at:new Date(g.created_at.getTime()-1000).toISOString(),finished_at:(await db.query('select clock_timestamp() n')).rows[0].n.toISOString()};
 const approve=[owner,release,project,offer.planHash,true,run];
 await assert.rejects(db.query(rpc,[randomUUID(),...approve.slice(1)]),/owner/);
 await assert.rejects(db.query(rpc,[owner,release,project,'f'.repeat(64),true,run]),/exact successor/);
 for(const sql of ["update benchmark_native_spending_approvals set revoked_at=now() where id='"+am.approval_id+"'", "update benchmark_execution_grants set deadline=now()-interval '1 second' where id='"+g.id+"'", "update benchmark_budget_calls set state='unresolved' where id=(select id from benchmark_budget_calls where account_id='"+account+"' limit 1)"]){await db.query('begin');await db.query(sql);await assert.rejects(db.query(rpc,approve),/unavailable|expired/);await db.query('rollback');}
 const approved=await Promise.all([db.query(rpc,approve),rival.query(rpc,approve)]);assert.equal(approved[0].rows[0].r.id,approved[1].rows[0].r.id);
 assert.deepEqual(await snapshot(),before,'successor consent cannot reset historical authority or spending');
 const s=(await db.query('select * from benchmark_development_paid_successors where renewal_id=$1',[am.renewal_id])).rows[0];
 assert.deepEqual(s.receipt,receipt);assert.equal(s.old_grant_id,g.id);
 const issue='select benchmark_issue_development_paid_successor_grant($1,$2,$3,$4,$5) r',args=[s.id,'e'.repeat(64),am.approval_id,task,release];
 await assert.rejects(db.query(issue,args),/unavailable/);
 const claims=await Promise.all([db.query('select benchmark_claim_development_paid_successor($1,$2) ok',[s.id,release]),rival.query('select benchmark_claim_development_paid_successor($1,$2) ok',[s.id,release])]);assert.equal(claims.filter(x=>x.rows[0].ok).length,1);
 await assert.rejects(db.query(issue,[s.id,'d'.repeat(64),am.approval_id,task,'b'.repeat(40)]),/unavailable/);
 const grants=await Promise.allSettled([db.query(issue,args),rival.query(issue,[s.id,'f'.repeat(64),...args.slice(2)])]);assert.equal(grants.filter(x=>x.status==='fulfilled').length,1);
 const ng=(await db.query('select * from benchmark_execution_grants where id=$1',[grants.find(x=>x.status==='fulfilled').value.rows[0].r.grantId])).rows[0];
 assert.deepEqual(ng.deadline,g.deadline);assert.deepEqual(await snapshot(),before);
 await assert.rejects(db.query(reserve,[g.token_digest,trial,g.execution_epoch,randomUUID(),'gpt-5.3-codex',1]),/unauthorized/);
 await assert.rejects(db.query(reserve,[ng.token_digest,trial,ng.execution_epoch,randomUUID(),'gpt-5.3-codex',247328]),/invalid native operation/);
 await db.query('begin');await db.query(reserve,[ng.token_digest,trial,ng.execution_epoch,randomUUID(),'gpt-5.3-codex',120000]);
 await assert.rejects(db.query(reserve,[ng.token_digest,trial,ng.execution_epoch,randomUUID(),'gpt-5.3-codex',120000]),/capacity|ceiling/);await db.query('rollback');
 await db.query('reset role');await db.query('begin');
 await db.query('update benchmark_dollar_exposures set exposure_microusd=exposure_microusd+(9999999-(select sum(exposure_microusd) from benchmark_dollar_exposures where account_id=$1)) where call_id=(select call_id from benchmark_dollar_exposures where account_id=$1 limit 1)',[account]);
 await db.query('set role service_role');await assert.rejects(db.query(reserve,[ng.token_digest,trial,ng.execution_epoch,randomUUID(),'gpt-5.3-codex',1000]),/dollar ceiling/);await db.query('rollback');await db.query('set role service_role');
 assert.deepEqual(await snapshot(),before);
 // The new grant still uses the same atomic dollar meter and uncertain holds.
 const id=(await db.query(reserve,[ng.token_digest,trial,ng.execution_epoch,randomUUID(),'gpt-5.3-codex',1000])).rows[0].id;
 assert.equal((await db.query('select count(*)::int n from benchmark_dollar_exposures where call_id=$1',[id])).rows[0].n,1);
 const linked=(await db.query('select legacy_mission_call_id from benchmark_budget_calls where id=$1',[id])).rows[0].legacy_mission_call_id;
 const exposure=(await db.query('select exposure_microusd from benchmark_dollar_exposures where call_id=$1',[id])).rows[0].exposure_microusd;
 await db.query('select benchmark_finish_mission_call($1,null)',[linked]);assert.equal((await db.query('select exposure_microusd from benchmark_dollar_exposures where call_id=$1',[id])).rows[0].exposure_microusd,exposure);
 await assert.rejects(db.query(issue,args),/unavailable/);
 await db.query('reset role');await db.query('set role authenticated');await assert.rejects(db.query(rpc,approve),/permission denied/);await assert.rejects(db.query('select * from benchmark_amendment_successor_consents'),/permission denied/);await db.query('reset role');await db.query('set role service_role');
 console.log('AMENDMENT_SUCCESSOR_POSTGRES_PASS: one owner consent, fixed deadline, historical preservation, duplicate and concurrent grants, original atomic admission');
}

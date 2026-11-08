import {prepareTask4aFinalFinancialSchema,installTask4aFinalFinancialAdmission} from './task4a-final-financial-schema.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const project='6d1c29f1-b31e-47a5-aabb-cbcf1326f388',task='d0e41ff5-149e-4319-9e65-dcc605fb75da',mission='d3fd3d95-7287-4bfc-8c97-c105fde46c36';
const account='8d94b8e8-0b7e-487b-83a7-d78fe6eded51',approval='ac443164-faf7-45be-96f1-cc93dfc85346',continuation='fb331001-f86b-4332-84eb-5d486bae1ee0',grant='939d9d7a-e101-4ec7-8af5-1561f1319b5f',release='f'.repeat(40);
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const rpc=async(db,name,args)=>(await one(db,'select '+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') v',args)).v;
const reject=async(db,fn,re)=>{await db.query('savepoint rejected_final');try{await assert.rejects(fn,re);}finally{await db.query('rollback to savepoint rejected_final');await db.query('release savepoint rejected_final');}};
export async function verifyTask4aFinalPostgres(db,{connect,owner,account:oldAccount,approval:oldApproval,continuation:oldContinuation}){
 await db.query('reset role');
 await prepareTask4aFinalFinancialSchema(db);
 // Fixture construction ONLY in disposable PostgreSQL. Preserve real schema,
 // then restore every trigger before installing/exercising the new migration.
 await db.query("set session_replication_role='replica'");
 for(const table of ['benchmark_budget_calls','benchmark_dollar_exposures'])await db.query('delete from '+table+' where account_id=$1',[oldAccount]);
 await db.query('delete from mission_calls where job_id=$1',[task]);
 for(const table of ['benchmark_native_spending_approvals','benchmark_execution_grants','benchmark_mission_bindings'])await db.query('update '+table+' set account_id=$2 where account_id=$1',[oldAccount,account]);
 await db.query('update benchmark_budget_accounts set id=$2,spent_tokens=147370 where id=$1',[oldAccount,account]);
 await db.query('update benchmark_execution_grants set developer_approval_id=$2 where developer_approval_id=$1',[oldApproval,approval]);
 await db.query('update benchmark_native_spending_approvals set id=$2,deadline=now()-interval \'1 hour\' where id=$1',[oldApproval,approval]);
 await db.query("update project_continuation_authorizations set id=$2,authorized_at=now()-interval '5 hours',deadline=now()-interval '1 hour' where id=$1",[oldContinuation,continuation]);
 await db.query("update benchmark_native_spending_approvals set developer_authority=jsonb_set(developer_authority,'{task4aContinuationId}',to_jsonb($2::text)) where id=$1",[approval,continuation]);
 await db.query('update benchmark_execution_grants set id=$2 where developer_approval_id=$1',[approval,grant]);
 const rows=JSON.parse(readFileSync('tests/fixtures/task4a-final-ledger.json','utf8'));
 const prior=(await one(db,'select predecessor_id from project_continuation_authorizations where id=$1',[continuation])).predecessor_id;
 for(const [i,r] of rows.entries()){
 await db.query("insert into mission_calls(id,job_id,lease,model,reserved_tokens,actual_tokens,status,project_continuation_id,project_actual_microusd,project_reserved_microusd,project_provider_request_id,project_provider_usage) values($1,$2,$3,$4,$5,$6,'completed',$7,$8,$9,$10,$11)",[r.request_key,task,grant,r.model,r.reserved_tokens,r.actual_tokens,i<8?prior:continuation,r.project_actual_microusd,r.project_reserved_microusd,r.provider_request_id,r.provider_usage]);
 await db.query("insert into benchmark_budget_calls(id,account_id,request_key,model,reserved_tokens,actual_tokens,state,legacy_mission_call_id,provider_request_id,provider_usage) values($1,$2,$3::text,$4,$5,$6,'settled',$3::uuid,$7,$8)",[r.id,account,r.request_key,r.model,r.reserved_tokens,r.actual_tokens,r.provider_request_id,r.provider_usage]);
 await db.query('insert into benchmark_dollar_exposures(account_id,call_id,exposure_microusd,reserved_microusd) values($1,$2,$3,$4)',[account,r.id,r.exposure_microusd,r.reserved_microusd]);
 }
 const claims=JSON.parse(readFileSync('tests/fixtures/task4a-final-claims.json','utf8'));
 for(const e of claims){await db.query('delete from project_events where project_id=$1 and event=$2',[project,e.event]);await db.query('insert into project_events(id,project_id,event,data) values($1,$2,$3,$4)',[e.id,project,e.event,e.data]);}
 await db.query("update agent_missions set status='blocked',actual_tokens=147370,reserved_tokens=147370,calls=12,deadline=now()-interval '1 hour' where id=$1",[mission]);
 await db.query("update work_projects set status='blocked',deadline=now()-interval '1 hour' where id=$1",[project]);
 await db.query("update mission_assignments set status='failed' where id=$1",[task]);
 await db.query("update agent_tasks set status='blocked',external=external||jsonb_build_object('developerApprovalId',$2::text,'task4aCapacityExecutionClaimId','c156d764-652f-4740-aa50-4ab8c5ab04e4','receipt',jsonb_build_object('run_id','42443455661','outcome','BLOCKED')) where id=$1",[task,approval]);
 await db.query("insert into benchmark_mission_bindings(mission_id,account_id,baseline_sha,developer_project_id) values($1,$2,'49c8a5f791e66c351436bb97839193b53d7a1cd1',$3) on conflict(mission_id) do update set account_id=excluded.account_id,developer_project_id=excluded.developer_project_id",[mission,account,project]);
 await db.query("set session_replication_role='origin'");
 await installTask4aFinalFinancialAdmission(db);
 await db.query(readFileSync('supabase/migrations/20261108134404_task4a_final_successor.sql','utf8'));
 const checkpoint={...JSON.parse(readFileSync('tests/fixtures/task4a-verification-first.json','utf8')),scopeHash:'debdfd441a9bb6b1106d2e09c56b6e7a2c494ce81f23890e104a625c8633c685',releaseSha:'c6320a8ec39c9a3749d2d3bc3b50f11e9368e5ed'};
 const snapshot=async()=>({b:(await db.query('select to_jsonb(b) v from benchmark_budget_calls b where account_id=$1 order by id',[account])).rows,m:(await db.query('select to_jsonb(m) v from mission_calls m where job_id=$1 order by id',[task])).rows,e:(await db.query('select to_jsonb(e) v from benchmark_dollar_exposures e where account_id=$1 order by call_id',[account])).rows,claims:(await db.query('select id,event,data from project_events where id=any($1::uuid[]) order by id',[claims.map(e=>e.id)])).rows});
 const before=await snapshot();
 await db.query('set role service_role');
 const offer=await rpc(db,'task4a_final_proposal',[release,checkpoint]);assert.equal(offer.ready,true,JSON.stringify(offer));
 assert.equal(offer.proposal.preservedAdmittedTokens,64920);assert.equal(offer.proposal.successorTokens,258204);assert.equal(offer.proposal.successorMicrousd,7394515);
 for(const role of ['anon','authenticated'])assert.equal((await one(db,"select has_function_privilege($1,'task4a_final_authorize(uuid,text,text,jsonb)','EXECUTE') v",[role])).v,false);
 await db.query('begin');
 for(const patch of [{checkpointSha:'0'.repeat(40)},{sourceTreeSha:'0'.repeat(40)},{approvalId:randomUUID()},{grantId:randomUUID()},{runId:'42102615797'}])assert.equal((await rpc(db,'task4a_final_proposal',[release,{...checkpoint,...patch}])).ready,false);
 await reject(db,()=>rpc(db,'task4a_final_authorize',[randomUUID(),offer.digest,release,checkpoint]),/CONSENT_DENIED/);
 await reject(db,()=>rpc(db,'task4a_final_authorize',[owner,'0'.repeat(64),release,checkpoint]),/CONSENT_DENIED/);
 for(const sql of ["update benchmark_budget_calls set provider_request_id='forged' where account_id='"+account+"'", "update mission_calls set project_reserved_microusd=project_reserved_microusd+1 where project_continuation_id='"+continuation+"'", "update work_projects set approved_hash=repeat('0',64) where id='"+project+"'", "update project_continuation_authorizations set incremental_tokens=incremental_tokens-1 where id='"+continuation+"'"]){
 await db.query('savepoint corrupt_final');await db.query('reset role');await db.query("set session_replication_role='replica'");await db.query(sql);await db.query("set session_replication_role='origin'");await db.query('set role service_role');assert.equal((await rpc(db,'task4a_final_proposal',[release,checkpoint])).ready,false,sql);await db.query('rollback to savepoint corrupt_final');await db.query('release savepoint corrupt_final');}
 await db.query('commit');
 const clients=await Promise.all([connect(),connect()]);
 try{
 for(const c of clients)await c.query('set role service_role');
 const results=await Promise.all(clients.map(c=>rpc(c,'task4a_final_authorize',[owner,offer.digest,release,checkpoint])));assert.deepEqual(results[0],results[1]);const child=results[0];
 assert.equal(child.dispatchAuthorized,false);assert.equal(child.paidInferenceAuthorized,false);assert.ok(Date.parse(child.deadline)>Date.now()+14390000);
 assert.equal(await rpc(db,'developer_claim_dispatch',[child.approvalId,release]),false);
 assert.equal(await rpc(db,'task4a_final_execution_claim',[release]),false);
 await db.query('begin');await reject(db,()=>rpc(db,'developer_issue_execution_grant',[child.approvalId,task,'a'.repeat(64),release]),/FORBIDDEN|binding/);await db.query('commit');
 for(const action of ['replacement','inference','dispatch']){
 const q=await rpc(db,'task4a_final_execution_proposal',[release,action]);assert.equal(q.ready,true,JSON.stringify(q));
 const consent=await Promise.allSettled(clients.map(c=>rpc(c,'task4a_final_execution_authorize',[owner,q.digest,release,action])));assert.equal(consent.filter(r=>r.status==='fulfilled').length,1);assert.equal(consent.filter(r=>r.status==='rejected').length,1);
 if(action!=='dispatch')assert.equal(await rpc(db,'task4a_final_execution_claim',[release]),false,'Every separate consent is required');
 }
 await db.query('begin');await db.query('reset role');await db.query("update work_projects set deadline=now()-interval '1 second' where id=$1",[project]);await db.query('set role service_role');assert.equal(await rpc(db,'task4a_final_execution_claim',[release]),false,'Expired consent fails closed');await db.query('rollback');
 const claimed=await Promise.all(clients.map(c=>rpc(c,'task4a_final_execution_claim',[release])));assert.equal(claimed.filter(Boolean).length,1);assert.equal(await rpc(db,'task4a_final_execution_claim',[release]),false);
 assert.equal(await rpc(db,'task4a_capacity_execution_ready',[child.approvalId,release]),true,'Inherited marker routes only this exact successor');
 const granted=await Promise.allSettled(clients.map((c,i)=>rpc(c,'developer_issue_execution_grant',[child.approvalId,task,String(i+7).repeat(64),release])));assert.equal(granted.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(granted));
 assert.deepEqual(await snapshot(),before,'All historical charges, receipts and consumed claims unchanged');
 const winner=granted.findIndex(r=>r.status==='fulfilled'),epoch=granted[winner].value.executionEpoch,token=String(winner+7).repeat(64);
 assert.ok((await one(db,'select developer_current_mission_authority($1) a',[mission])).a,'Actual mission/account binding required');
 const reserve=(c,tokens=23034)=>rpc(c,'task4a_native_reserve',[token,project,epoch,randomUUID(),'gpt-5.3-codex',tokens]);
 await db.query('begin');await reject(db,()=>reserve(db,23035),/ENVELOPE/);
 await reject(db,()=>rpc(db,'developer_native_reserve',[token,project,epoch,randomUUID(),'gpt-5.3-codex',23035]),/ENVELOPE/);
 await db.query('savepoint exhausted_native');await db.query('reset role');await db.query('update agent_missions set reserved_tokens=345574 where id=$1',[mission]);await db.query('set role service_role');
 await reject(db,()=>reserve(db),/capacity|reserve/i);await db.query('rollback to savepoint exhausted_native');await db.query('release savepoint exhausted_native');
 await db.query('savepoint changed_price');await db.query('reset role');await db.query("update model_registry set pricing_output_per_1m=15 where provider_name='openai' and model_id='gpt-5.3-codex'");await db.query('set role service_role');
 await reject(db,()=>reserve(db),/ENVELOPE|pricing/i);await db.query('rollback to savepoint changed_price');await db.query('release savepoint changed_price');await db.query('commit');
 // Original Task4A prohibits concurrent unsettled provider requests. Race
 // each remaining slot, settle its winner with local synthetic receipt, then
 // check persistent project reservations survive lower actual usage.
 for(let slot=0;slot<6;slot++){
 const attempts=await Promise.allSettled(clients.map(c=>reserve(c)));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(attempts));
 const op=attempts.find(r=>r.status==='fulfilled').value;
 const call=(await one(db,'select legacy_mission_call_id id from benchmark_budget_calls where id=$1',[op])).id;
 assert.equal(await rpc(db,'task4a_native_reconcile_provider_usage',[call,'fixture-final-provider-'+slot,{input_tokens:9000,output_tokens:1000,total_tokens:10000},true]),'settled');
 }
 await db.query('begin');await reject(db,()=>reserve(db),/ENVELOPE/);await db.query('commit');
 assert.equal((await one(db,'select sum(greatest(reserved_tokens,actual_tokens))::int n from mission_calls where project_continuation_id=$1',[child.continuationId])).n,138204);
 const remaining=await one(db,'select incremental_tokens-138204 n,assessment_reserve_tokens a,completion_reserve_tokens c from project_continuation_authorizations where id=$1',[child.continuationId]);assert.equal(Number(remaining.n),120000);assert.equal(Number(remaining.a),60000);assert.equal(Number(remaining.c),60000);
 console.log('TASK4A_FINAL_REAL_POSTGRES_CONSENT_CLAIM_GRANT_AND_RESERVATION_CONCURRENCY_PASS');
 }finally{await Promise.allSettled(clients.map(c=>c.end()));}
}

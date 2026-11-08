import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const project='6d1c29f1-b31e-47a5-aabb-cbcf1326f388',task='d0e41ff5-149e-4319-9e65-dcc605fb75da',mission='d3fd3d95-7287-4bfc-8c97-c105fde46c36';
const account='8d94b8e8-0b7e-487b-83a7-d78fe6eded51',approval='1961239b-1722-4901-b671-8e61f4e6af49',continuation='6e4eba28-2dbe-4faa-be93-5f24861dba3a',grant='36d66bdc-c907-49ca-859d-abfed5fc334e',release='e'.repeat(40);
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const rpc=async(db,name,args)=>(await one(db,'select '+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') v',args)).v;
const reject=async(db,fn,re)=>{await db.query('savepoint rejected_verifier');try{await assert.rejects(fn,re);}finally{await db.query('rollback to savepoint rejected_verifier');await db.query('release savepoint rejected_verifier');}};
export async function verifyTask4aVerifierPostgres(db,{connect,owner,priorChild}){
 await db.query('reset role');
 // Disposable fixture ONLY: reconstruct the authenticated fourth failed run
 // after the original final-successor tests. No production writes or inference.
 await db.query("set session_replication_role='replica'");
 await db.query('delete from benchmark_dollar_exposures where call_id in(select b.id from benchmark_budget_calls b join mission_calls m on m.id=b.legacy_mission_call_id where m.project_continuation_id=$1)',[priorChild.continuationId]);
 await db.query('delete from benchmark_budget_calls where legacy_mission_call_id in(select id from mission_calls where project_continuation_id=$1)',[priorChild.continuationId]);
 await db.query('delete from mission_calls where project_continuation_id=$1',[priorChild.continuationId]);
 await db.query('update benchmark_execution_grants set developer_approval_id=$2,id=$3 where developer_approval_id=$1',[priorChild.approvalId,approval,grant]);
 await db.query("update benchmark_native_spending_approvals set id=$2,deadline=now()-interval '1 hour',developer_authority=developer_authority||jsonb_build_object('task4aContinuationId',$3::text,'task4aFinalSuccessor',jsonb_build_object('version','final-successor-v1','consentDigest','fe812287c15db060927a2adf4767d9e9cd28d712deca78734c46bc312429129f','executionAuthorized',false)) where id=$1",[priorChild.approvalId,approval,continuation]);
 await db.query("update project_continuation_authorizations set id=$2,authorized_at=now()-interval '5 hours',deadline=now()-interval '1 hour' where id=$1",[priorChild.continuationId,continuation]);
 await db.query("update agent_missions set status='blocked',actual_tokens=147370,reserved_tokens=147370,calls=12,deadline=now()-interval '1 hour' where id=$1",[mission]);
 await db.query("update work_projects set status='blocked',deadline=now()-interval '1 hour' where id=$1",[project]);
 await db.query("update mission_assignments set status='failed' where id=$1",[task]);
 await db.query('update benchmark_budget_accounts set spent_tokens=147370 where id=$1',[account]);
 const claims=[{id:'bfe91e28-6769-4506-b7c9-0e38288fdbaf',event:'task4a_final_execution_claimed',data:{approvalId:approval,releaseSha:'61184faf4628d6fd9172cde8f16428e01700468b',consentDigest:'6ddefc5d78504d80594e4104e2a2476ad1b15572c40906a3b941e02a6706eb83',authorizationId:'9814961f-d244-4670-abd0-4214a3f1b113'}},{id:'a7c11f7a-1665-4ae0-92f8-c98977d95820',event:'task4a_final_execution_submitted',data:{claimId:'bfe91e28-6769-4506-b7c9-0e38288fdbaf',releaseSha:'61184faf4628d6fd9172cde8f16428e01700468b',acceptedByGithubApi:true}}];
 for(const e of claims){await db.query('delete from project_events where project_id=$1 and event=$2',[project,e.event]);await db.query('insert into project_events(id,project_id,event,data) values($1,$2,$3,$4)',[e.id,project,e.event,e.data]);}
 claims.push(...JSON.parse(readFileSync('tests/fixtures/task4a-final-claims.json','utf8')));
 await db.query("update agent_tasks set status='blocked',external=external||jsonb_build_object('developerApprovalId',$2::text,'task4aFinalExecutionClaimId','bfe91e28-6769-4506-b7c9-0e38288fdbaf','receipt',jsonb_build_object('run_id','42506385410','outcome','BLOCKED')) where id=$1",[task,approval]);
 for(const [table,id] of [['project_continuation_authorizations',continuation],['work_projects',project],['agent_missions',mission]])await db.query('update '+table+' set deadline=(select deadline from benchmark_native_spending_approvals where id=$2) where id=$1',[id,approval]);
 await db.query("set session_replication_role='origin'");
 await db.query(readFileSync('supabase/migrations/20261108204423_task4a_failed_verifier_recovery.sql','utf8'));
 const checkpoint={...JSON.parse(readFileSync('tests/fixtures/task4a-failed-verifier-checkpoint.json','utf8')),scopeHash:'debdfd441a9bb6b1106d2e09c56b6e7a2c494ce81f23890e104a625c8633c685',releaseSha:'61184faf4628d6fd9172cde8f16428e01700468b',artifactId:'13627283749',trustedJobId:'128809825644',artifactSha256:'9fc364377baf6fcde8ca415679961569c8b37e29ec548227455ef7fb25e4c40a'};
 const snapshot=async()=>({priorApproval:(await one(db,'select to_jsonb(a) v from benchmark_native_spending_approvals a where id=$1',[approval])).v,priorContinuation:(await one(db,'select to_jsonb(a) v from project_continuation_authorizations a where id=$1',[continuation])).v,b:(await db.query('select to_jsonb(b) v from benchmark_budget_calls b where account_id=$1 order by id',[account])).rows,m:(await db.query('select to_jsonb(m) v from mission_calls m where job_id=$1 order by id',[task])).rows,e:(await db.query('select to_jsonb(e) v from benchmark_dollar_exposures e where account_id=$1 order by call_id',[account])).rows,claims:(await db.query('select id,event,data from project_events where id=any($1::uuid[]) order by id',[claims.map(e=>e.id)])).rows});
 const before=await snapshot();
 await db.query('set role service_role');
 const offer=await rpc(db,'task4a_verifier_proposal',[release,checkpoint]); assert.equal(offer.ready,true,JSON.stringify(offer));
 assert.equal(offer.proposal.preservedAdmittedTokens,64920);assert.equal(offer.proposal.successorTokens,258204);assert.equal(offer.proposal.successorMicrousd,7394515);
 for(const role of ['anon','authenticated'])assert.equal((await one(db,"select has_function_privilege($1,'task4a_verifier_authorize(uuid,text,text,jsonb)','EXECUTE') v",[role])).v,false);
 await db.query('begin');
 for(const patch of [{checkpointSha:'0'.repeat(40)},{sourceTreeSha:'0'.repeat(40)},{approvalId:randomUUID()},{grantId:randomUUID()},{runId:'42102615797'},{artifactId:'1'},{trustedJobId:'1'},{artifactSha256:'0'.repeat(64)},{lastCompleted:{...checkpoint.lastCompleted,verification:{passed:true,pending:false}}}])assert.equal((await rpc(db,'task4a_verifier_proposal',[release,{...checkpoint,...patch}])).ready,false);
 await reject(db,()=>rpc(db,'task4a_verifier_authorize',[randomUUID(),offer.digest,release,checkpoint]),/CONSENT_DENIED/);
 await reject(db,()=>rpc(db,'task4a_verifier_authorize',[owner,'0'.repeat(64),release,checkpoint]),/CONSENT_DENIED/);
 for(const sql of ["update benchmark_budget_calls set provider_request_id='forged' where account_id='"+account+"'", "update mission_calls set project_reserved_microusd=project_reserved_microusd+1 where project_continuation_id='fb331001-f86b-4332-84eb-5d486bae1ee0'", "update work_projects set approved_hash=repeat('0',64) where id='"+project+"'", "update project_continuation_authorizations set incremental_tokens=incremental_tokens-1 where id='"+continuation+"'"]){
 await db.query('savepoint corrupt_final');await db.query('reset role');await db.query("set session_replication_role='replica'");await db.query(sql);await db.query("set session_replication_role='origin'");await db.query('set role service_role');assert.equal((await rpc(db,'task4a_verifier_proposal',[release,checkpoint])).ready,false,sql);await db.query('rollback to savepoint corrupt_final');await db.query('release savepoint corrupt_final');}
 await db.query('commit');
 await db.query('begin');await db.query('reset role');await db.query("set session_replication_role='replica'");
 for(const [table,id] of [['benchmark_native_spending_approvals',approval],['project_continuation_authorizations',continuation],['work_projects',project],['agent_missions',mission]])await db.query('update '+table+" set deadline=date_trunc('second',now())+interval '1 hour' where id=$1",[id]);
 await db.query("set session_replication_role='origin'");await db.query('set role service_role');const live=await rpc(db,'task4a_verifier_proposal',[release,checkpoint]);assert.equal(live.ready,true);assert.equal(live.proposal.renewDeadline,false);
 const kept=await rpc(db,'task4a_verifier_authorize',[owner,live.digest,release,checkpoint]);assert.equal(Date.parse(kept.deadline),Date.parse(live.proposal.oldDeadline));assert.equal(kept.continuationId,continuation);
 for(const action of ['replacement','inference','dispatch'])assert.equal((await rpc(db,'task4a_verifier_execution_proposal',[release,action])).ready,true);
 await db.query('rollback');
 assert.equal(offer.proposal.renewDeadline,true);assert.equal(offer.proposal.additionalNativeTokens,0);assert.equal(offer.proposal.additionalProjectTokens,0);assert.equal(offer.proposal.additionalCalls,0);assert.equal(offer.proposal.additionalMicrousd,0);
 const clients=await Promise.all([connect(),connect()]);
 try{
 for(const c of clients)await c.query('set role service_role');
 // Unrelated admission must reach its original guard without waiting for the
 // final-successor global lock (legacy admission locks the account first).
 await db.query('begin');await db.query("select pg_advisory_xact_lock(hashtextextended('katie.mission.state',0))");
 await clients[0].query('begin');await clients[0].query("set local statement_timeout='1000ms'");
 try{
 await assert.rejects(()=>clients[0].query("insert into benchmark_budget_calls(account_id,request_key,model,reserved_tokens) values($1,$2,'gpt-5.3-codex',1)",[account,randomUUID()]),/Ordinary financial admission denied/);
 }finally{await clients[0].query('rollback');await db.query('rollback');}
 const results=await Promise.all(clients.map(c=>rpc(c,'task4a_verifier_authorize',[owner,offer.digest,release,checkpoint])));assert.deepEqual(results[0],results[1]);const child=results[0];
 assert.deepEqual(await rpc(db,'task4a_verifier_authorize',[owner,offer.digest,release,checkpoint]),child,'Replay cannot renew deadline twice');
 assert.equal(child.dispatchAuthorized,false);assert.equal(child.paidInferenceAuthorized,false);assert.ok(Date.parse(child.deadline)>Date.now()+14390000);
 assert.equal(await rpc(db,'developer_claim_dispatch',[child.approvalId,release]),false);
 assert.equal(await rpc(db,'task4a_final_execution_claim',[release]),false,'Old consumed claim stays consumed');
 assert.equal(await rpc(db,'task4a_verifier_execution_claim',[release]),false);
 await db.query('begin');await reject(db,()=>rpc(db,'developer_issue_execution_grant',[child.approvalId,task,'a'.repeat(64),release]),/FORBIDDEN|binding/);await db.query('commit');
 for(const action of ['replacement','inference','dispatch']){
 const q=await rpc(db,'task4a_verifier_execution_proposal',[release,action]);assert.equal(q.ready,true,JSON.stringify(q));
 const consent=await Promise.allSettled(clients.map(c=>rpc(c,'task4a_verifier_execution_authorize',[owner,q.digest,release,action])));assert.equal(consent.filter(r=>r.status==='fulfilled').length,1);assert.equal(consent.filter(r=>r.status==='rejected').length,1);
 if(action!=='dispatch')assert.equal(await rpc(db,'task4a_verifier_execution_claim',[release]),false,'Every separate consent is required');
 }
 await db.query('begin');await db.query('reset role');await db.query("update work_projects set deadline=now()-interval '1 second' where id=$1",[project]);await db.query('set role service_role');assert.equal(await rpc(db,'task4a_verifier_execution_claim',[release]),false,'Expired consent fails closed');await db.query('rollback');
 const claimed=await Promise.all(clients.map(c=>rpc(c,'task4a_verifier_execution_claim',[release])));assert.equal(claimed.filter(Boolean).length,1);assert.equal(await rpc(db,'task4a_verifier_execution_claim',[release]),false);
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
 console.log('TASK4A_VERIFIER_REAL_POSTGRES_CONSENT_CLAIM_GRANT_AND_RESERVATION_CONCURRENCY_PASS');
 }finally{await Promise.allSettled(clients.map(c=>c.end()));}
}

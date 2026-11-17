import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const project='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const rpc=async(db,name,args)=>(await db.query('select '+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') v',args)).rows[0].v;
const reject=async(db,fn,re)=>{await db.query('savepoint denied_handoff');try{await assert.rejects(fn,re);}finally{await db.query('rollback to savepoint denied_handoff');await db.query('release savepoint denied_handoff');}};
export async function verifyTask4aVerifierHandoffPostgres(db,{clients,owner,child,release}){
 await db.query('reset role');
 const migration=readFileSync('supabase/migrations/20261109152013_task4a_verifier_release_handoff.sql','utf8');
 await db.query(migration);
 // Read immutable event identities from the migration's single source of truth.
 // These UUIDs identify audit rows; they are not authentication credentials.
 const financeId=migration.match(/finance from project_events where id='([^']+)'/)[1];
 const executionIds=[...migration.matchAll(/(?:when 'replacement' then|else) '([a-f0-9-]{36})'::uuid/g)].map(m=>m[1]);
 assert.equal(executionIds.length,2);
 // Disposable local fixture identities mirror the authenticated production rows.
 await db.query("set session_replication_role='replica'");
 for(const [event,id] of [['task4a_verifier_owner_authorized',financeId],['task4a_verifier_execution_authorized',executionIds[0]],['task4a_verifier_inference_authorized',executionIds[1]]])await db.query('update project_events set id=$3 where project_id=$1 and event=$2',[project,event,id]);
 await db.query("set session_replication_role='origin'");await db.query('set role service_role');
 const target='f'.repeat(40),evidence={version:'task4a-verifier-qualified-release-v1',repository:'mfackrell/katie',baselineSha:'cff4c7c2ea175ef1f9752f64a0cf2e023c8eecd3',releaseSha:target,qualifiedHeadSha:'a'.repeat(40),treeSha:'b'.repeat(40),pullRequest:1028,checks:Array.from({length:4},(_,i)=>({runId:100+i}))};
 const snapshot=async()=>({receipts:(await db.query("select id,event,data from project_events where project_id=$1 and event in ('task4a_verifier_owner_authorized','task4a_verifier_execution_authorized','task4a_verifier_inference_authorized') order by event",[project])).rows,
 approval:(await db.query('select to_jsonb(a) v from benchmark_native_spending_approvals a where id=$1',[child.approvalId])).rows,
 continuation:(await db.query('select to_jsonb(a) v from project_continuation_authorizations a where id=$1',[child.continuationId])).rows,
 grants:(await db.query('select id from benchmark_execution_grants order by id')).rows,
 task:(await db.query("select status,external from agent_tasks where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'")).rows});
 const before=await snapshot();
 const oldDispatch=await rpc(db,'task4a_verifier_execution_proposal',[release,'dispatch']);assert.equal(oldDispatch.ready,true);
 assert.equal((await rpc(db,'task4a_verifier_execution_proposal',[target,'dispatch'])).ready,false,'No implicit release transfer');
 const q=await rpc(db,'task4a_verifier_handoff_proposal',[target,evidence]);assert.equal(q.ready,true,JSON.stringify(q));
 assert.equal(q.proposal.deadline,oldDispatch.proposal.deadline);assert.equal(q.proposal.additionalTokens,0);assert.equal(q.proposal.additionalCalls,0);assert.equal(q.proposal.additionalMicrousd,0);
 for(const role of ['anon','authenticated'])for(const sig of ['task4a_verifier_handoff_proposal(text,jsonb)','task4a_verifier_handoff_authorize(uuid,text,text,jsonb)'])assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') v',[role,sig])).rows[0].v,false);
 assert.equal((await db.query("select has_function_privilege('service_role','task4a_verifier_execution_proposal_before_handoff(text,text)','EXECUTE') v")).rows[0].v,false);
 for(const bad of [null,{}, {...evidence,releaseSha:release},{...evidence,repository:'foreign/katie'},{...evidence,checks:[]}])assert.equal((await rpc(db,'task4a_verifier_handoff_proposal',[target,bad])).ready,false);
 await db.query('begin');
 await reject(db,()=>rpc(db,'task4a_verifier_handoff_authorize',[randomUUID(),q.digest,target,evidence]),/CONSENT_DENIED/);
 await reject(db,()=>rpc(db,'task4a_verifier_handoff_authorize',[owner,oldDispatch.digest,target,evidence]),/CONSENT_DENIED/);
 const corruptions=[
 "update benchmark_native_spending_approvals set deadline=now()-interval '1 second' where id='"+child.approvalId+"'",
 "update project_events set id=gen_random_uuid() where event='task4a_verifier_inference_authorized'",
 "update project_events set data=jsonb_set(data,'{proposal,checkpoint,sourceTreeSha}',to_jsonb(repeat('0',40))) where event='task4a_verifier_owner_authorized'",
 "update benchmark_native_spending_approvals set developer_authority=developer_authority-'checkpoint' where id='"+child.approvalId+"'",
 "update project_events set data=jsonb_set(data,'{ownerId}',to_jsonb(gen_random_uuid()::text)) where event='task4a_verifier_execution_authorized'",
 // A recomputed forged receipt hash is not sufficient: unchanged live authority must match.
 "update project_events set data=jsonb_set(data,'{proposal,envelope}', '{}'::jsonb) where event='task4a_verifier_inference_authorized'; update project_events set data=jsonb_set(data,'{consentDigest}',to_jsonb(encode(sha256(convert_to(project_canonical(data->'proposal'),'UTF8')),'hex'))) where event='task4a_verifier_inference_authorized'",
 "update benchmark_budget_calls set provider_request_id='forged' where account_id='8d94b8e8-0b7e-487b-83a7-d78fe6eded51'",
 "update project_continuation_authorizations set incremental_tokens=incremental_tokens-1 where id='"+child.continuationId+"'"
 ];
 for(const sql of corruptions){await db.query('savepoint corrupt_handoff');await db.query('reset role');await db.query("set session_replication_role='replica'");await db.query(sql);await db.query("set session_replication_role='origin'");await db.query('set role service_role');assert.equal((await rpc(db,'task4a_verifier_handoff_proposal',[target,evidence])).ready,false,sql);await db.query('rollback to savepoint corrupt_handoff');await db.query('release savepoint corrupt_handoff');}
 await db.query('commit');
 const results=await Promise.allSettled(clients.map(c=>rpc(c,'task4a_verifier_handoff_authorize',[owner,q.digest,target,evidence])));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(results));assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.deepEqual(await snapshot(),before,'Handoff only appends one receipt: no grants, tasks, financial or consent mutation');
 assert.equal(await rpc(db,'task4a_verifier_execution_claim',[target]),false,'Fresh separate dispatch required');
 assert.equal(await rpc(db,'task4a_verifier_execution_claim',[release]),false,'Old release cannot execute');
 assert.equal((await rpc(db,'task4a_verifier_execution_proposal',[release,'dispatch'])).ready,false);
 assert.equal((await rpc(db,'task4a_verifier_execution_proposal',['c'.repeat(40),'dispatch'])).ready,false,'Receipt cannot transfer to another release');
 assert.equal((await rpc(db,'task4a_verifier_handoff_proposal',[target,evidence])).ready,false,'One handoff only');
 const dispatch=await rpc(db,'task4a_verifier_execution_proposal',[target,'dispatch']);assert.equal(dispatch.ready,true);assert.notEqual(dispatch.digest,oldDispatch.digest);assert.equal(dispatch.proposal.releaseSha,target);
 await db.query('begin');
 await reject(db,()=>rpc(db,'task4a_verifier_handoff_authorize',[owner,q.digest,target,evidence]),/CONSENT_DENIED/);
 await reject(db,()=>rpc(db,'task4a_verifier_execution_authorize',[owner,oldDispatch.digest,target,'dispatch']),/CONSENT_DENIED/);
 await reject(db,()=>db.query("delete from project_events where event='task4a_verifier_release_handoff_authorized'"),/permission denied/);
 await db.query('reset role');
 await reject(db,()=>db.query("delete from project_events where event='task4a_verifier_release_handoff_authorized'"),/IMMUTABLE/);
 await reject(db,()=>db.query("update project_events set data='{}' where event='task4a_verifier_release_handoff_authorized'"),/IMMUTABLE/);
 await db.query('set role service_role');await db.query('commit');
 const consent=await Promise.allSettled(clients.map(c=>rpc(c,'task4a_verifier_execution_authorize',[owner,dispatch.digest,target,'dispatch'])));
 assert.equal(consent.filter(r=>r.status==='fulfilled').length,1);assert.equal(consent.filter(r=>r.status==='rejected').length,1);
 console.log('TASK4A_VERIFIER_HANDOFF_REAL_POSTGRES_IMMUTABILITY_AUTHORIZATION_REPLAY_CONCURRENCY_PASS');
 return target;
}

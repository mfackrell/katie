import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const project='6d1c29f1-b31e-47a5-aabb-cbcf1326f388',task='d0e41ff5-149e-4319-9e65-dcc605fb75da';
const oldRelease='25363d8cd0906e7915c4e0aa6443142a95a76c20',newRelease='f'.repeat(40);
const claimId='f105fde0-1e35-4aaf-80c6-b80645701325';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const rpc=async(db,name,args)=>(await one(db,'select '+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') v',args)).v;
const reject=async(db,fn,pattern)=>{await db.query('savepoint denied');try{await assert.rejects(fn(),pattern);}finally{await db.query('rollback to savepoint denied');await db.query('release savepoint denied');}};
export async function verifyTask4aReplacementPostgres(db,{connect,owner,account,approval}){
 await db.query('reset role');
 // Construct exact post-failure state ONLY in disposable PostgreSQL. This is
 // fixture setup before installing replacement code, never recovery behavior.
 await db.query('alter table project_events disable trigger user');
 const old=await one(db,"select id from project_events where project_id=$1 and event='task4a_postpaid_dispatch_claimed'",[project]);
 await db.query('update project_events set id=$2 where id=$1',[old.id,claimId]);
 await db.query("update project_events set data=jsonb_set(data,'{claimReceiptId}',to_jsonb($2::text)) where project_id=$1 and event='task4a_postpaid_dispatch_submitted'",[project,claimId]);
 await db.query('alter table project_events enable trigger user');
 await db.query("update work_projects set status='blocked' where id=$1",[project]);
 await db.query("update agent_missions set status='blocked' where project_id=$1 and project_kind='development'",[project]);
 await db.query("update mission_assignments set status='failed' where id=$1",[task]);
 await db.query("update agent_tasks set status='blocked',external=external||jsonb_build_object('task4aPostpaidDispatchClaimId',$2::text,'receipt',jsonb_build_object('run_id',42395083318,'repository','mfackrell/katie','issue_number',969,'outcome','BLOCKED','pr_url',null)) where id=$1",[task,claimId]);
 await db.query('alter table benchmark_execution_grants add column if not exists trial_id uuid,add column if not exists owner_actor_id uuid,add column if not exists protocol_digest text,add column if not exists repository text,add column if not exists model text');
 await db.query('create table if not exists benchmark_full_project_bindings(project_id uuid)');
 await db.query('create table if not exists benchmark_development_dispatches(task_id uuid)');
 await db.query('alter table work_projects add column if not exists completion_contract jsonb');
 await db.query('alter table benchmark_native_spending_approvals disable trigger user');
 await db.query("update benchmark_native_spending_approvals set developer_authority=developer_authority||jsonb_build_object('completionContract',(select completion_contract from work_projects where id=$2)) where id=$1",[approval,project]);
 await db.query('alter table benchmark_native_spending_approvals enable trigger user');
 const original=readFileSync('supabase/migrations/20261101160000_ordinary_developer_authority.sql','utf8');
 for(const name of ['developer_task_binding','developer_issue_execution_grant','developer_gateway_execution_live']){
  const at=original.indexOf('create function '+name+'('),end=original.indexOf('end $$;',at);
  assert.ok(at>=0&&end>at,name+' actual production function must be loaded');
  await db.query(original.slice(at,end+7).replace('create function','create or replace function'));
 }
 await db.query(readFileSync('supabase/migrations/20261107183028_task4a_failed_run_replacement.sql','utf8'));
 const native=await one(db,'select developer_authority from benchmark_native_spending_approvals where id=$1',[approval]);
 const evidence={version:'task4a-failed-run-link-v1',projectId:project,taskId:task,approvalId:approval,consumedClaimId:claimId,
  failedRunId:42395083318,originalRunId:42102615797,failedReleaseSha:oldRelease,
  originalReleaseSha:'d530aa94dd8d9c2bc442b43b324ace312d0d62b9',checkpointSha:'8e53ce01693303fc50daf5da1567e93e725f9b2d',
  hostSha256:'87555681d7546761b8014179b7a1e19258fc57ec84bed3b82eacf7e23bff3904',buildLogSha256:'b'.repeat(64),
  noProviderCalls:true,noSourceModifications:true,checkpointDigest:native.developer_authority.checkpoint.digest};
 const history=await db.query("select id,event,data from project_events where project_id=$1 and event like 'task4a_postpaid%' order by id",[project]);
 const before=(await one(db,'select to_jsonb(a) a from benchmark_native_spending_approvals a where id=$1',[approval])).a;
 await db.query('set role service_role');
 const offer=await rpc(db,'task4a_replacement_proposal',[newRelease,evidence]);
 assert.equal(offer.ready,true,JSON.stringify(offer));
 assert.equal(offer.proposal.nativeLimits.ceilingMicrousd,9000000);
 for(const role of ['anon','authenticated']){
  assert.equal((await one(db,"select has_function_privilege($1,'public.task4a_replacement_authorize(uuid,text,text,jsonb)','EXECUTE') allowed",[role])).allowed,false);
 }
 await db.query('begin');
 await reject(db,()=>rpc(db,'task4a_replacement_authorize',[randomUUID(),offer.digest,newRelease,evidence]),/OWNER_CONSENT_DENIED/);
 await reject(db,()=>rpc(db,'task4a_replacement_authorize',[owner,'0'.repeat(64),newRelease,evidence]),/OWNER_CONSENT_DENIED/);
 for(const altered of [{...evidence,noProviderCalls:false},{...evidence,checkpointDigest:'0'.repeat(64)},{...evidence,failedRunId:42102615797}])
  assert.equal((await rpc(db,'task4a_replacement_proposal',[newRelease,altered])).ready,false);
 await db.query('savepoint expired');await db.query('reset role');
 await db.query("update work_projects set deadline=now()-interval '1 second' where id=$1",[project]);
 await db.query('set role service_role');
 assert.equal((await rpc(db,'task4a_replacement_proposal',[newRelease,evidence])).ready,false,'Expired authority cannot be renewed implicitly');
 await db.query('rollback to savepoint expired');await db.query('release savepoint expired');
 assert.equal(await rpc(db,'task4a_replacement_claim',[newRelease]),false,'No owner consent');
 await db.query('commit');
 const clients=await Promise.all([connect(),connect()]);
 try{
  for(const c of clients)await c.query('set role service_role');
  const decisions=await Promise.allSettled(clients.map(c=>rpc(c,'task4a_replacement_authorize',[owner,offer.digest,newRelease,evidence])));
  assert.equal(decisions.filter(x=>x.status==='fulfilled'&&x.value.authorized).length,1);
  assert.equal(decisions.filter(x=>x.status==='rejected').length,1);
  assert.equal(await rpc(db,'task4a_postpaid_grant_ready',[approval,newRelease]),false,'Consent alone is not a claim');
  const claims=await Promise.all(clients.map(c=>rpc(c,'task4a_replacement_claim',[newRelease])));
  assert.equal(claims.filter(Boolean).length,1,'Two concurrent requests admit only one replacement');
  assert.equal(await rpc(db,'task4a_replacement_claim',[newRelease]),false,'No claim replay');
  assert.equal(await rpc(db,'task4a_replacement_authentic',[newRelease]),true);
  assert.equal(await rpc(db,'task4a_postpaid_grant_ready',[approval,newRelease]),true);
  assert.equal(await rpc(db,'task4a_postpaid_grant_ready',[approval,oldRelease]),false);
  assert.equal(await rpc(db,'task4a_replacement_record_submitted',[newRelease]),true);
  assert.equal(await rpc(db,'task4a_replacement_record_submitted',[newRelease]),false);
  await db.query('begin');
  await reject(db,()=>db.query("update project_events set data='{}' where project_id=$1 and event='task4a_replacement_authorized'",[project]),/permission denied/);
  await db.query('reset role');
  await reject(db,()=>db.query("update project_events set data='{}' where project_id=$1 and event='task4a_replacement_authorized'",[project]),/IMMUTABLE/);
  await reject(db,()=>db.query("delete from project_events where project_id=$1 and event='task4a_postpaid_dispatch_claimed'",[project]),/IMMUTABLE/);
  await db.query('set role service_role');
  await reject(db,()=>rpc(db,'developer_issue_execution_grant',[approval,task,'a'.repeat(64),oldRelease]),/dispatch binding/);
  await db.query('commit');
  assert.deepEqual((await db.query("select id,event,data from project_events where project_id=$1 and event like 'task4a_postpaid%' order by id",[project])).rows,history.rows,'All historical owner receipts and consumed claim preserved');
  assert.deepEqual((await one(db,'select to_jsonb(a) a from benchmark_native_spending_approvals a where id=$1',[approval])).a,before,'No financial or deadline mutation');
  const grants=await Promise.allSettled(clients.map((c,i)=>rpc(c,'developer_issue_execution_grant',[approval,task,String(i+1).repeat(64),newRelease])));
  const accepted=grants.filter(x=>x.status==='fulfilled');assert.equal(accepted.length,1,JSON.stringify(grants));
  assert.equal(grants.filter(x=>x.status==='rejected').length,1,'Actual production grant must be single-use');
  const winner=grants.findIndex(x=>x.status==='fulfilled');
  assert.equal(await rpc(db,'developer_gateway_execution_live',[String(winner+1).repeat(64),project,accepted[0].value.executionEpoch]),true,'Actual production gateway live gate');
  assert.equal((await one(db,'select count(*)::int n from benchmark_budget_calls where account_id=$1',[account])).n,4,'No provider calls from qualification');
  console.log('TASK4A_REPLACEMENT_REAL_POSTGRES_TWO_CONNECTION_CLAIM_AND_PRODUCTION_NATIVE_GRANT_PASS');
 }finally{await Promise.allSettled(clients.map(c=>c.end()));}
}

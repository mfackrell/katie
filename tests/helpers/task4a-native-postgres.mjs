import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const project='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const historical='d35b71d3-fbe2-4e9b-8bde-4d0fe8c9968e';
const query=(db,sql,args=[])=>db.query(sql,args);
const one=async(db,sql,args=[])=> (await query(db,sql,args)).rows[0];

export async function verifyTask4aNativePostgres(db,connect){
 await query(db,'reset role');
 await query(db,'begin');
 const original=await one(db,"select team from work_projects where id='44444444-4444-4444-8444-444444444444'");
 assert.ok(original?.team?.length>=2);
 const team=original.team,actor=randomUUID(),chat=randomUUID(),owner=randomUUID(),repo=randomUUID();
 const dev=await one(db,"select j.agent_id from mission_assignments j join work_projects p on p.active_mission_id=j.mission_id where p.id='44444444-4444-4444-8444-444444444444' and j.role='development' limit 1");
 assert.ok(dev?.agent_id&&team.includes(dev.agent_id),'Fixture must use a saved developer-capable agent');
 const mission=randomUUID(),task=randomUUID(),grant=randomUUID(),source='c'.repeat(40);
 const scope='a'.repeat(64),contract='b'.repeat(64),digest='d'.repeat(64);
 const pgid=randomUUID(),authorization=randomUUID();
 await query(db,'insert into actors(id,name) values($1,$2)',[actor,'Native synthetic original owner']);
 await query(db,'insert into chats(id,actor_id,title) values($1,$2,$3)',[chat,actor,'Synthetic Task4A original']);
 await query(db,'insert into repo_sync_runs(id,repository_full_name) values($1,$2)',[repo,'mfackrell/katie']);
 await query(db,'insert into standalone_owner_bindings(owner_id,actor_id,chat_id) values($1,$2,$3)',[owner,actor,chat]);
 await query(db,"insert into work_projects(id,request_id,actor_id,chat_id,objective,team,status,phase,token_allowance,deadline,repository_id,baseline_sha,approved_hash,approval_hash,completion_contract) values($1,$2,$3,$4,'Synthetic Task4A', $5,'paused','research',600000,now()+interval '8 hours',$6,$7,$8,$8,$9)",[
  project,'task4a-native-'+randomUUID(),actor,chat,team,repo,source,scope,{version:1,outcome:'Synthetic original Task4A browser',stoppingCondition:'Verified protected preview'}
 ]);
 await query(db,'select create_mission($1,$2,$3,120,null)',[historical,'Saved original research',team]);
 await query(db,"update agent_missions set project_id=$2,project_kind='research',status='blocked',actual_tokens=76519,reserved_tokens=76519,calls=4,routing_calls=5,deadline=now()-interval '1 minute' where id=$1",[historical,project]);
 await query(db,'select create_mission($1,$2,$3,120,null)',[mission,'Approved synthetic development',team]);
 await query(db,"update agent_missions set project_id=$2,project_kind='development',status='running',token_allowance=120000,deadline=now()+interval '4 hours' where id=$1",[mission,project]);
 await query(db,'update work_projects set active_mission_id=$2 where id=$1',[project,mission]);
 await query(db,'insert into project_runs(project_id,mission_id,kind,ordinal,milestone_index,binding) values($1,$2,$3,1,0,$4)',[
  project,mission,'development',{projectId:project,scopeHash:scope,contractHash:contract,baselineSha:source,baseSha:source,version:1,contract:{path:'/pilot',scenarios:[{name:'state',steps:[{action:'expectText',selector:'#state',value:'Ready'}]}]}}
 ]);
 await query(db,"insert into mission_assignments(id,mission_id,job_key,role,agent_id,instruction,status) values($1,$2,'develop','development',$3,'Approved native synthetic execution','waiting_external')",[task,mission,dev.agent_id]);
 await query(db,"select create_agent_task($1,$2,'Synthetic native browser app','development',$3)",[task,dev.agent_id,repo]);
 await query(db,"update agent_tasks set status='dispatching',external='{}'::jsonb where id=$1",[task]);
 await query(db,"insert into project_continuation_authorizations(id,project_id,actor_id,chat_id,source_mission_id,approval_digest,deadline,incremental_tokens,incremental_calls,incremental_microusd,assessment_reserve_tokens,completion_reserve_tokens,assessment_reserve_calls,completion_reserve_calls,allowed_models,historical_tokens,historical_calls,historical_mission_deadline,pricing_evidence) values($1,$2,$3,$4,$5,$6,now()+interval '4 hours',440326,53,15000000,60000,60000,6,6,array['openai:gpt-5.6-sol','openai:gpt-5.3-codex'],76519,9,now()-interval '1 minute','[]'::jsonb)",[
  authorization,project,actor,chat,historical,digest
 ]);
 await query(db,"update model_registry set pricing_status='verified',pricing_verified_at=now(),source_metadata=jsonb_build_object('pricing_verification_source','https://developers.openai.com/api/docs/models/gpt-5.3-codex') where provider_name='openai' and model_id='gpt-5.3-codex'");
 await query(db,'set role service_role');
 const prep=()=>one(db,'select task4a_prepare_native_development($1,$2,$3,$4,$5) ok',[project,task,scope,contract,source]);
 assert.equal((await prep()).ok,false,'Owner pause cannot prepare native authority');
 await query(db,'reset role');
 await query(db,"update work_projects set status='running',phase='development' where id=$1",[project]);
 await query(db,'set role service_role');
 assert.equal((await prep()).ok,true);
 assert.equal((await prep()).ok,true,'Task authority preparation is idempotent');
 const a=await one(db,'select id,account_id,developer_authority from benchmark_native_spending_approvals where task_id=$1',[task]);
 assert.equal(a.developer_authority.task4aContinuationId,authorization);
 assert.equal((await one(db,'select count(*)::int n from benchmark_budget_accounts where developer_task_id=$1',[task])).n,1);
 const hash='e'.repeat(64);
 await query(db,'reset role');
 await query(db,"update benchmark_native_spending_approvals set consumed_at=now() where id=$1",[a.id]);
 await query(db,'update agent_tasks set external=$2::jsonb where id=$1',[task,JSON.stringify({developerApprovalId:a.id,developerReleaseSha:source})]);
 await query(db,"insert into benchmark_execution_grants(id,token_digest,project_id,execution_epoch,developer_approval_id,mission_assignment_id,deadline) values($1,$2,$3,1,$4,$5,now()+interval '3 hours')",[grant,hash,project,a.id,task]);
 await query(db,'set role service_role');
 const live=async()=> (await one(db,'select task4a_native_live($1,$2,1) ok',[hash,project])).ok;
 const reserve=async(tokens=1000,model='gpt-5.3-codex',call=randomUUID())=>{
  const row=await one(db,'select task4a_native_reserve($1,$2,1,$3,$4,$5) op',[hash,project,call,model,tokens]);
  return {call,op:row.op};
 };
 const usage=(input=300,output=200)=>({input_tokens:input,output_tokens:output,total_tokens:input+output});
 const settle=async(call,request,record=usage())=> (await one(db,
  'select task4a_native_reconcile_provider_usage($1,$2,$3::jsonb,true) state',[call,request,record])).state;
 assert.equal(await live(),true);
 await assert.rejects(reserve(1000,'unapproved-model'),/model denied/);
 // A near-limit multi-call sequence below proves protected reserves cannot be borrowed.
 const first=await reserve();
 assert.ok(first.op,'Native admission produces one existing canonical operation');
 const booked=await one(db,'select * from mission_calls where id=$1',[first.call]);
 assert.equal(booked.project_continuation_id,authorization);
 assert.equal(booked.project_pricing_evidence.model,'openai:gpt-5.3-codex');
 assert.ok(Number(booked.project_reserved_microusd)>0);
 await assert.rejects(reserve(),/unresolved/,'No second call while first provider receipt is missing');
 assert.equal(await settle(first.call,'provider-response-one'), 'settled');
 assert.equal(await settle(first.call,'provider-response-one'), 'settled','Exact same receipt replays without new usage');
 await assert.rejects(settle(first.call,'provider-response-other'),/association denied|conflict/);
 assert.equal((await one(db,'select count(*)::int n from mission_calls where id=$1',[first.call])).n,1);
 assert.equal((await one(db,'select actual_tokens from mission_calls where id=$1',[first.call])).actual_tokens,500);
 const intact=await one(db,'select actual_tokens,calls,routing_calls from agent_missions where id=$1',[historical]);
 assert.equal(Number(intact.actual_tokens),76519);assert.equal(intact.calls,4);assert.equal(intact.routing_calls,5);
 await query(db,'reset role');await query(db,"update model_registry set pricing_status='missing' where model_id='gpt-5.3-codex'");await query(db,'set role service_role');
 await assert.rejects(reserve(),/pricing unverified/);
 await query(db,'reset role');await query(db,"update model_registry set pricing_status='verified',pricing_output_per_1m=10000 where model_id='gpt-5.3-codex'");await query(db,'set role service_role');
 await assert.rejects(reserve(1000),/capacity|reserve exhausted/,'Adversarial price hike must enforce dollar ceiling');
 await query(db,'reset role');await query(db,"update model_registry set pricing_output_per_1m=14 where model_id='gpt-5.3-codex'");await query(db,'set role service_role');
 await query(db,'savepoint paused');
 await query(db,"update work_projects set status='paused' where id=$1",[project]);
 assert.equal(await live(),false);
 await query(db,'rollback to savepoint paused');await query(db,'release savepoint paused');
 await query(db,'savepoint revoked');
 await query(db,'reset role');
 await query(db,"update project_continuation_authorizations set revoked_at=now() where id=$1",[authorization]);
 await query(db,'set role service_role');
 assert.equal(await live(),false);
 await query(db,'rollback to savepoint revoked');await query(db,'release savepoint revoked');
 assert.equal(await live(),true);
 const second=await reserve(1000);
 await assert.rejects(reserve(1000),/unresolved/,'Pending native receipt blocks concurrency');
 await assert.rejects(settle(second.call,'provider-response-missing',null),/linked usage/);
 await settle(second.call,'provider-response-two');
 // Temporarily narrow only the synthetic grant, proving that development cannot
 // borrow the protected 120k assessment/completion headroom.
 await query(db,'reset role');
 await query(db,'alter table project_continuation_authorizations disable trigger task4a_authority_immutable_update');
 await query(db,'update project_continuation_authorizations set incremental_tokens=120001 where id=$1',[authorization]);
 await query(db,'alter table project_continuation_authorizations enable trigger task4a_authority_immutable_update');
 await query(db,'set role service_role');
 await assert.rejects(reserve(1000),/capacity|reserve exhausted/,'Protected completion and assessment reserves remain fenced');
 await query(db,'reset role');
 await query(db,'alter table project_continuation_authorizations disable trigger task4a_authority_immutable_update');
 await query(db,'update project_continuation_authorizations set incremental_tokens=440326 where id=$1',[authorization]);
 await query(db,'alter table project_continuation_authorizations enable trigger task4a_authority_immutable_update');
 await query(db,'set role service_role');
 // The same lock serializes two genuine connections competing for one next hold.
 await query(db,'commit');
 const rivals=await Promise.all([connect(),connect()]);
 for(const c of rivals)await c.query('set role service_role');
 const competing=await Promise.allSettled(rivals.map((c)=>c.query(
  'select task4a_native_reserve($1,$2,1,$3,$4,1000) op',[hash,project,randomUUID(),'gpt-5.3-codex']
 )));
 assert.equal(competing.filter(x=>x.status==='fulfilled').length,1,'Only one concurrent pending native call may reserve');
 await query(db,'begin');
 await query(db,'set role service_role');
 assert.equal((await one(db,'select count(*)::int n from mission_calls where project_continuation_id=$1',[authorization])).n,3);
 assert.equal((await one(db,'select count(*)::int n from benchmark_budget_calls where account_id=$1',[a.account_id])).n,3);
 await query(db,'rollback');
}

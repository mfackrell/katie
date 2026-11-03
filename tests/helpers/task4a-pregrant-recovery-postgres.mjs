import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const project='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const mission='d3fd3d95-7287-4bfc-8c97-c105fde46c36';
const task='d0e41ff5-149e-4319-9e65-dcc605fb75da';
const original='ddccc7a1-743f-4031-8ecd-a6926568ca98';
const research='d35b71d3-fbe2-4e9b-8bde-4d0fe8c9968e';
const continuation='405ea82c-6f52-49e5-babf-891ecac64d14';
const scope='debdfd441a9bb6b1106d2e09c56b6e7a2c494ce81f23890e104a625c8633c685';
const contract='e8b08da72779ae0d7e864ed57c5ecc76b03d1fce6ddc9e14815e9c4c3dff332e';
const baseline='49c8a5f791e66c351436bb97839193b53d7a1cd1';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];

export async function verifyTask4aPregrantRecoveryPostgres(db){
 await db.query('reset role');
 await db.query('begin');
 try{
  const originalTeam=await one(db,"select team from work_projects where id='44444444-4444-4444-8444-444444444444'");
  const team=originalTeam.team,actor=randomUUID(),chat=randomUUID(),owner=randomUUID(),repo=randomUUID();
  const id=randomUUID();
  const dev=await one(db,"select j.agent_id from mission_assignments j join work_projects p on p.active_mission_id=j.mission_id where p.id='44444444-4444-4444-8444-444444444444' and j.role='development' limit 1");
  await db.query('insert into actors(id,name) values($1,$2)',[actor,'Synthetic Task4A pregrant owner']);
  await db.query('insert into chats(id,actor_id,title) values($1,$2,$3)',[chat,actor,'Pregrant synthetic only']);
  await db.query('insert into repo_sync_runs(id,repository_full_name) values($1,$2)',[repo,'mfackrell/katie']);
  await db.query('insert into standalone_owner_bindings(owner_id,actor_id,chat_id) values($1,$2,$3)',[owner,actor,chat]);
  await db.query("insert into work_projects(id,request_id,actor_id,chat_id,objective,team,status,phase,token_allowance,deadline,repository_id,repository_full_name,baseline_sha,approval_hash,approved_hash) values($1,$2,$3,$4,'Synthetic original pregrant only',$5,'blocked','development',600000,now()+interval '8 hours',$6,'mfackrell/katie',$7,$8,$8)",[
   project,randomUUID().toString(),actor,chat,team,repo,baseline,scope
  ]);
  await db.query('select create_mission($1,$2,$3,120,null)',[research,'Original research historical fixture',team]);
  await db.query("update agent_missions set project_id=$2,project_kind='research',status='blocked',actual_tokens=76519,reserved_tokens=76519,calls=4,routing_calls=5 where id=$1",[research,project]);
  await db.query('select create_mission($1,$2,$3,120,null)',[mission,'Original development fixture',team]);
  await db.query("update agent_missions set project_id=$2,project_kind='development',status='blocked',token_allowance=120000,deadline=now()+interval '6 hours' where id=$1",[mission,project]);
  await db.query('update work_projects set active_mission_id=$2 where id=$1',[project,mission]);
  const binding={version:1,projectId:project,baseSha:baseline,baselineSha:baseline,allowedPaths:['app/project-pilots/task4a-preview-probe/'],scopeHash:scope,contractHash:contract,contract:{path:'/project-pilots/task4a-preview-probe/',scenarios:[{name:'initial',steps:[{action:'expectText',selector:'#state',value:'Initial state'}]}]}};
  await db.query("insert into project_runs(project_id,mission_id,kind,ordinal,milestone_index,binding) values($1,$2,'development',1,0,$3)",[project,mission,binding]);
  await db.query("insert into mission_assignments(id,mission_id,job_key,role,agent_id,instruction,status,attempts,result) values($1,$2,'implement','development',$3,'Original approved task','failed',1,$4)",[
   task,mission,dev.agent_id,JSON.stringify({detail:'Independent workflow tests or review blocked completion.'})
  ]);
  await db.query("select create_agent_task($1,$2,'Synthetic Task4A pregrant only','development',$3)",[task,dev.agent_id,repo]);
  const external={attempted:true,issueNumber:969,issueUrl:'https://github.com/mfackrell/katie/issues/969',developerApprovalId:original,developerReleaseSha:'7a7232268d9f300cd42a7ca713be643ec7d3a863',receipt:{run_id:41673059705,outcome:'BLOCKED',pr_url:null}};
  await db.query("update agent_tasks set status='blocked',external=$2 where id=$1",[task,external]);
  await db.query("insert into project_continuation_authorizations(id,project_id,actor_id,chat_id,source_mission_id,approval_digest,deadline,incremental_tokens,incremental_calls,incremental_microusd,assessment_reserve_tokens,completion_reserve_tokens,assessment_reserve_calls,completion_reserve_calls,allowed_models,historical_tokens,historical_calls,historical_mission_deadline,pricing_evidence) values($1,$2,$3,$4,$5,$6,now()+interval '4 hours',440326,53,15000000,60000,60000,6,6,array['openai:gpt-5.6-sol','openai:gpt-5.3-codex'],76519,9,now()-interval '1 minute','[]'::jsonb)",[
   continuation,project,actor,chat,research,'a'.repeat(64)
  ]);
  await db.query("update model_registry set pricing_status='verified',pricing_verified_at=now(),source_metadata=jsonb_build_object('pricing_verification_source','https://developers.openai.com/api/docs/models/gpt-5.3-codex') where provider_name='openai' and model_id='gpt-5.3-codex'");
  await db.query("insert into benchmark_budget_accounts(id,experiment_id,arm,owner_actor_id,cap_tokens,developer_project_id,developer_task_id) values($1,null,'developer',$2,180000,$3,$4)",[
   id,actor,project,task
  ]);
  const limits={cumulativeTokens:180000,developmentTokens:120000,assessmentTokens:60000,completionTokens:60000,developmentCalls:12,assessmentCalls:4,completionCalls:4,perCallMicrousd:1680000,ceilingMicrousd:2520000,durationSeconds:86400};
  await db.query("insert into benchmark_native_spending_approvals(id,owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,developer_authority) values($1,$2,$3,$4,null,$5,'mfackrell/katie','gpt-5.3-codex',$6,180000,now()+interval '20 hours',$7,$8,$8,$9)",[
   original,owner,actor,chat,id,scope,project,task,
   {version:'ordinary-developer-v1',scopeHash:scope,binding,limits,originalTaskId:task,completionContract:null}
  ]);
  await db.query('set role service_role');
  const before=await one(db,'select count(*)::int approvals from benchmark_native_spending_approvals where project_id=$1',[project]);
  const proposal=await one(db,'select task4a_native_recovery_proposal() proposal');
  assert.equal(proposal.proposal.ready,true,'Exact original failed-gate case must be eligible');
  assert.equal(proposal.proposal.proposal.oldApprovalId,original);
  assert.equal(proposal.proposal.proposal.continuationId,continuation);
  assert.equal(Number(proposal.proposal.proposal.limits.ceilingMicrousd),2520000);
  const negative=async(ownerId,digest,pattern)=>{
   await db.query('savepoint reject_wrong_authority');
   try{await assert.rejects(db.query('select task4a_confirm_pregrant_recovery($1,$2)',[ownerId,digest]),pattern);}
   finally{await db.query('rollback to savepoint reject_wrong_authority');await db.query('release savepoint reject_wrong_authority');}
  };
  await negative(randomUUID(),proposal.proposal.digest,/STALE_OR_UNAUTHORIZED/);
  await negative(owner,'f'.repeat(64),/STALE_OR_UNAUTHORIZED/);
  await db.query('savepoint revoke');
  await db.query('reset role');
  await db.query("update project_continuation_authorizations set revoked_at=clock_timestamp() where id=$1",[continuation]);
  await db.query('set role service_role');
  assert.equal((await one(db,'select task4a_native_recovery_proposal() proposal')).proposal,null);
  await db.query('rollback to savepoint revoke');await db.query('release savepoint revoke');
  assert.equal((await one(db,'select count(*)::int n from benchmark_budget_calls where account_id=$1',[id])).n,0);
  const result=(await one(db,'select task4a_confirm_pregrant_recovery($1,$2) recovered',[owner,proposal.proposal.digest])).recovered;
  assert.equal(result.recovered,true);
  assert.equal(result.originalIssueNumber,969);
  const child=await one(db,'select * from benchmark_native_spending_approvals where id=$1',[result.newApprovalId]);
  assert.equal(child.previous_developer_approval_id,original);
  assert.equal(child.account_id,id);
  assert.equal(child.max_tokens.toString(),'180000');
  assert.equal(child.developer_authority.task4aContinuationId,continuation);
  assert.deepEqual(child.developer_authority.limits,limits);
  assert.equal((await one(db,'select revoked_at from benchmark_native_spending_approvals where id=$1',[original])).revoked_at!==null,true);
  assert.equal((await one(db,'select status from work_projects where id=$1',[project])).status,'running');
  assert.equal((await one(db,'select status from agent_missions where id=$1',[mission])).status,'running');
  assert.equal((await one(db,'select status from mission_assignments where id=$1',[task])).status,'waiting_external');
  assert.equal((await one(db,'select task4a_pregrant_redispatch_ready($1,$2) ok',[task,child.id])).ok,true);
  assert.equal((await one(db,'select task4a_native_authority_ready($1,$2,$3) ok',[project,task,continuation])).ok,true);
  assert.equal((await one(db,'select count(*)::int n from benchmark_native_spending_approvals where project_id=$1',[project])).n,before.approvals+1);
  assert.equal((await one(db,'select count(*)::int n from benchmark_budget_calls where account_id=$1',[id])).n,0);
  assert.equal((await one(db,'select count(*)::int n from benchmark_execution_grants where project_id=$1',[project])).n,0);
  assert.equal((await one(db,'select actual_tokens from agent_missions where id=$1',[research])).actual_tokens.toString(),'76519');
  await negative(owner,proposal.proposal.digest,/STALE_OR_UNAUTHORIZED/);
  console.log('TASK4A_NATIVE_PREGRANT_RECOVERY_POSTGRES_PASS: explicit owner consent, immutable prior approval, same account and limits, no paid calls, exact issue reuse');
 }finally{
  await db.query('rollback');
  await db.query('reset role');
 }
}

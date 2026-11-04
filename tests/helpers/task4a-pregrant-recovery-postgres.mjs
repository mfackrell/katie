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

export async function verifyTask4aPregrantRecoveryPostgres(db,{successorMode=false}={}){
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
  if(successorMode){
   // These historical unbound research calls happened BEFORE the project
   // entered its funded development phase. Reproduce that chronology.
   await db.query("update work_projects set phase='research' where id=$1",[project]);
   const historicalJob=await one(db,'select id from mission_assignments where mission_id=$1 limit 1',[research]);
   assert.ok(historicalJob);
   for(let i=0;i<9;i++){
    const n=i===8?8519:8500;
    await db.query("insert into mission_calls(id,job_id,lease,model,reserved_tokens,actual_tokens,status) values($1,$2,$3,'openai:gpt-5.6-sol',$4,$4,'completed')",
     [randomUUID(),historicalJob.id,randomUUID(),n]);
   }
   await db.query("update work_projects set phase='development' where id=$1",[project]);
  }
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
  await db.query("insert into project_continuation_authorizations(id,project_id,actor_id,chat_id,source_mission_id,approval_digest,authorized_at,deadline,incremental_tokens,incremental_calls,incremental_microusd,assessment_reserve_tokens,completion_reserve_tokens,assessment_reserve_calls,completion_reserve_calls,allowed_models,historical_tokens,historical_calls,historical_mission_deadline,pricing_evidence) values($1,$2,$3,$4,$5,$6,case when $7::boolean then now()-interval '3 hours' else now() end,case when $7::boolean then now()-interval '2 hours' else now()+interval '4 hours' end,440326,53,15000000,60000,60000,6,6,array['openai:gpt-5.6-sol','openai:gpt-5.3-codex'],76519,9,now()-interval '1 minute','[]'::jsonb)",[
   continuation,project,actor,chat,research,'a'.repeat(64),successorMode
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
  if(successorMode){
   // The actual function must deny zero and ambiguous terminal authorities.
   assert.equal((await one(db,'select task4a_current_continuation_id($1) id',[randomUUID()])).id,null,
    'No project authorization must return NULL');
   assert.equal((await one(db,'select task4a_current_continuation_id($1) id',[project])).id,continuation,
    'A single existing root is the only eligible tip');
   await db.query('savepoint ambiguous_tips');
   await db.query('reset role');
   try{
    // Exercise corrupted/ambiguous data in rolled-back isolated Postgres ONLY;
    // the production unique-root guard is restored by savepoint rollback.
    await db.query('drop index public.task4a_continuation_one_root');
    await db.query("insert into project_continuation_authorizations(id,project_id,actor_id,chat_id,source_mission_id,approval_digest,authorized_at,deadline,incremental_tokens,incremental_calls,incremental_microusd,assessment_reserve_tokens,completion_reserve_tokens,assessment_reserve_calls,completion_reserve_calls,allowed_models,historical_tokens,historical_calls,historical_mission_deadline,pricing_evidence) select gen_random_uuid(),project_id,actor_id,chat_id,source_mission_id,$2,authorized_at,deadline,incremental_tokens,incremental_calls,incremental_microusd,assessment_reserve_tokens,completion_reserve_tokens,assessment_reserve_calls,completion_reserve_calls,allowed_models,historical_tokens,historical_calls,historical_mission_deadline,pricing_evidence from project_continuation_authorizations where id=$1",[continuation,'b'.repeat(64)]);
    await db.query('set role service_role');
    assert.equal((await one(db,'select task4a_current_continuation_id($1) id',[project])).id,null,
      'Multiple eligible successors must fail closed rather than choose one');
    await db.query('savepoint unmetered_attempt');
    try{
     await assert.rejects(
      db.query("insert into mission_calls(id,job_id,lease,model,reserved_tokens) values($1,$2,$3,$4,$5)",
       [randomUUID(),task,randomUUID(),'gpt-5.3-codex',1000]),
      /TASK4A_NO_UNAMBIGUOUS_CURRENT_AUTHORITY/,
      'No ambiguous continuation may create even an unmetered mission call'
     );
    }finally{
     await db.query('rollback to savepoint unmetered_attempt');
     await db.query('release savepoint unmetered_attempt');
    }
   }finally{
    // A failed DML statement aborts the transaction until savepoint rollback.
    await db.query('rollback to savepoint ambiguous_tips');
    await db.query('release savepoint ambiguous_tips');
    await db.query('reset role');
    await db.query('set role service_role');
   }
   assert.equal((await one(db,'select task4a_current_continuation_id($1) id',[project])).id,continuation,
    'Savepoint rollback restores unique-root security constraint');
   assert.equal((await one(db,'select task4a_native_recovery_proposal() x')).x,null);
   const opts=[300000,30,8000000,60000,60000,6,6,3600,['openai:gpt-5.3-codex']];
   const preview=async(args=opts)=>(await one(db,
    'select task4a_successor_proposal($1,$2,$3,$4,$5,$6,$7,$8,$9) x',args)).x;
   await db.query('savepoint orphaned_native_approval');
   await db.query('reset role');
   await db.query("insert into benchmark_native_spending_approvals(id,owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,developer_authority) select gen_random_uuid(),owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,developer_authority from benchmark_native_spending_approvals where id=$1",[original]);
   await db.query('set role service_role');
   assert.equal((await preview()).ready,false,
    'Unlinked duplicate native authority must block successor issuance');
   await db.query('rollback to savepoint orphaned_native_approval');
   await db.query('release savepoint orphaned_native_approval');
   const offer=await preview();
   assert.equal(offer.ready,true,JSON.stringify(offer));
   assert.equal(Number(offer.proposal.historicalActualTokens),76519);
   assert.equal(Number(offer.proposal.historicalCalls),9);
   assert.equal(Number(offer.proposal.maximumNewTokens),523481);
   assert.equal(offer.proposal.predecessorId,continuation);
   await db.query('savepoint settled_token_overrun');
   await db.query('reset role');
   const changed=await one(db,"update mission_calls set actual_tokens=reserved_tokens+1000 where id=(select id from mission_calls where job_id in (select id from mission_assignments where mission_id=$1) order by id limit 1) returning id",[research]);
   assert.ok(changed?.id);
   await db.query('update agent_missions set actual_tokens=actual_tokens+1000 where id=$1',[research]);
   await db.query('set role service_role');
   const overrunOffer=await preview();
   assert.equal(overrunOffer.ready,true,'Completed overrun must remain visible and conservatively encumbered');
   assert.equal(Number(overrunOffer.proposal.historicalOverrunCalls),1);
   assert.equal(Number(overrunOffer.proposal.historicalOverrunTokens),1000);
   assert.equal(Number(overrunOffer.proposal.maximumNewTokens),522481,'Per-call maximum, not raw reservation, reduces remaining cap');
   assert.notEqual(overrunOffer.digest,offer.digest,'Overrun changes the signed owner proposal');
   await db.query('rollback to savepoint settled_token_overrun');
   await db.query('release savepoint settled_token_overrun');
   assert.equal((await preview([600000,...opts.slice(1)])).ready,false);
   const excessiveCalls=[...opts];excessiveCalls[1]=201;
   assert.equal((await preview(excessiveCalls)).ready,false,
    'Successor call ceiling must respect native table maximum of 200');
   assert.equal((await preview([...opts.slice(0,8),['openai:unverified']])).ready,false);
   await db.query('savepoint unverified_pricing');
   await db.query('reset role');
   await db.query("update model_registry set pricing_status='estimated',source_metadata='{}'::jsonb where provider_name='openai' and model_id='gpt-5.3-codex'");
   await db.query('set role service_role');
   const unverified=(await preview()).reason;
   assert.equal(unverified,'fresh_verified_model_pricing_required',
    'Cached model catalog prices alone must never create successor authority');
   await db.query('rollback to savepoint unverified_pricing');
   await db.query('release savepoint unverified_pricing');
   const historical=(await one(db,'select to_jsonb(a) obj from project_continuation_authorizations a where id=$1',[continuation])).obj;
   const consent=async(who,digest)=>one(db,
    'select task4a_authorize_successor($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) x',
    [who,digest,...opts]);
   for(const [who,digest] of [[randomUUID(),offer.digest],[owner,'0'.repeat(64)]]){
    await db.query('savepoint reject');
    await assert.rejects(consent(who,digest),/TASK4A_SUCCESSOR_STALE_OR_UNAUTHORIZED/);
    await db.query('rollback to savepoint reject');await db.query('release savepoint reject');
   }
   const saved=(await consent(owner,offer.digest)).x;
   assert.equal(saved.authorized,true);
   assert.equal(saved.predecessorId,continuation);
   await db.query('savepoint immutable_audit_event');
   await db.query('reset role');
   try{
    await assert.rejects(
     db.query("update project_events set data='{}'::jsonb where project_id=$1 and event='task4a_successor_continuation_authorized'",[project]),
     /TASK4A_SUCCESSOR_AUDIT_IMMUTABLE/,
     'Owner successor audit receipt must not be mutable');
   }finally{
    await db.query('rollback to savepoint immutable_audit_event');
    await db.query('release savepoint immutable_audit_event');
    await db.query('set role service_role');
   }
   assert.deepEqual((await one(db,'select to_jsonb(a) obj from project_continuation_authorizations a where id=$1',[continuation])).obj,historical);
   assert.equal((await one(db,'select task4a_current_continuation_id($1) id',[project])).id,saved.authorizationId);
   assert.equal((await one(db,'select status from work_projects where id=$1',[project])).status,'blocked');
   await db.query('savepoint duplicate');
   await assert.rejects(consent(owner,offer.digest),/TASK4A_SUCCESSOR_STALE_OR_UNAUTHORIZED/);
   await db.query('rollback to savepoint duplicate');await db.query('release savepoint duplicate');
   const nativeOffer=(await one(db,'select task4a_native_recovery_proposal() x')).x;
   assert.equal(nativeOffer.ready,true);
   assert.equal(nativeOffer.proposal.continuationId,saved.authorizationId);
   await db.query('savepoint revoked');
   await db.query('reset role');
   await db.query('update project_continuation_authorizations set revoked_at=clock_timestamp() where id=$1',[saved.authorizationId]);
   await db.query('set role service_role');
   assert.equal((await one(db,'select task4a_native_recovery_proposal() x')).x,null);
   await db.query('rollback to savepoint revoked');await db.query('release savepoint revoked');
   const recovered=(await one(db,'select task4a_confirm_pregrant_recovery($1,$2) x',[owner,nativeOffer.digest])).x;
   assert.equal(recovered.recovered,true);
   // Attempt to forge a canonical prebound financial receipt. Only the
   // signed native execution-grant path may admit the original development task.
   await db.query('savepoint prebound_bypass');
   try{
    await assert.rejects(
     db.query("insert into mission_calls(id,job_id,lease,model,reserved_tokens,project_continuation_id,project_reserved_microusd,project_pricing_evidence) values($1,$2,$3,'gpt-5.3-codex',1000,$4,1000,'{}'::jsonb)",[
      randomUUID(),task,randomUUID(),saved.authorizationId]),
     /TASK4A_DEVELOPMENT_REQUIRES_NATIVE_ADMISSION/,
     'No prebound development call may evade signed native financial admission');
   }finally{
    await db.query('rollback to savepoint prebound_bypass');
    await db.query('release savepoint prebound_bypass');
   }
   assert.equal(recovered.continuationId,saved.authorizationId);
   assert.equal(recovered.originalIssueNumber,969);
   assert.equal((await one(db,'select task4a_native_authority_ready($1,$2,$3) ok',[project,task,continuation])).ok,false);
   assert.equal((await one(db,'select task4a_native_authority_ready($1,$2,$3) ok',[project,task,saved.authorizationId])).ok,true);
   assert.equal((await one(db,'select task4a_pregrant_redispatch_ready($1,$2) ok',[task,recovered.newApprovalId])).ok,true);
   assert.equal((await one(db,'select count(*)::int n from benchmark_budget_calls where account_id=$1',[id])).n,0);
   assert.equal((await one(db,'select count(*)::int n from benchmark_execution_grants where project_id=$1',[project])).n,0);
   assert.equal((await one(db,"select count(*)::int n from project_events where project_id=$1 and event='task4a_successor_continuation_authorized'",[project])).n,1);
   console.log('TASK4A_PHASE2_SUCCESSOR_POSTGRES_PASS');
   return;
  }
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
  // Simulate a revoked continuation and an expired native deadline independently.
  // The continuation deadline is immutable; do not bypass its protection in tests.
  for(const scenario of ['revoked-continuation','expired-native']){
   await db.query('savepoint authority_denies');
   await db.query('reset role');
   if(scenario==='revoked-continuation')
    await db.query("update project_continuation_authorizations set revoked_at=clock_timestamp() where id=$1",[continuation]);
   else
    await db.query("update benchmark_native_spending_approvals set deadline=clock_timestamp()-interval '1 second' where id=$1",[original]);
   await db.query('set role service_role');
   assert.equal((await one(db,'select task4a_native_recovery_proposal() proposal')).proposal,null,
    'Revoked or expired authority cannot be revived by old consent');
   await db.query('rollback to savepoint authority_denies');
   await db.query('release savepoint authority_denies');
  }
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
  // The canonical dispatch claim replaces the task's active approval pointer,
  // without invalidating the auditable pre-inference recovery receipt.
  await db.query("update agent_tasks set external=external||jsonb_build_object('developerApprovalId',$2::text) where id=$1",[task,child.id]);
  assert.equal((await one(db,'select task4a_pregrant_redispatch_ready($1,$2) ok',[task,child.id])).ok,true);
  await db.query("update agent_tasks set status='submitted' where id=$1",[task]);
  assert.equal((await one(db,'select task4a_pregrant_redispatch_ready($1,$2) ok',[task,child.id])).ok,true,'Submitted original workflow remains eligible for canonical native admission');
  await db.query('savepoint negative_post_admission');
  await db.query("insert into benchmark_execution_grants(id,developer_approval_id,project_id,mission_assignment_id,execution_epoch,deadline) values($1,$2,$3,$4,1,now()+interval '1 hour')",[randomUUID(),child.id,project,task]);
  assert.equal((await one(db,'select task4a_pregrant_redispatch_ready($1,$2) ok',[task,child.id])).ok,false,'Existing native execution must prevent another pregrant claim');
  await db.query('rollback to savepoint negative_post_admission');
  await db.query('release savepoint negative_post_admission');
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

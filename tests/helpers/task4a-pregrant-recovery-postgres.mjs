import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';

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

export async function verifyTask4aPregrantRecoveryPostgres(db,{successorMode=false,concurrentMode=false,connect=null,failedDispatchMode=false,failedDispatchConcurrent=false,ownerGovernedMode=false,ownerGovernedConcurrent=false,ownerGovernedPaidMode=false}={}){
 await db.query('reset role');
 await db.query('begin');
 let committedForConcurrency=false;
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
  if(successorMode){
   // Production runs the deferred exact-decision guard. Previous isolated
   // tests omitted it and incorrectly accepted transactions rolled back at COMMIT.
   await db.query('reset role');
   await db.query('alter table public.benchmark_native_spending_approvals add column if not exists developer_proposal_id text');
   await db.query('create table if not exists public.benchmark_lifecycle_proposals(id text primary key,owner_id uuid,task_id uuid,project_id uuid)');
   await db.query('create table if not exists public.benchmark_lifecycle_decisions(id uuid primary key default gen_random_uuid(),developer_approval_id uuid,proposal_id text,decision text,owner_id uuid)');
   await db.query(readFileSync('supabase/migrations/20261105130000_task4a_recovery_decision_receipt_guard.sql','utf8'));
   await db.query("create constraint trigger developer_approval_decision after insert on public.benchmark_native_spending_approvals deferrable initially deferred for each row execute function public.developer_approval_decision_guard()");
   // Exercise the deployed successor migration in BOTH legacy and new owner paths.
   await db.query(readFileSync('supabase/migrations/20261105173000_task4a_blocked_dispatch_owner_recovery.sql','utf8'));
    await db.query(readFileSync('supabase/migrations/20261105210000_task4a_separate_dispatch_paid_execution.sql','utf8'));
   await db.query('set role service_role');
  }
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
   await db.query('savepoint uncertain_historical_receipt');
   await db.query('reset role');
   await db.query("update mission_calls set status='uncertain' where id=(select id from mission_calls where job_id in (select id from mission_assignments where mission_id=$1) order by id limit 1)",[research]);
   await db.query('set role service_role');
   const uncertainOffer=await preview();
   assert.equal(uncertainOffer.ready,false,'Uncertain provider receipt cannot be ignored as free capacity');
   assert.equal(uncertainOffer.reason,'historical_ledger_unreconciled');
   await db.query('rollback to savepoint uncertain_historical_receipt');
   await db.query('release savepoint uncertain_historical_receipt');
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
   if(concurrentMode){
    assert.equal(typeof connect,'function','Two real isolated PostgreSQL clients required');
    // Only this disposable Postgres cluster is committed. It is destroyed by
    // tests/projects-sql.test.mjs; there are no production writes or paid calls.
    await db.query('commit');
    committedForConcurrency=true;
    const rivals=await Promise.all([connect(),connect()]);
    try{
     await Promise.all(rivals.map(client=>client.query('set role service_role')));
     const result=await Promise.allSettled(rivals.map(client=>
      client.query('select task4a_authorize_successor($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result',
       [owner,offer.digest,...opts])));
     assert.equal(result.filter(r=>r.status==='fulfilled').length,1,
      'Two concurrent owner approvals must never create two successor grants');
     assert.equal(result.filter(r=>r.status==='rejected').length,1,
      'The second owner approval must fail under the admission lock and unique predecessor');
     const admitted=result.find(r=>r.status==='fulfilled');
     assert.equal(admitted.value.rows[0].result.authorized,true);
     const successorRows=await one(db,'select count(*)::int n from project_continuation_authorizations where project_id=$1',[project]);
     assert.equal(successorRows.n,2,'Original root plus exactly one child');
     assert.equal((await one(db,"select count(*)::int n from project_events where project_id=$1 and event='task4a_successor_continuation_authorized'",[project])).n,1);
     assert.equal((await one(db,'select status from work_projects where id=$1',[project])).status,'blocked');
     assert.equal((await one(db,'select count(*)::int n from benchmark_budget_calls where account_id=$1',[id])).n,0);
     assert.equal((await one(db,'select count(*)::int n from benchmark_execution_grants where project_id=$1',[project])).n,0);
     assert.equal((await one(db,'select count(*)::int n from benchmark_native_spending_approvals where previous_developer_approval_id=$1',[original])).n,0);
     console.log('TASK4A_SUCCESSOR_TWO_CONNECTION_RACE_POSTGRES_PASS');
    }finally{await Promise.allSettled(rivals.map(client=>client.end()));}
    return;
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
   // Execute the same deferred constraint used by production COMMIT.
   await db.query('set constraints developer_approval_decision immediate');
   await db.query('savepoint unapproved_ordinary_authority');
   try{
    await assert.rejects(
     db.query("insert into benchmark_native_spending_approvals(id,owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,developer_authority) select gen_random_uuid(),owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,developer_authority from benchmark_native_spending_approvals where id=$1",[original]),
     error => {console.log('TASK4A_UNAPPROVED_GRANT_DENIAL_DIAGNOSTIC',error.message,'SQLSTATE',error.code);
       return /Ordinary authority requires its committed exact owner decision/.test(error.message);},
     'An unapproved ordinary Developer grant must still fail');
   }finally{
    await db.query('rollback to savepoint unapproved_ordinary_authority');
    await db.query('release savepoint unapproved_ordinary_authority');
   }
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
   if(failedDispatchMode){
    // Reproduce the exact immutable 2026-11-05 pre-provider Octokit rejection.
    // No GitHub network request and no real inference are made.
    const oldRelease='d52306d493de492458919614ee13a2da6fcf5bcf';
    const currentRelease='f'.repeat(40);
    const claimId=ownerGovernedMode?'283dd2c4-5bac-4804-b8ed-3358c22896b0':randomUUID();
    let activeForFailedDispatch=recovered.newApprovalId;
    await db.query("update agent_tasks set external=external||jsonb_build_object('developerApprovalId',$2::text,'developerReleaseSha',$3::text,'issueNumber',969,'dispatchStartedAt','2026-11-05T13:43:41.829245Z','developerDispatchSince','2026-11-05T13:43:41.829245Z') where id=$1",[
     task,recovered.newApprovalId,oldRelease
    ]);
    await db.query("insert into project_events(id,project_id,event,created_at,data) values($1,$2,'developer_native_dispatch_claimed','2026-11-05T13:43:41.820983Z',jsonb_build_object('taskId',$3::uuid,'approvalId',$4::uuid,'releaseSha',$5::text))",[
     claimId,project,task,recovered.newApprovalId,oldRelease
    ]);
    if(ownerGovernedMode){
     // Simulate the production watchdog + naturally expired approvals in an
     // isolated synthetic PostgreSQL database. Temporarily bypass the fixture's
     // historical deadline-immutability trigger ONLY to construct this state.
     await db.query('reset role');
     await db.query('alter table public.project_continuation_authorizations disable trigger user');
     await db.query("update project_continuation_authorizations set authorized_at=now()-interval '2 hours',deadline=now()-interval '10 minutes' where id=$1",[saved.authorizationId]);
     await db.query('alter table public.project_continuation_authorizations enable trigger user');
     await db.query("update benchmark_native_spending_approvals set deadline=now()-interval '10 minutes' where id=$1",[recovered.newApprovalId]);
     await db.query("update work_projects set status='blocked',deadline=now()-interval '10 minutes',progress_signature='old-stalled-signature',progress_since=now()-interval '3 hours',error_signature='old-error',repeated_errors=2 where id=$1",[project]);
     await db.query("update agent_missions set status='blocked',deadline=now()-interval '10 minutes' where id=$1",[mission]);
     await db.query("update mission_assignments set status='failed' where id=$1",[task]);
     await db.query('set role service_role');
     await db.query('set constraints developer_approval_decision deferred');
     const newDeadline=new Date(Date.now()+4*3600000).toISOString();
     // The existing synthetic successor is $8.00; owner renewal must NOT increase it.
     const args=[currentRelease,newDeadline,240000,24,8000000];
     const readProposal=async()=>(await one(db,'select task4a_blocked_dispatch_proposal($1,$2,$3,$4,$5) proposal',args)).proposal;
     const offer=await readProposal();
     assert.equal(offer.ready,true,JSON.stringify(offer));
     assert.equal(offer.proposal.originalFailedClaimId,claimId);
     assert.equal(offer.proposal.previousNativeApprovalId,recovered.newApprovalId);
     assert.equal(offer.proposal.previousContinuationId,saved.authorizationId);
     assert.equal((await one(db,'select task4a_failed_dispatch_proposal($1) x',[currentRelease])).x.ready,false,
      'Expired grant and blocked mission cannot dispatch before new owner consent');
     const grant=async(who=owner,consentDigest=offer.digest,conn=db)=>
      (await one(conn,'select task4a_authorize_blocked_dispatch($1,$2,$3,$4,$5,$6,$7) saved',
       [who,consentDigest,...args])).saved;
     for(const [who,hash] of [[randomUUID(),offer.digest],[owner,'f'.repeat(64)]]){
      await db.query('savepoint wrong_owner_digest');
      await assert.rejects(grant(who,hash),/TASK4A_BLOCKED_DISPATCH_OWNER_CONSENT_DENIED/);
      await db.query('rollback to savepoint wrong_owner_digest');
      await db.query('release savepoint wrong_owner_digest');
     }
     if(ownerGovernedConcurrent){
      assert.equal(typeof connect,'function');
      await db.query('commit');committedForConcurrency=true;
      const contenders=await Promise.all([connect(),connect()]);
      try{
       await Promise.all(contenders.map(c=>c.query('set role service_role')));
       const results=await Promise.allSettled(contenders.map(c=>grant(owner,offer.digest,c)));
       assert.equal(results.filter(x=>x.status==='fulfilled'&&x.value.authorized===true).length,1,
        'Exactly one real connection may renew the original project');
       assert.equal(results.filter(x=>x.status==='rejected').length,1,
        'The second owner grant must be rejected, not repeated');
      }finally{await Promise.allSettled(contenders.map(c=>c.end()));}
     }else{
      const result=await grant();
      assert.equal(result.authorized,true);
      await db.query('set constraints developer_approval_decision immediate');
      await db.query('savepoint repeated_renewal');
      await assert.rejects(grant(),/TASK4A_BLOCKED_DISPATCH_OWNER_CONSENT_DENIED/);
      await db.query('rollback to savepoint repeated_renewal');
      await db.query('release savepoint repeated_renewal');
     }
     if(ownerGovernedConcurrent)await db.query('begin');
     const state=await one(db,`select p.status p_status,m.status m_status,j.status j_status,
      t.status t_status,t.external->>'issueNumber' issue,
      t.external->>'developerApprovalId' active_approval
      from work_projects p join agent_missions m on m.id=p.active_mission_id
      join mission_assignments j on j.mission_id=m.id and j.id=$1
      join agent_tasks t on t.id=j.id where p.id=$2`,[task,project]);
     assert.deepEqual([state.p_status,state.m_status,state.j_status,state.t_status,state.issue],
      ['running','running','waiting_external','dispatching','969']);
     const receipt=await one(db,"select id,data from project_events where project_id=$1 and event='task4a_blocked_dispatch_owner_recovered'",[project]);
     assert.ok(receipt?.id);
     assert.equal(receipt.data.originalFailedClaimId,claimId);
     assert.equal(receipt.data.newNativeApprovalId,state.active_approval);
     activeForFailedDispatch=state.active_approval;
     assert.equal(receipt.data.previousProgressSignature,'old-stalled-signature');
     assert.equal(receipt.data.previousErrorSignature,'old-error');
     assert.equal(receipt.data.previousRepeatedErrors,2);
     assert.equal(receipt.data.watchdogRestartedByExplicitOwnerRecovery,true);
     assert.equal(receipt.data.noArtificialCodingProgress,true);
     const watchdog=await one(db,'select progress_signature,progress_since,error_signature,repeated_errors from work_projects where id=$1',[project]);
     assert.equal(watchdog.progress_signature,null,'Next reconciliation must establish genuine task progress signature');
     assert.equal(watchdog.error_signature,null);
     assert.equal(watchdog.repeated_errors,0);
     assert.ok(new Date(watchdog.progress_since).getTime()>Date.now()-60000,'Owner renewal cannot instantly reblock on stale watchdog time');
     assert.equal((await one(db,'select id from project_events where id=$1',[claimId])).id,claimId);
     assert.equal((await one(db,'select count(*)::int n from benchmark_budget_calls where account_id=$1',[id])).n,0);
     assert.equal((await one(db,'select count(*)::int n from benchmark_execution_grants where project_id=$1',[project])).n,0);
     assert.equal((await one(db,'select spent_tokens from benchmark_budget_accounts where id=$1',[id])).spent_tokens.toString(),'0');
     const currentTip=await one(db,'select task4a_current_continuation_id($1) id',[project]);
     assert.equal(currentTip.id,receipt.data.newContinuationId);
     const previous=await one(db,'select id,revoked_at from benchmark_native_spending_approvals where id=$1',[recovered.newApprovalId]);
     assert.equal(previous.id,recovered.newApprovalId);
     assert.ok(previous.revoked_at,'The expired predecessor is preserved but not reusable');
     assert.equal((await one(db,'select task4a_native_authority_ready($1,$2,$3) ok',[project,task,currentTip.id])).ok,true);
     assert.equal((await one(db,'select task4a_pregrant_redispatch_ready($1,$2) ok',[task,state.active_approval])).ok,true);
     const dispatchOffer=(await one(db,'select task4a_failed_dispatch_proposal($1) x',[currentRelease])).x;
     assert.equal(dispatchOffer.ready,true,JSON.stringify(dispatchOffer));
     assert.equal(dispatchOffer.proposal.originalClaimId,claimId);
     assert.equal(dispatchOffer.proposal.approvalId,state.active_approval);
     assert.equal((await one(db,"select count(*)::int n from project_events where project_id=$1 and event='task4a_failed_dispatch_owner_authorized'",[project])).n,0,
      'Restore authority is NOT distinct paid-dispatch owner consent');
     await db.query('savepoint immutable_owner_record');
     await db.query('reset role');
     await assert.rejects(db.query("delete from project_events where id=$1",[receipt.id]),/TASK4A_BLOCKED_DISPATCH_AUDIT_IMMUTABLE/);
     await db.query('rollback to savepoint immutable_owner_record');
     await db.query('release savepoint immutable_owner_record');
     await db.query('set role service_role');
     console.log('TASK4A_BLOCKED_OWNER_DEADLINE_SPENDING_AND_STATE_RECOVERY_POSTGRES_PASS');
     if(!ownerGovernedPaidMode)return;
    }
    const p=async release=>(await one(db,'select task4a_failed_dispatch_proposal($1) offer',[release])).offer;
    const offer=await p(currentRelease);
    assert.equal(offer.ready,true,JSON.stringify(offer));
    assert.equal(offer.proposal.originalClaimId,claimId);
    assert.equal(offer.proposal.approvalId,activeForFailedDispatch);
    assert.equal(offer.proposal.issueNumber,969);
    assert.equal(offer.proposal.nativeLimits.ceilingMicrousd,2520000);
    assert.equal((await p('g'.repeat(40))).ready,false,'Invalid release SHA must be denied');
    const consent=async (who=owner,hash=offer.digest)=>
     (await one(db,'select task4a_authorize_failed_dispatch($1,$2,$3) receipt',
      [who,hash,currentRelease])).receipt;
    for(const [who,hash] of [[randomUUID(),offer.digest],[owner,'0'.repeat(64)]]){
     await db.query('savepoint rejected_consent');
     await assert.rejects(consent(who,hash),/TASK4A_FAILED_DISPATCH_OWNER_CONSENT_DENIED/);
     await db.query('rollback to savepoint rejected_consent');
     await db.query('release savepoint rejected_consent');
    }
    const approved=await consent();
    assert.equal(approved.authorized,true);
    assert.equal(approved.recoveryOnly,true);
    assert.equal(approved.dispatchAuthorized,false);
    assert.equal(approved.paidExecutionAuthorized,false);
    assert.equal(approved.newExecutionGrants,0);
    assert.equal(approved.newPaidCalls,0);
    await db.query('savepoint duplicate_owner_consent');
    await assert.rejects(consent(),/TASK4A_FAILED_DISPATCH_OWNER_CONSENT_DENIED/);
    await db.query('rollback to savepoint duplicate_owner_consent');
    await db.query('release savepoint duplicate_owner_consent');
    assert.equal((await one(db,'select task4a_claim_failed_dispatch($1) ok',[currentRelease])).ok,false,
     'Recovery consent must never permit a GitHub claim');
    assert.equal((await one(db,'select status from agent_tasks where id=$1',[task])).status,'dispatching');
    assert.equal((await one(db,'select count(*)::int n from benchmark_execution_grants where project_id=$1',[project])).n,0);
    assert.equal((await one(db,'select count(*)::int n from benchmark_budget_calls where account_id=$1',[id])).n,0);
    assert.equal((await one(db,"select count(*)::int n from project_events where project_id=$1 and event='task4a_failed_dispatch_paid_execution_authorized'",[project])).n,0);

    // Even an alternative native gateway cannot grant inference under ONLY
    // the first approval. The SQL trigger is independent of the HTTP route.
    await db.query('savepoint unauthorized_paid_grant');
    await assert.rejects(db.query(
     "insert into benchmark_execution_grants(id,developer_approval_id,project_id,mission_assignment_id,execution_epoch,deadline) values($1,$2,$3,$4,1,now()+interval '1 hour')",
     [randomUUID(),activeForFailedDispatch,project,task]),
     /TASK4A_SEPARATE_PAID_AUTH_REQUIRED_BEFORE_GRANT/);
    await db.query('rollback to savepoint unauthorized_paid_grant');
    await db.query('release savepoint unauthorized_paid_grant');

    const paidProposal=async()=>(await one(db,
     'select task4a_paid_execution_proposal($1) offer',[currentRelease])).offer;
    const payOffer=await paidProposal();
    assert.equal(payOffer.ready,true,JSON.stringify(payOffer));
    assert.notEqual(payOffer.digest,offer.digest,'Paid decision must have a different digest');
    assert.equal(payOffer.proposal.recoveryReceiptId,approved.receiptId);
    assert.equal(payOffer.proposal.approvalId,activeForFailedDispatch);
    assert.equal(payOffer.proposal.originalClaimId,claimId);
    const pay=async (who=owner,hash=payOffer.digest,conn=db)=>
     (await one(conn,'select task4a_authorize_paid_execution($1,$2,$3) receipt',
      [who,hash,currentRelease])).receipt;
    for(const [who,hash] of [[randomUUID(),payOffer.digest],[owner,'0'.repeat(64)]]){
     await db.query('savepoint rejected_paid_consent');
     await assert.rejects(pay(who,hash),/TASK4A_SEPARATE_PAID_EXECUTION_CONSENT_DENIED/);
     await db.query('rollback to savepoint rejected_paid_consent');
     await db.query('release savepoint rejected_paid_consent');
    }

    // Model-price evidence and available money are rechecked between decisions.
    await db.query('savepoint stale_paid_pricing');
    await db.query('reset role');
    await db.query("update model_registry set pricing_verified_at=now()-interval '25 hours' where provider_name='openai' and model_id='gpt-5.3-codex'");
    await db.query('set role service_role');
    assert.equal((await paidProposal()).ready,false);
    assert.equal((await one(db,'select task4a_claim_failed_dispatch($1) ok',[currentRelease])).ok,false);
    await db.query('rollback to savepoint stale_paid_pricing');
    await db.query('release savepoint stale_paid_pricing');
    await db.query('set role service_role');

    await db.query('savepoint exhausted_paid_capacity');
    await db.query('reset role');
    await db.query('update benchmark_budget_accounts set spent_tokens=180000 where id=$1',[id]);
    await db.query('set role service_role');
    assert.equal((await paidProposal()).ready,false);
    assert.equal((await one(db,'select task4a_claim_failed_dispatch($1) ok',[currentRelease])).ok,false);
    await db.query('rollback to savepoint exhausted_paid_capacity');
    await db.query('release savepoint exhausted_paid_capacity');
    await db.query('set role service_role');

    if(failedDispatchConcurrent){
     assert.equal(typeof connect,'function','Two real PostgreSQL clients required');
     await db.query('commit');committedForConcurrency=true;
     const contenders=await Promise.all([connect(),connect()]);
     try{
      await Promise.all(contenders.map(x=>x.query('set role service_role')));
      const decisions=await Promise.allSettled(contenders.map(x=>pay(owner,payOffer.digest,x)));
      assert.equal(decisions.filter(x=>x.status==='fulfilled'&&x.value.authorized===true).length,1,
       'Concurrent second owner decisions cannot create two paid receipts');
      assert.equal(decisions.filter(x=>x.status==='rejected').length,1,
       'The second concurrent paid decision must fail closed');
      assert.equal((await one(db,"select count(*)::int n from project_events where project_id=$1 and event='task4a_failed_dispatch_owner_authorized'",[project])).n,1);
      assert.equal((await one(db,"select count(*)::int n from project_events where project_id=$1 and event='task4a_failed_dispatch_paid_execution_authorized'",[project])).n,1);
      const claims=await Promise.all(contenders.map(x=>
       x.query('select task4a_claim_failed_dispatch($1) ok',[currentRelease])));
      assert.equal(claims.filter(x=>x.rows[0].ok===true).length,1,'One paid-authorized dispatch claim only');
      assert.equal(claims.filter(x=>x.rows[0].ok===false).length,1,'Concurrent dispatch duplicate denied');
      assert.equal((await one(db,"select count(*)::int n from project_events where project_id=$1 and event='task4a_failed_dispatch_recovery_claimed'",[project])).n,1);
      assert.equal((await one(db,"select count(*)::int n from project_events where project_id=$1 and event='developer_native_dispatch_claimed' and data->>'releaseSha'=$2",[project,currentRelease])).n,1);
      assert.equal((await one(db,'select count(*)::int n from benchmark_budget_calls where account_id=$1',[id])).n,0);
      assert.equal((await one(db,'select count(*)::int n from benchmark_execution_grants where project_id=$1',[project])).n,0);
      assert.equal((await one(db,'select status from agent_tasks where id=$1',[task])).status,'dispatching');
      console.log('TASK4A_TWO_DISTINCT_OWNER_DECISIONS_AND_ONE_CLAIM_TWO_CONNECTION_POSTGRES_PASS');
      console.log('TASK4A_FAILED_DISPATCH_TWO_CONNECTION_RACE_POSTGRES_PASS');
     }finally{await Promise.allSettled(contenders.map(x=>x.end()));}
     return;
    }

    const paidAuthorization=await pay();
    assert.equal(paidAuthorization.authorized,true);
    assert.equal(paidAuthorization.paidExecutionAuthorized,true);
    assert.equal(paidAuthorization.recoveryReceiptId,approved.receiptId);
    await db.query('savepoint duplicate_paid_consent');
    await assert.rejects(pay(),/TASK4A_SEPARATE_PAID_EXECUTION_CONSENT_DENIED/);
    await db.query('rollback to savepoint duplicate_paid_consent');
    await db.query('release savepoint duplicate_paid_consent');
    assert.equal((await one(db,'select task4a_claim_failed_dispatch($1) ok',[currentRelease])).ok,true);
    assert.equal((await one(db,'select task4a_claim_failed_dispatch($1) ok',[currentRelease])).ok,false,
     'Paid and recovery approvals cannot authorize a second dispatch claim');
    const claim=await one(db,"select id,data from project_events where project_id=$1 and event='task4a_failed_dispatch_recovery_claimed'",[project]);
    assert.equal(claim.data.ownerConsentReceiptId,approved.receiptId);
    assert.equal(claim.data.paidExecutionReceiptId,paidAuthorization.receiptId);
    assert.equal(claim.data.originalClaimId,claimId);
    await db.query('savepoint immutable_recovery_receipt');
    await db.query('reset role');
    await assert.rejects(db.query("delete from project_events where project_id=$1 and event='task4a_failed_dispatch_owner_authorized'",[project]),/TASK4A_FAILED_DISPATCH_AUDIT_IMMUTABLE/);
    await db.query('rollback to savepoint immutable_recovery_receipt');
    await db.query('release savepoint immutable_recovery_receipt');
    await db.query('savepoint immutable_paid_receipt');
    await assert.rejects(db.query("update project_events set data='{}'::jsonb where project_id=$1 and event='task4a_failed_dispatch_paid_execution_authorized'",[project]),/TASK4A_PAID_EXECUTION_RECEIPT_IMMUTABLE/);
    await db.query('rollback to savepoint immutable_paid_receipt');
    await db.query('release savepoint immutable_paid_receipt');
    await db.query('set role service_role');
    assert.equal((await one(db,'select task4a_record_failed_dispatch_submitted($1) ok',[currentRelease])).ok,true);
    assert.equal((await one(db,'select task4a_record_failed_dispatch_submitted($1) ok',[currentRelease])).ok,false);
    const submitted=await one(db,"select data from project_events where project_id=$1 and event='task4a_failed_dispatch_recovery_submitted'",[project]);
    assert.equal(submitted.data.paidExecutionReceiptId,paidAuthorization.receiptId);
    assert.equal((await one(db,'select status from agent_tasks where id=$1',[task])).status,'submitted');
    assert.equal((await one(db,'select count(*)::int n from benchmark_budget_calls where account_id=$1',[id])).n,0);
    assert.equal((await one(db,'select count(*)::int n from benchmark_execution_grants where project_id=$1',[project])).n,0);
    console.log('TASK4A_TWO_DISTINCT_OWNER_CONSENTS_REPLAY_IMMUTABILITY_AND_ACK_POSTGRES_PASS');
    console.log('TASK4A_FAILED_DISPATCH_CONSENT_REPLAY_IMMUTABILITY_AND_ACK_POSTGRES_PASS');
    return;
   }
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
  if(!committedForConcurrency)await db.query('rollback');
  await db.query('reset role');
 }
}

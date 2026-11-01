import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {modules} from './helpers/load-project-modules.mjs';
import {gameFixture} from './fixtures/game-project.mjs';
import {assertDevelopmentOwnerRenewal} from './helpers/assert-development-owner-renewal.mjs';
import {assertNativeStartupRecovery} from './helpers/assert-native-startup-recovery.mjs';
import config from '../config/benchmark-715-production-qualification.json' with {type:'json'};
test('Append-only renewal retains expired authority, hydrates without spending, and fences exact stages',
 {timeout:(process.env.KATIE_TEST_TASK3B==='1'||process.env.KATIE_TEST_NATIVE_RECOVERY_LIFECYCLE==='1'||process.env.KATIE_TEST_LIFECYCLE_HOST==='1'||process.env.KATIE_TEST_ORDINARY_HOST==='1'||process.env.KATIE_TEST_TASK2C==='1')?1500000:180000},async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||'/usr/lib/postgresql/16/bin';
 const root=mkdtempSync(join(tmpdir(),'katie-continuation-')),data=join(root,'data');
 const clients=[];let started=false;
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr||r.error?.message)};
 const connect=async()=>{const c=new pg.Client({host:root,port:55489,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});
  await c.connect();clients.push(c);return c};
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(root,'log'),'-o',`-h '' -k ${root} -p 55489`,'-w','start']);started=true;
  const db=await connect();
  await db.query(readFileSync('tests/fixtures/project-base.sql','utf8'));
  for(const file of ['20261016211426_agent_management.sql','20261016234048_autonomous_missions.sql',
   ...readdirSync('supabase/migrations').filter(f=>f.endsWith('_orchestration_routing_budget.sql')||
   f.endsWith('_chat_projects.sql')||f.endsWith('_project_phase_budgets.sql')||
   f.endsWith('_developer_game_intake.sql')||f.endsWith('_executive_registry_delegation.sql'))])
   await db.query(readFileSync('supabase/migrations/'+file,'utf8'));
  await db.query(readFileSync('supabase/migrations/20261024163000_benchmark_durable_accounts.sql','utf8'));
  // Dependencies from source PRs are intentionally included in one snapshot.
  await db.query(readFileSync('tests/sql/benchmark-combined-smoke-part1.sql','utf8'));
  await db.query(readFileSync('supabase/migrations/20261021000532_atomic_mission_admission_and_review_checkpoints.sql','utf8'));
  await db.query(readFileSync('supabase/migrations/202604030001_model_registry.sql','utf8'));
  for(const name of [
   '20261025184500_benchmark_linked_settlement_guards',
   '20261025185000_benchmark_canonical_operation_links',
   '20261025185500_benchmark_atomic_linked_receipts',
   '20261025191500_benchmark_development_dispatches',
   '20261025193000_benchmark_execution_grants',
   '20261025194500_benchmark_owner_spending_grants',
   '20261025200000_benchmark_gateway_stop_fence',
   '20261025201000_benchmark_atomic_stop_admission',
   '20261025202000_benchmark_project_bound_grants',
   '20261025203000_benchmark_atomic_parent_fencing',
   '20261025204500_benchmark_external_native_mission_bridge',
   '20261025205000_benchmark_native_owner_assignment_grants',
   '20261025211000_benchmark_task_bound_spending_approvals',
   '20261027180744_benchmark_full_do_execution_binding',
   '20261028132000_benchmark_provider_usage_evidence'])
    await db.query(readFileSync('supabase/migrations/'+name+'.sql','utf8'));

  for(const file of ['20261027233957_benchmark_production_owner_qualification.sql','20261028134500_benchmark_dashboard_task_approval.sql',
   '20261026120000_project_completion_control.sql','20261027172000_specification_lifecycle_recovery.sql','20261028135500_benchmark_bounded_assessment.sql',
   '20261028180638_specification_draft_history.sql','20261028180911_benchmark_owner_continuation.sql','20261028181030_continuation_specification_scheduler.sql'])
   await db.query(readFileSync('supabase/migrations/'+file,'utf8'));
  await db.query(`create table provider_health(provider_name text primary key,status text,reason text,failure_count int,blocked_until timestamptz,updated_at timestamptz);grant all on provider_health to service_role`);
  await db.query('alter default privileges in schema public grant all on tables to service_role');
  for(const file of ['20261028210800_provider_availability_recovery.sql',
   '20261028212933_uncharged_continuation_specification_replacement.sql',
   '20261028222500_deterministic_specification_route_recovery.sql',
   '20261028224000_verified_price_review_recovery.sql',
   '20261023194500_recover_latest_game_revision_checkpoint.sql',
   '20261021202500_resume_game_checkpoint_watchdog.sql',
   '20261028225300_retain_full_specification_review.sql',
   '20261024161000_resume_repository_review_context.sql','20261027201000_development_dispatch_recovery.sql',
   '20261029145712_benchmark_append_only_continuation.sql','20261029173500_benchmark_zero_call_startup_recovery.sql','20261029185000_benchmark_zero_call_recovery_chain.sql','20261029213000_benchmark_development_owner_renewal.sql','20261029233500_benchmark_development_pregrant_recovery.sql','20261030001000_benchmark_development_paid_successor.sql','20261030004300_benchmark_owner_resource_amendment.sql'])
   await db.query(readFileSync('supabase/migrations/'+file,'utf8'));
  const actor=randomUUID(),chat=randomUUID(),repo=randomUUID(),trial=randomUUID(),exp=randomUUID(),project=randomUUID(),owner=randomUUID();
  const protocol={...config.protocol};
  await db.query('insert into actors(id,name) values($1,$2)',[actor,'Synthetic continuation fixture']);
  await db.query('insert into chats(id,actor_id,title) values($1,$2,$3)',[chat,actor,'Synthetic continuation fixture']);
  await db.query('insert into repo_sync_runs(id,repository_full_name) values($1,$2)',[repo,'mfackrell/katie']);
  await db.query(`insert into benchmark_three_arm_trials(id,experiment_id,replicate,arm,owner_actor_id,baseline_sha,contract_sha256,acceptance_sha256,model_policy_sha256,tool_profile_sha256,runtime_sha256,state)
   values($1,$2,2,'full',$3,$4,$5,$6,$7,$8,$9,'qualified')`,[trial,exp,actor,protocol.baselineSha,protocol.contract_sha256,protocol.acceptance_sha256,protocol.model_policy_sha256,protocol.tool_profile_sha256,protocol.runtime_sha256]);
  const account=(await db.query(`insert into benchmark_budget_accounts(experiment_id,trial_id,arm,owner_actor_id,cap_tokens,spent_tokens) values($1,$2,'full',$3,350000,0) returning id`,[exp,trial,actor])).rows[0].id;
  await db.query('set role service_role');
  const created=(await db.query('select benchmark_create_full_game_project($1,$2,$3,$4,$5,$6,$7,$8,$9) p',
   [project,'continuation-'+project,actor,chat,process.env.KATIE_TEST_TASK2C==='1'?'Synthetic Task 2C issue #715 regression: repair /pilot state to Recovered with frozen browser acceptance':'Build Take Eleven from approved original issue 650',repo,trial,protocol.baselineSha,'gpt-5.3-codex'])).rows[0].p;
  if(process.env.KATIE_TEST_TASK2C==='1'){
   // Frozen synthetic assignment installed before any scope approval. Never changes production scope.
   const contract={path:'/pilot',scenarios:[{name:'recovered state',steps:[{action:'expectText',selector:'#state',value:'Recovered'}]}]};
   const spec={name:'Synthetic recovered state',summary:'Repair an isolated display state',requirements:['The /pilot route displays Recovered in #state','Independent review and browser acceptance pass on the same commit'],allowedPaths:['app/pilot/'],milestones:[{title:'Recovered state',instruction:'Implement and independently verify the frozen display contract',contract}],finalContract:contract};
   await db.query('update work_projects set spec=$2,baseline_sha=$3 where id=$1',[project,spec,protocol.baselineSha]);
  }
  if(process.env.KATIE_TEST_TASK3B==='1'||process.env.KATIE_TEST_NATIVE_RECOVERY_LIFECYCLE==='1')(await import('./helpers/qualify-native-recovery.mjs')).createNativeRecoveryBaseline(protocol.baselineSha);
  const failedMission=randomUUID();
  await db.query('select create_mission($1,$2,$3,120,null)',[failedMission,'Synthetic failed specification',created.team]);
  // Synthetic historical failure setup only; actual continuation uses owner RPC and DO child creation.
  const sourceJob=(await db.query('select id from mission_assignments where mission_id=$1',[failedMission])).rows[0].id;
  const sourceLease=randomUUID();
  await db.query("update agent_missions set project_id=$2,project_kind='specification',status='running',deadline=now()+interval '1 hour' where id=$1",[failedMission,project]);
  await db.query("update mission_assignments set role='compose',status='running',lease=$2,lease_until=now()+interval '5 minutes',attempts=3 where id=$1",[sourceJob,sourceLease]);
  await db.query('select checkpoint_mission_specification_draft($1,$2,$3,$4,$3)',[sourceJob,sourceLease,'{"name":"synthetic invalid historical draft"}','Missing required specification fields']);

  await db.query(`update agent_missions set project_id=$2,project_kind='specification',status='blocked',deadline=now()-interval '1 hour',actual_tokens=58624,reserved_tokens=58624 where id=$1`,[failedMission,project]);
  await db.query(`update mission_assignments set status='failed',attempts=3,result='{"admissionDenied":true}' where mission_id=$1`,[failedMission]);
  await db.query(`update work_projects set phase='specification',status='blocked',active_mission_id=$2,lease=null,lease_until=null where id=$1`,[project,failedMission]);
  await db.query(`insert into benchmark_budget_calls(account_id,request_key,model,reserved_tokens,actual_tokens,state) values($1,'synthetic-historical-receipt','openai:gpt-5.3-codex',58624,58624,'settled')`,[account]);
  await db.query(`update benchmark_budget_accounts set spent_tokens=58624 where id=$1`,[account]);
  await db.query(`update benchmark_three_arm_trials set state='blocked' where id=$1`,[trial]);
  await db.query(`insert into benchmark_production_qualifications(issue,experiment_id,owner_id,actor_id,transfer,protocol,owner_run_id,commit_sha,deadline)
    values(715,$1,$2,$3,'{}',$4,'fixture',repeat('a',40),now()-interval '1 hour')`,[exp,owner,actor,protocol]);
  await db.query(`insert into model_registry(provider_name,model_id,normalized_model_id,pricing_status,pricing_input_per_1m,pricing_output_per_1m,pricing_verified_at)
   values('openai','gpt-5.3-codex','gpt-5.3-codex','verified',1.75,14,now())`);
  const snapshot=(await db.query('select to_jsonb(m) m from agent_missions m where id=$1',[failedMission])).rows[0].m;
  const originalTrial=(await db.query('select to_jsonb(t) t from benchmark_three_arm_trials t where id=$1',[trial])).rows[0].t;
  const originalProjectDeadline=(await db.query('select deadline from work_projects where id=$1',[project])).rows[0].deadline;
  const rpc='select benchmark_dashboard_continuation($1,$2,$3,$4) result';
  await assert.rejects(db.query(rpc,[randomUUID(),null,null,false]),/owner/);
  const plan=(await db.query(rpc,[owner,null,null,false])).rows[0].result;
  assert.equal(plan.plan.additionalTokenCap,270000);assert.equal(plan.approved,false);
  await assert.rejects(db.query(rpc,[owner,randomUUID(),plan.planHash,true]),/current continuation/);
  await assert.rejects(db.query(rpc,[owner,project,'f'.repeat(64),true]),/current continuation/);
  await db.query('begin');await db.query('update benchmark_budget_accounts set spent_tokens=spent_tokens+1 where id=$1',[account]);
  await assert.rejects(db.query(rpc,[owner,project,plan.planHash,true]),/eligible|current continuation/);await db.query('rollback');
  const rival=await connect();await rival.query('set role service_role');
  const approvals=await Promise.all([db.query(rpc,[owner,project,plan.planHash,true]),rival.query(rpc,[owner,project,plan.planHash,true])]);
  const approval=approvals[0].rows[0].result;
  assert.equal(approval.id,approvals[1].rows[0].result.id);
  const archived=(await db.query('select source_snapshot from benchmark_full_continuations where id=$1',[approval.id])).rows[0].source_snapshot;
  assert.equal(archived.drafts.length,1);assert.equal(archived.drafts[0].candidate,'{"name":"synthetic invalid historical draft"}');
  assert.deepEqual((await db.query('select to_jsonb(m) m from agent_missions m where id=$1',[failedMission])).rows[0].m,snapshot);
  assert.deepEqual((await db.query('select to_jsonb(t) t from benchmark_three_arm_trials t where id=$1',[trial])).rows[0].t,originalTrial);
  await assert.rejects(db.query("update benchmark_full_continuations set deadline=deadline+interval '1 hour'"),/permission denied|immutable/);
  await assert.rejects(db.query("update benchmark_three_arm_trials set state='running' where id=$1",[trial]),/immutable/);
  await assert.rejects(db.query("select benchmark_reserve_call($1,'old-authority','openai:gpt-5.3-codex',1)",[account]),/continuation/);
  assert.deepEqual((await db.query('select deadline from work_projects where id=$1',[project])).rows[0].deadline,originalProjectDeadline);
  const claim=(await db.query('select claim_work_project() p')).rows[0].p;
  assert.equal(claim.id,project);
  const child={kind:'specification',objective:'Recover the frozen original Take Eleven specification',evidence:{projectProfile:'game',benchmarkContinuationId:approval.id,benchmarkContinuationPlanHash:approval.planHash}};
  assert.equal((await db.query("select finish_work_project($1,$2,'child',$3) ok",[project,claim.lease,child])).rows[0].ok,true);
  const work=(await db.query('select claim_mission_work() c')).rows[0].c;
  assert.equal(work.mission.project_id,project);assert.notEqual(work.mission.id,failedMission);assert.equal(work.mission.token_allowance,90000);
  assert.equal(work.mission.project_evidence.specificationBudget.version,2);
  assert.equal(work.job.result.rejectedSpecification,'{"name":"synthetic invalid historical draft"}');
  assert.equal(work.job.result.sourceContinuationId,approval.id);

  // Simulate the historical completed composition/review and failed revision in
  // this isolated database. No production record is modified by this fixture.
  const f=gameFixture(),transport=modules()('@/lib/projects/game-specification-transport');
  const wire={specificationFormat:'registered-game-v1',name:'Counter',summary:'Controlled counter',requirements:['Increment and reject invalid actions'],allowedPaths:f.allowedPaths,
   milestones:[{title:'Complete counter',instruction:'Implement all approved rules'}],finalContract:{path:f.contract.path},game:f.game};
  const candidate=JSON.stringify(transport.validateGameSpecificationResponse(JSON.stringify(wire)));
  await db.query('reset role');
  await db.query('alter table benchmark_full_continuations disable trigger benchmark_continuation_immutable');
  await db.query("update benchmark_full_continuations set created_at=now()-interval '5 hours',deadline=now()-interval '1 hour'");
  await db.query('alter table benchmark_full_continuations enable trigger benchmark_continuation_immutable');
  await db.query("update benchmark_budget_calls set actual_tokens=105453,reserved_tokens=105453 where account_id=$1",[account]);
  await db.query('update benchmark_budget_accounts set spent_tokens=105453 where id=$1',[account]);
  await db.query("update agent_missions set status='blocked',actual_tokens=46829,reserved_tokens=46829,deadline=now()-interval '1 hour' where id=$1",[work.mission.id]);
  await db.query("update mission_assignments set status='completed',result=$2,lease=null,lease_until=null where id=$1",[work.job.id,{text:candidate}]);
  await db.query("update mission_assignments set status='completed',result=$2 where mission_id=$1 and role='review'",[work.mission.id,{verdict:'changes_requested',findings:['Retained representation finding']}]);
  await db.query("insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,status,result) values($1,'revision','revise',$2,'Retained revision',array['review'],'failed',$3)",[work.mission.id,created.team[0],{detail:'Targeted revision changed too much content',rejectedSpecification:candidate}]);
  await db.query("update work_projects set status='blocked',lease=null,lease_until=null where id=$1",[project]);
  await db.query('set role service_role');
  const preserved=(await db.query(`select jsonb_build_object('authority',(select to_jsonb(c) from benchmark_full_continuations c where id=$1),
    'mission',(select to_jsonb(m) from agent_missions m where id=$2),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=$2),
    'calls',(select jsonb_agg(to_jsonb(c) order by id) from benchmark_budget_calls c where account_id=$3)) value`,[approval.id,work.mission.id,account])).rows[0].value;
  const renewal=(await db.query(rpc,[owner,null,null,false])).rows[0].result;
  assert.equal(renewal.approved,false);assert.equal(renewal.spentTokens,105453);
  assert.equal(renewal.plan.additionalTokenCap,240000);assert.equal(renewal.plan.remainingAccountTokens,244547);
  assert.deepEqual(renewal.plan.specificationStages,{compose:0,review:18000,revision:24000,reviewAgain:18000});
  assert.equal(renewal.plan.previousContinuationId,approval.id);assert.equal(renewal.plan.regenerateSpecification,false);
  assert.equal(renewal.plan.savedSpecificationCheckpoint.sourceJobId,work.job.id);
  assert.equal((await db.query(rpc,[owner,project,approval.planHash,true])).rows[0].result.live,false,'Old consent cannot renew');
  assert.equal((await db.query('select count(*)::int n from benchmark_full_continuations')).rows[0].n,1);
  await assert.rejects(db.query(rpc,[randomUUID(),project,renewal.planHash,true]),/owner/);
  await assert.rejects(db.query(rpc,[owner,project,'f'.repeat(64),true]),/current continuation/);
  await db.query('begin');
  await db.query("update mission_assignments set result=jsonb_set(result,'{text}',to_jsonb($2::text)) where id=$1",[work.job.id,candidate+' ']);
  await assert.rejects(db.query(rpc,[owner,project,renewal.planHash,true]),/current continuation/);await db.query('rollback');
  await db.query('begin');await db.query("update benchmark_budget_calls set state='unresolved' where account_id=$1",[account]);
  await assert.rejects(db.query(rpc,[owner,project,renewal.planHash,true]),/eligible/);await db.query('rollback');
  const renewed=await Promise.all([db.query(rpc,[owner,project,renewal.planHash,true]),rival.query(rpc,[owner,project,renewal.planHash,true])]);
  const renewedApproval=renewed[0].rows[0].result;
  assert.equal(renewedApproval.live,true);assert.equal(renewedApproval.id,renewed[1].rows[0].result.id);
  assert.notEqual(renewedApproval.id,approval.id);
  assert.equal((await db.query('select count(*)::int n from benchmark_full_continuations')).rows[0].n,2);
  assert.equal((await db.query('select benchmark_continuation_live($1,$2,$3) live',[approval.id,account,project])).rows[0].live,false);
  assert.equal((await db.query('select benchmark_active_full_continuation($1) c',[project])).rows[0].c.id,renewedApproval.id);
  const after=(await db.query(`select jsonb_build_object('authority',(select to_jsonb(c) from benchmark_full_continuations c where id=$1),
    'mission',(select to_jsonb(m) from agent_missions m where id=$2),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=$2),
    'calls',(select jsonb_agg(to_jsonb(c) order by id) from benchmark_budget_calls c where account_id=$3)) value`,[approval.id,work.mission.id,account])).rows[0].value;
  assert.deepEqual(after,preserved,'Renewal cannot rewrite prior authority, attempts, findings or charges');
  assert.deepEqual((await db.query('select to_jsonb(t) t from benchmark_three_arm_trials t where id=$1',[trial])).rows[0].t,originalTrial);
  const nextClaim=(await db.query('select claim_work_project() p')).rows[0].p;
  const newChild={...child,evidence:{...child.evidence,benchmarkContinuationId:renewedApproval.id,benchmarkContinuationPlanHash:renewedApproval.planHash}};
  assert.equal((await db.query("select finish_work_project($1,$2,'child',$3) ok",[project,nextClaim.lease,newChild])).rows[0].ok,true);
  assert.equal((await db.query("select finish_work_project($1,$2,'child',$3) ok",[project,nextClaim.lease,newChild])).rows[0].ok,false,'Duplicate dispatch fenced');
  const resumed=(await db.query('select claim_mission_work() c')).rows[0].c;
  assert.equal(resumed.mission.token_allowance,60000);
  assert.equal(resumed.mission.project_evidence.savedSpecificationCheckpoint.sourceJobId,work.job.id);
  assert.equal((await db.query('select specification_call_capacity($1,$2) c',[resumed.job.id,resumed.job.lease])).rows[0].c.stageRemainingTokens,0);
  await assert.rejects(db.query('select benchmark_reserve_mission_call($1,$2,$3,$4,1,false)',[resumed.job.id,resumed.job.lease,randomUUID(),'openai:gpt-5.3-codex']),/stage ceiling/);
  const read=async id=>({mission:(await db.query('select * from agent_missions where id=$1',[id])).rows[0],jobs:(await db.query('select * from mission_assignments where mission_id=$1',[id])).rows});
  const runtime=modules({'@/lib/missions/inspection':{workflowInspection:async()=>null},'@/lib/missions/store':{readMission:read,rpc:async(name,args)=>{
   assert.equal(name,'commit_mission_work');
   return (await db.query('select commit_mission_work($1,$2,$3,$4,$5,$6,$7) ok',[args.p_id,args.p_lease,args.p_result,JSON.stringify(args.p_children),args.p_status,args.p_mission_status,args.p_final])).rows[0].ok;
  }}});
  await runtime('@/lib/missions/worker').executeClaim(resumed,async()=>{throw Error('Paid composition forbidden')});
  assert.equal((await db.query('select spent_tokens from benchmark_budget_accounts where id=$1',[account])).rows[0].spent_tokens,'105453');
  assert.equal((await db.query('select count(*)::int n from mission_calls mc join mission_assignments j on j.id=mc.job_id where j.mission_id=$1',[resumed.mission.id])).rows[0].n,0);
  const reviewed=(await db.query('select claim_mission_work() c')).rows[0].c;
  assert.equal(reviewed.job.role,'review');assert.notEqual(reviewed.job.agent_id,resumed.job.agent_id);
  const stage=(await db.query('select specification_call_capacity($1,$2) c',[reviewed.job.id,reviewed.job.lease])).rows[0].c;
  assert.equal(stage.stageRemainingTokens,18000);
  // Stale payload/source is still rejected by ordinary full canonical validation.
  const bad=structuredClone(resumed);bad.mission.project_evidence.savedSpecificationCheckpoint.text='{}';
  const badRuntime=modules({'@/lib/missions/inspection':{workflowInspection:async()=>null},'@/lib/missions/store':{readMission:read,rpc:async()=>{throw Error('Invalid candidate must not commit')}}});
  await assert.rejects(badRuntime('@/lib/missions/worker').executeClaim(bad,async()=>{throw Error('Paid regeneration forbidden')}),/no longer validates/);
  await assertNativeStartupRecovery(db,rival,{project,account,trial,actor,chat,owner,repo,team:created.team,continuation:renewedApproval.id});
  await assertDevelopmentOwnerRenewal(db,rival,{project,account,trial,owner,actor,continuation:renewedApproval.id,protocol});
  await db.query('reset role');await db.query('set role authenticated');
  await assert.rejects(db.query(rpc,[owner,project,renewal.planHash,true]),/permission denied/);
  await assert.rejects(db.query('select * from benchmark_full_continuations'),/permission denied/);
 }finally{
  for(const c of clients)try{await c.end()}catch{}
  if(started)try{run('pg_ctl',['-D',data,'-m','immediate','-w','stop'])}catch{}
  rmSync(root,{recursive:true,force:true});
 }
});




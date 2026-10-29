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
import config from '../config/benchmark-715-production-qualification.json' with {type:'json'};
test('Deterministic route repair preserves paid source, authority, and queued independent review',
 {timeout:180000},async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||'/usr/lib/postgresql/16/bin';
 const root=mkdtempSync(join(tmpdir(),'katie-continuation-')),data=join(root,'data');
 const clients=[];let started=false;
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr||r.error?.message)};
 const connect=async()=>{const c=new pg.Client({host:root,port:55483,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});
  await c.connect();clients.push(c);return c};
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(root,'log'),'-o',`-h '' -k ${root} -p 55483`,'-w','start']);started=true;
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
  await db.query(readFileSync('supabase/migrations/20261028212933_uncharged_continuation_specification_replacement.sql','utf8'));
  await db.query(readFileSync('supabase/migrations/20261028222500_deterministic_specification_route_recovery.sql','utf8'));
  await db.query(readFileSync('supabase/migrations/20261028224000_verified_price_review_recovery.sql','utf8'));
  for(const file of ['20261023194500_recover_latest_game_revision_checkpoint.sql','20261021202500_resume_game_checkpoint_watchdog.sql','20261028225300_retain_full_specification_review.sql'])await db.query(readFileSync('supabase/migrations/'+file,'utf8'));
  const actor=randomUUID(),chat=randomUUID(),repo=randomUUID(),trial=randomUUID(),exp=randomUUID(),project=randomUUID(),owner=randomUUID();
  const protocol=config.protocol;
  await db.query('insert into actors(id,name) values($1,$2)',[actor,'Synthetic continuation fixture']);
  await db.query('insert into chats(id,actor_id,title) values($1,$2,$3)',[chat,actor,'Synthetic continuation fixture']);
  await db.query('insert into repo_sync_runs(id,repository_full_name) values($1,$2)',[repo,'mfackrell/katie']);
  await db.query(`insert into benchmark_three_arm_trials(id,experiment_id,replicate,arm,owner_actor_id,baseline_sha,contract_sha256,acceptance_sha256,model_policy_sha256,tool_profile_sha256,runtime_sha256,state)
   values($1,$2,2,'full',$3,$4,$5,$6,$7,$8,$9,'qualified')`,[trial,exp,actor,protocol.baselineSha,protocol.contract_sha256,protocol.acceptance_sha256,protocol.model_policy_sha256,protocol.tool_profile_sha256,protocol.runtime_sha256]);
  const account=(await db.query(`insert into benchmark_budget_accounts(experiment_id,trial_id,arm,owner_actor_id,cap_tokens,spent_tokens) values($1,$2,'full',$3,350000,0) returning id`,[exp,trial,actor])).rows[0].id;
  await db.query('set role service_role');
  const created=(await db.query('select benchmark_create_full_game_project($1,$2,$3,$4,$5,$6,$7,$8,$9) p',
   [project,'continuation-'+project,actor,chat,'Build Take Eleven from approved original issue 650',repo,trial,protocol.baselineSha,'gpt-5.3-codex'])).rows[0].p;
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
  const f=gameFixture();f.game.acceptance.scenarios.find(s=>s.kind==='browser').steps.unshift({action:'goto',path:'/counter'});
  const raw={specificationFormat:'registered-game-v1',name:'Counter',summary:'Controlled counter',requirements:['Increment and reject invalid actions'],allowedPaths:['app/counter/','tests/counter.mjs'],milestones:[{title:'Complete counter',instruction:'Implement every requirement'}],finalContract:{path:'tests/counter.mjs'},game:f.game};
  const source=JSON.stringify(raw),scope='Scope ONLY app/counter/ and tests/counter.mjs.\n';
  const repair=modules()('@/lib/projects/specification-route-recovery').repairSpecificationRoute(source,scope);
  assert.ok(repair);
  const original={rejectedSpecification:source,specificationValidationFeedback:'Internal application route required',admissionDenied:true};
  await db.query("update work_projects set objective=$2,clarifications='',status='blocked',lease=null,lease_until=null where id=$1",[project,scope.trim()]);
  await db.query("update agent_missions set status='blocked',actual_tokens=24112,reserved_tokens=24112,calls=2,routing_calls=3 where id=$1",[work.mission.id]);
  await db.query("update mission_assignments set status='failed',attempts=3,result=$2,lease=null,lease_until=null where id=$1",[work.job.id,original]);
  const repairSql='select recover_specification_route($1,$2,$3,$4,$5,$6) ok';
  const args=[project,work.job.id,source,original,scope,repair.plan];
  const recover=async(a=args)=>(await db.query(repairSql,a)).rows[0].ok;
  assert.equal(await recover([...args.slice(0,2),source+' ',...args.slice(3)]),false,'stale source refused');
  const stale=[...args];stale[3]={...original,other:true};assert.equal(await recover(stale),false);
  const wrongScope=[...args];wrongScope[4]=scope+'extra';assert.equal(await recover(wrongScope),false);
  const wrongPlan=[...args];wrongPlan[5]={...repair.plan,summary:'Invented'};assert.equal(await recover(wrongPlan),false,'canonical substitution refused');
  for(const [name,sql,params] of [
   ['stopped',"update agent_missions set status='stopped' where id=$1",[work.mission.id]],
   ['child_expiry',"update agent_missions set deadline=now()-interval '1 minute' where id=$1",[work.mission.id]],
   ['revoked',"update benchmark_production_qualifications set revoked_at=now()",[]],
   ['unknown_usage',"update benchmark_budget_calls set actual_tokens=null where account_id=$1",[account]],
   ['active_lease',"update mission_assignments set lease=$2,lease_until=now()+interval '1 minute' where id=$1",[work.job.id,randomUUID()]],
   ['review_already_done',"update mission_assignments set status='completed' where mission_id=$1 and role='review'",[work.mission.id]],
   ['review_wrong_dependency',"update mission_assignments set dependencies='{}' where mission_id=$1 and role='review'",[work.mission.id]],
   ['plan_hash',"update agent_missions set project_evidence=jsonb_set(project_evidence,'{benchmarkContinuationPlanHash}',to_jsonb('wrong'::text)) where id=$1",[work.mission.id]]]){
    await db.query('begin');await db.query(sql,params);assert.equal(await recover(),false,name);await db.query('rollback');
  }
  await db.query('begin');await db.query('reset role');
  await db.query('alter table benchmark_full_continuations disable trigger benchmark_continuation_immutable');
  await db.query("update benchmark_full_continuations set created_at=now()-interval '5 hours',deadline=now()-interval '1 hour'");
  await db.query('set local role service_role');assert.equal(await recover(),false,'parent expires between validation and commit');await db.query('rollback');
  for(const badScope of [scope+' app/counter/[id]/',scope+' app/counter/../']){
   await db.query('begin');await db.query("update work_projects set objective=$2 where id=$1",[project,badScope.trim()]);
   const badArgs=[...args];badArgs[4]=badScope.trim()+'\n';assert.equal(await recover(badArgs),false,'whole static scope token required');await db.query('rollback');
  }
  await db.query('begin');const directorySource=JSON.stringify({...raw,finalContract:{path:'app/counter/'}}),directoryResult={...original,rejectedSpecification:directorySource};
  await db.query('update mission_assignments set result=$2 where id=$1',[work.job.id,directoryResult]);
  assert.equal(await recover([project,work.job.id,directorySource,directoryResult,scope,repair.plan]),false,'directory is not a source file');await db.query('rollback');
  const beforeMission=(await db.query('select to_jsonb(m) m from agent_missions m where id=$1',[work.mission.id])).rows[0].m;
  const beforeAccount=(await db.query('select to_jsonb(a) a from benchmark_budget_accounts a where id=$1',[account])).rows[0].a;
  const beforeReview=(await db.query("select to_jsonb(j) j from mission_assignments j where mission_id=$1 and role='review'",[work.mission.id])).rows[0].j;
  const concurrent=await Promise.all([db.query(repairSql,args),rival.query(repairSql,args)]);
  assert.equal(concurrent.filter(r=>r.rows[0].ok).length,1);
  assert.equal(await recover(),false);
  const after=(await db.query('select * from mission_assignments where id=$1',[work.job.id])).rows[0];
  assert.equal(after.attempts,3);assert.equal(after.status,'completed');assert.equal(after.result.rejectedSpecification,source);
  assert.deepEqual(JSON.parse(after.result.text),JSON.parse(JSON.stringify(repair.plan)));
  const afterMission=(await db.query('select to_jsonb(m) m from agent_missions m where id=$1',[work.mission.id])).rows[0].m;
  for(const key of ['actual_tokens','reserved_tokens','calls','routing_calls','deadline','token_allowance','max_calls'])assert.deepEqual(afterMission[key],beforeMission[key],key);
  assert.equal(afterMission.status,'running');
  assert.deepEqual((await db.query('select to_jsonb(a) a from benchmark_budget_accounts a where id=$1',[account])).rows[0].a,beforeAccount);
  assert.deepEqual((await db.query("select to_jsonb(j) j from mission_assignments j where mission_id=$1 and role='review'",[work.mission.id])).rows[0].j,beforeReview);
  const audit=(await db.query("select data from project_events where project_id=$1 and event='specification_route_recovered'",[project])).rows;
  assert.equal(audit.length,1);assert.deepEqual(audit[0].data.originalResult,original);assert.equal(audit[0].data.compositionInference,false);
  // The corrected candidate reaches review without another composition call.
  // A denied atomic admission has no receipt and retains the normal second attempt.
  const reviewId=beforeReview.id,reviewFailure={detail:'Full benchmark account denied atomic model-call admission'};
  await db.query("update work_projects set status='blocked' where id=$1",[project]);
  await db.query("update agent_missions set status='blocked' where id=$1",[work.mission.id]);
  await db.query("update mission_assignments set status='failed',attempts=1,result=$2,detail=$3,updated_at=now()-interval '1 minute' where id=$1",[reviewId,reviewFailure,reviewFailure.detail]);
  const priceTime=(await db.query("update model_registry set pricing_status='verified',pricing_verified_at=date_trunc('milliseconds',now()),source_metadata=jsonb_build_object('pricing_verification_source','https://developers.openai.com/api/docs/models/gpt-5.3-codex') where model_id='gpt-5.3-codex' returning pricing_verified_at")).rows[0].pricing_verified_at;
  const retryReview=async()=>(await db.query('select recover_verified_price_review($1) ok',[project])).rows[0].ok;
  assert.equal(await retryReview(),false,'missing corroborating price event');
  await db.query("insert into project_events(project_id,event,data) values($1,'model_price_reverified',jsonb_build_object('model','gpt-5.3-codex','priorStatus','estimated','source','https://developers.openai.com/api/docs/models/gpt-5.3-codex','verifiedAt',$2::timestamptz))",[project,priceTime]);
  for(const [name,sql,params] of [
   ['zero_price',"update model_registry set pricing_input_per_1m=0 where model_id='gpt-5.3-codex'",[]],
   ['null_price',"update model_registry set pricing_output_per_1m=null where model_id='gpt-5.3-codex'",[]],
   ['estimated',"update model_registry set pricing_status='estimated' where model_id='gpt-5.3-codex'",[]],
   ['future_price',"update model_registry set pricing_verified_at=now()+interval '1 hour' where model_id='gpt-5.3-codex'",[]],
   ['stale_price',"update model_registry set pricing_verified_at=now()-interval '25 hours' where model_id='gpt-5.3-codex'",[]],
   ['unofficial_source',"update model_registry set source_metadata='{}' where model_id='gpt-5.3-codex'",[]],
   ['child_expiry',"update agent_missions set deadline=now()-interval '1 minute' where id=$1",[work.mission.id]],
   ['revoked',"update benchmark_production_qualifications set revoked_at=now()",[]],
   ['active_lease',"update mission_assignments set lease=$2,lease_until=now()+interval '1 minute' where id=$1",[reviewId,randomUUID()]],
   ['unknown_usage',"update benchmark_budget_calls set actual_tokens=null where account_id=$1",[account]],
   ['unsettled_usage',"update benchmark_budget_calls set state='unresolved' where account_id=$1",[account]],
   ['wrong_plan',"update agent_missions set project_evidence=jsonb_set(project_evidence,'{benchmarkContinuationPlanHash}',to_jsonb('wrong'::text)) where id=$1",[work.mission.id]],
   ['dependency',"update mission_assignments set dependencies='{}' where id=$1",[reviewId]],
   ['compose_incomplete',"update mission_assignments set status='failed' where id=$1",[work.job.id]],
   ['already_attempted_twice',"update mission_assignments set attempts=2 where id=$1",[reviewId]],
   ['other_failure',"update mission_assignments set detail='Some generic failure' where id=$1",[reviewId]],
   ['zero_token_call',"insert into mission_calls(id,job_id,lease,model,reserved_tokens,actual_tokens,status) values($1,$2,$3,'openai:gpt-5.3-codex',1,0,'completed')",[randomUUID(),reviewId,randomUUID()]]]){
   await db.query('begin');await db.query(sql,params);assert.equal(await retryReview(),false,name);await db.query('rollback');
  }
  await db.query('begin');await db.query('reset role');await db.query('alter table benchmark_full_continuations disable trigger benchmark_continuation_immutable');
  await db.query("update benchmark_full_continuations set created_at=now()-interval '5 hours',deadline=now()-interval '1 hour'");await db.query('set local role service_role');
  assert.equal(await retryReview(),false,'expired parent');await db.query('rollback');
  assert.equal((await db.query('select recover_game_specification_checkpoint($1) ok',[project])).rows[0].ok,false,'legacy checkpoint cannot detach Full child');
  await db.query('begin');assert.equal(await retryReview(),true,'normal attached recovery remains supported');await db.query('rollback');
  await db.query('update work_projects set active_mission_id=null where id=$1',[project]);
  assert.equal(await retryReview(),false,'detached source requires immutable checkpoint event');
  const detachedEvent=(await db.query("insert into project_events(project_id,event,data) values($1,'game_specification_checkpoint_recovered',jsonb_build_object('sourceMissionId',$2::text,'sourceJobId',$3::text,'recoveryType','saved_composition_fresh_review')) returning id",[project,work.mission.id,work.job.id])).rows[0].id;
  for(const [name,sql,params] of [
   ['wrong_source_job',"insert into project_events(project_id,event,data) select project_id,event,jsonb_set(data,'{sourceJobId}',to_jsonb($2::text)) from project_events where id=$1",[detachedEvent,randomUUID()]],
   ['wrong_source_mission',"insert into project_events(project_id,event,data) select project_id,event,jsonb_set(data,'{sourceMissionId}',to_jsonb($2::text)) from project_events where id=$1",[detachedEvent,randomUUID()]],
   ['newer_child',"update agent_missions set created_at=now() where id=$1",[failedMission]],
   ['competing_running_child',"update agent_missions set status='running' where id=$1",[failedMission]],
   ['stopped_source',"update agent_missions set status='stopped' where id=$1",[work.mission.id]],
   ['watchdog',"update work_projects set detail='Progress watchdog: three consecutive failed specification attempts' where id=$1",[project]]]){
    await db.query('begin');await db.query(sql,params);
    if(name==='watchdog')assert.equal((await db.query('select resume_game_checkpoint_watchdog($1) ok',[project])).rows[0].ok,false,'watchdog cannot spawn Full replacement');
    else assert.equal(await retryReview(),false,name);
    await db.query('rollback');
  }
  const reviewConcurrent=await Promise.all([db.query('select recover_verified_price_review($1) ok',[project]),rival.query('select recover_verified_price_review($1) ok',[project])]);
  assert.equal(reviewConcurrent.filter(r=>r.rows[0].ok).length,1);assert.equal(await retryReview(),false);
  const resumed=(await db.query('select * from mission_assignments where id=$1',[reviewId])).rows[0];
  assert.equal((await db.query('select active_mission_id from work_projects where id=$1',[project])).rows[0].active_mission_id,work.mission.id,'reattached exact source');
  assert.equal(resumed.status,'queued');assert.equal(resumed.attempts,1);assert.deepEqual(resumed.result,reviewFailure);
  assert.deepEqual((await db.query('select to_jsonb(a) a from benchmark_budget_accounts a where id=$1',[account])).rows[0].a,beforeAccount);
  const claimedReview=(await db.query('select claim_mission_work() c')).rows[0].c;
  assert.equal(claimedReview.job.id,reviewId);assert.equal(claimedReview.job.attempts,2,'normal lease increments preserved attempt');
  assert.equal((await db.query('select count(*)::int n from mission_calls where job_id=$1',[reviewId])).rows[0].n,0);
  await db.query('reset role');await db.query('set role authenticated');await assert.rejects(db.query(repairSql,args),/permission denied/);
  await assert.rejects(db.query('select recover_verified_price_review($1)',[project]),/permission denied/);
 }finally{
  for(const c of clients)try{await c.end()}catch{}
  if(started)try{run('pg_ctl',['-D',data,'-m','immediate','-w','stop'])}catch{}
  rmSync(root,{recursive:true,force:true});
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import config from '../config/benchmark-715-production-qualification.json' with {type:'json'};
test('Full continuation preserves failed trial and authorizes only bounded owner-approved new work',
 {timeout:180000},async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||'/usr/lib/postgresql/16/bin';
 const root=mkdtempSync(join(tmpdir(),'katie-continuation-')),data=join(root,'data');
 const clients=[];let started=false;
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr||r.error?.message)};
 const connect=async()=>{const c=new pg.Client({host:root,port:55478,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});
  await c.connect();clients.push(c);return c};
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(root,'log'),'-o',`-h '' -k ${root} -p 55478`,'-w','start']);started=true;
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
  const reserve=async tokens=>(await db.query('select benchmark_reserve_mission_call($1,$2,$3,$4,$5,false) id',[work.job.id,work.job.lease,randomUUID(),'openai:gpt-5.3-codex',tokens])).rows[0].id;
  const draft='select checkpoint_mission_specification_draft($1,$2,$3,$4,$5) ok';
  assert.equal((await db.query(draft,[work.job.id,randomUUID(),'raw',null,null])).rows[0].ok,false);
  assert.equal((await db.query(draft,[work.job.id,work.job.lease,'raw',null,null])).rows[0].ok,true);
  await db.query(draft,[work.job.id,work.job.lease,'raw','Invalid specification','candidate']);
  await db.query(draft,[work.job.id,work.job.lease,'raw','Invalid specification','candidate']);
  assert.equal((await db.query('select count(*)::int n from mission_specification_drafts where job_id=$1',[work.job.id])).rows[0].n,2);
  await assert.rejects(db.query("update mission_specification_drafts set raw_response='changed'"),/permission denied/);
  const call=await reserve(100);assert.ok(call);
  assert.equal((await db.query('select continuation_id from benchmark_budget_calls where id=$1',[call])).rows[0].continuation_id,approval.id);
  await db.query('begin');
  await db.query("update agent_missions set project_evidence=jsonb_set(project_evidence,'{benchmarkContinuationId}',to_jsonb($2::text)) where id=$1",[work.mission.id,randomUUID()]);
  assert.equal(await reserve(100),null);await db.query('rollback');
  await db.query('begin');await db.query("update benchmark_production_qualifications set revoked_at=now()");
  assert.equal(await reserve(100),null);await db.query('rollback');
  await db.query('begin');await db.query("update benchmark_budget_calls set state='unresolved' where id=$1",[call]);
  await assert.rejects(reserve(100),/admission denied/);await db.query('rollback');
  // Advance this isolated fixture clock; authorization is immutable to service_role.
  await db.query('begin');await db.query('reset role');
  await db.query('alter table benchmark_full_continuations disable trigger benchmark_continuation_immutable');
  await db.query("update benchmark_full_continuations set created_at=now()-interval '5 hours',deadline=now()-interval '1 hour'");
  await db.query('alter table benchmark_full_continuations enable trigger benchmark_continuation_immutable');
  await db.query('set local role service_role');
  assert.equal((await db.query(rpc,[owner,project,plan.planHash,true])).rows[0].result.live,false);
  assert.equal(await reserve(100),null);await db.query('rollback');
  await db.query('reset role');await db.query('set role authenticated');
  await assert.rejects(db.query(rpc,[owner,project,plan.planHash,true]),/permission denied/);
  await assert.rejects(db.query('select * from benchmark_full_continuations'),/permission denied/);
 }finally{
  for(const c of clients)try{await c.end()}catch{}
  if(started)try{run('pg_ctl',['-D',data,'-m','immediate','-w','stop'])}catch{}
  rmSync(root,{recursive:true,force:true});
 }
});

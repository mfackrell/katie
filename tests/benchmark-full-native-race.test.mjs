import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {protocolDigest} from '../scripts/benchmark/owner-staging-bootstrap.mjs';
test('Full native trial admission uses two real PostgreSQL connections and one mission cap',
 {timeout:180000},async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||'/usr/lib/postgresql/16/bin';
 const root=mkdtempSync(join(tmpdir(),'katie-native-race-')),data=join(root,'data');
 const clients=[];let started=false;
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr||r.error?.message)};
 const connect=async()=>{const c=new pg.Client({host:root,port:55479,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});
  await c.connect();clients.push(c);return c};
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(root,'log'),'-o',`-h '' -k ${root} -p 55479`,'-w','start']);started=true;
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
  await db.query('set role service_role');
  await db.query("insert into actors(id,name) values('a1111111-1111-4111-8111-111111111111','Native acceptance fixture')");
  await db.query("insert into chats(id,actor_id,title) values('a2222222-2222-4222-8222-222222222222','a1111111-1111-4111-8111-111111111111','Native acceptance fixture')");
  await db.query(`insert into managed_agents(actor_id,config) values
   ('a1111111-1111-4111-8111-111111111111',
    '{"name":"Native Developer","instructions":"Test only",
    "research":true,"development":true,"attachments":false,
    "reviewMode":"always","maxActiveTasks":1,"maxInputChars":1000}'::jsonb)`);
  await db.query(readFileSync('tests/sql/benchmark-full-native-external-admission.sql','utf8'));
  const row=(await db.query(`select g.trial_id,g.token_digest,g.execution_epoch,g.project_id,
    m.id as mission_id
    from benchmark_execution_grants g join work_projects p on p.id=g.project_id
    join agent_missions m on m.project_id=p.id where g.token_digest=repeat('8',64)`)).rows[0];
  assert.ok(row);
  await db.query("update work_projects set status='running' where id=$1",[row.project_id]);
  const rivals=await Promise.all([connect(),connect()]);
  for(const client of rivals)await client.query('set role service_role');
  const outcomes=await Promise.all(rivals.map(async c=>{
   try{const result=await c.query('select benchmark_full_native_reserve($1,$2,$3,$4,$5,$6) id',
    [row.token_digest,row.trial_id,Number(row.execution_epoch),randomUUID(),'synthetic',20]);
    return{success:!!result.rows[0].id};}
   catch{return{success:false};}
  }));
  assert.equal(outcomes.filter(x=>x.success).length,1,'only last mission slot may be admitted');
  const mission=(await db.query('select calls,reserved_tokens from agent_missions where id=$1',[row.mission_id])).rows[0];
  assert.equal(mission.calls,2);
  const projections=(await db.query('select count(*)::int n from benchmark_budget_calls where account_id=(select account_id from benchmark_execution_grants where token_digest=$1)',[row.token_digest])).rows[0].n;
  assert.equal(projections,2,'exactly one new canonical charge for the admissible attempt');
  await db.query("update work_projects set status='blocked',detail='Completed isolated Native race fixture.' where id=$1",[row.project_id]);

  // Exercise the existing owner request -> game project -> project mission
  // lifecycle. The project/account association is created atomically by its
  // service RPC; no project, mission or spending approval is inserted directly.
  const actor='b1111111-1111-4111-8111-111111111111',chat='b2222222-2222-4222-8222-222222222222';
  const repo='b3333333-3333-4333-8333-333333333333',trial='b4444444-4444-4444-8444-444444444444';
  const exp='b5555555-5555-4555-8555-555555555555',project='b6666666-6666-4666-8666-666666666666';
  await db.query('insert into actors(id,name) values($1,$2)',[actor,'Full DO accounting fixture']);
  await db.query('insert into chats(id,actor_id,title) values($1,$2,$3)',[chat,actor,'Full DO accounting fixture']);
  await db.query('insert into repo_sync_runs(id,repository_full_name) values($1,$2)',[repo,'mfackrell/katie']);
  await db.query(`insert into model_registry(provider_name,model_id,normalized_model_id,pricing_status,
    pricing_input_per_1m,pricing_output_per_1m) values('openai','gpt-5.3-codex','gpt-5.3-codex','verified',1,28)`);
  await db.query(`insert into benchmark_three_arm_trials(id,experiment_id,replicate,arm,owner_actor_id,
    contract_sha256,baseline_sha,model_policy_sha256,tool_profile_sha256,acceptance_sha256,runtime_sha256,state)
    values($1,$2,1,'full',$3,repeat('7',64),$4,repeat('8',64),repeat('9',64),repeat('a',64),repeat('b',64),'qualified')`,
    [trial,exp,actor,'0015bcdb8ac9ad94b7c74d1a4cd76737903b1319']);
  await db.query(`insert into benchmark_budget_accounts(experiment_id,trial_id,arm,owner_actor_id,cap_tokens,spent_tokens)
    values($1,$2,'full',$3,350000,0)`,[exp,trial,actor]);
  const created=(await db.query(`select benchmark_create_full_game_project($1,$2,$3,$4,$5,$6,$7,$8,$9) project`,[
    project,'full-do-'+project,actor,chat,'Build the browser game Take Eleven for Issue #715',repo,trial,
    '0015bcdb8ac9ad94b7c74d1a4cd76737903b1319','gpt-5.3-codex'])).rows[0].project;
  assert.equal(created.id,project);assert.equal(created.profile,'game');assert.equal(created.token_allowance,350000);
  const claimedProject=(await db.query('select claim_work_project() project')).rows[0].project;
  assert.equal(claimedProject.id,project);
  await db.query(`select finish_work_project($1,$2,'child',$3::jsonb)`,[project,claimedProject.lease,
    JSON.stringify({kind:'research',objective:'Review the authoritative Take Eleven requirements',evidence:{}})]);
  const claim=(await db.query('select claim_mission_work() claim')).rows[0].claim;
  assert.ok(claim?.job?.id&&claim.job.lease);
  const linked=(await db.query(`select mb.account_id,mb.baseline_sha from benchmark_mission_bindings mb
    where mb.mission_id=$1`,[claim.mission.id])).rows[0];
  assert.ok(linked);assert.equal(linked.baseline_sha,'0015bcdb8ac9ad94b7c74d1a4cd76737903b1319');
  const call='b7777777-7777-4777-8777-777777777777';
  const receipt=await db.query(`select benchmark_reserve_mission_call($1,$2,$3,$4,100,true) receipt`,
    [claim.job.id,claim.job.lease,call,'openai:gpt-5.3-codex']);
  assert.ok(receipt.rows[0].receipt,'actual DO assignment must reserve its Full ledger call atomically');
  const usage={input_tokens:70,output_tokens:20,total_tokens:90,input_tokens_details:{cached_tokens:30}};
  const settle='select benchmark_reconcile_provider_usage($1,$2,$3::jsonb,true) state';
  const other=await connect();await other.query('set role service_role');
  const race=await Promise.all([db.query(settle,[call,'resp_full_usage',JSON.stringify(usage)]),other.query(settle,[call,'resp_full_usage',JSON.stringify(usage)])]);
  assert.ok(race.every(r=>r.rows[0].state==='settled'));
  const spent=(await db.query(`select a.spent_tokens,c.state,c.actual_tokens,mc.actual_tokens mission_actual
    from benchmark_budget_accounts a join benchmark_budget_calls c on c.account_id=a.id
    join mission_calls mc on mc.id=$2::uuid where a.trial_id=$1 and c.request_key=$2::text`,[trial,call])).rows[0];
  assert.deepEqual(spent,{spent_tokens:'90',state:'settled',actual_tokens:'90',mission_actual:90});

  const evidence=(await db.query('select provider_usage,provider_request_id,pricing_snapshot,provider_receipt_at from benchmark_budget_calls where request_key=$1',[call])).rows[0];
  assert.deepEqual(evidence.provider_usage,usage);assert.equal(evidence.provider_request_id,'resp_full_usage');
  await assert.rejects(db.query(settle,[call,'resp_conflicting_id',JSON.stringify(usage)]),/conflict|mismatch/);
  assert.equal(evidence.pricing_snapshot.inputPerMillion,1);assert.ok(evidence.provider_receipt_at);
  await assert.rejects(db.query(settle,[call,'resp_full_usage',JSON.stringify({...usage,input_tokens:69,output_tokens:21})]),/immutable provider usage conflict/);
  await assert.rejects(db.query(settle,[call,'resp_full_usage',JSON.stringify({...usage,total_tokens:89})]),/totals inconsistent/);
  await assert.rejects(db.query(settle,[call,'resp_full_usage',JSON.stringify({total_tokens:90})]),/authoritative provider usage/);
  assert.equal((await db.query('select spent_tokens from benchmark_budget_accounts where id=$1',[linked.account_id])).rows[0].spent_tokens,'90');
  const standalone=(await db.query("select benchmark_reserve_call($1,'native-usage','gpt-5.3-codex',100) id",[linked.account_id])).rows[0].id;
  const nativeUsage={input_tokens:7,output_tokens:3,total_tokens:10};
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3::jsonb,false)',[standalone,'resp_native_usage',JSON.stringify(nativeUsage)]);
  assert.equal((await db.query('select provider_usage from benchmark_budget_calls where id=$1',[standalone])).rows[0].provider_usage.output_tokens,3);
  const uncertain=randomUUID();
  const admitted=(await db.query('select benchmark_reserve_mission_call($1,$2,$3,$4,100,false) receipt',[claim.job.id,claim.job.lease,uncertain,'openai:gpt-5.3-codex'])).rows[0].receipt;
  assert.ok(admitted);
  await db.query('select benchmark_finish_mission_call($1,null)',[uncertain]);
  assert.equal((await db.query('select state from benchmark_budget_calls where legacy_mission_call_id=$1',[uncertain])).rows[0].state,'unresolved');
  await db.query(settle,[uncertain,'resp_recovered_usage',JSON.stringify(nativeUsage)]);
  const recovered=(await db.query('select c.state,c.provider_usage,m.status from benchmark_budget_calls c join mission_calls m on m.id=c.legacy_mission_call_id where m.id=$1',[uncertain])).rows[0];
  assert.equal(recovered.state,'settled');assert.equal(recovered.status,'completed');assert.deepEqual(recovered.provider_usage,nativeUsage);
  await db.query('reset role');await db.query('set role anon');
  await assert.rejects(db.query(settle,[call,'resp_full_usage',JSON.stringify(usage)]),/permission denied/);
  await db.query('reset role');await db.query('set role service_role');

  const denied=await db.query(`select benchmark_reserve_mission_call($1,$2,$3,'other:model',100,false) receipt`,
    [claim.job.id,claim.job.lease,'b8888888-8888-4888-8888-888888888888']);
  assert.equal(denied.rows[0].receipt,null,'Full account rejects model-policy deviation before inference');
  // Synthetic fixture only: exercise privileged task approval with real tables.
  await db.query('reset role');
  await db.query('create table benchmark_production_qualifications(issue integer,owner_id uuid,actor_id uuid,experiment_id uuid,deadline timestamptz,revoked_at timestamptz)');
  await db.query('grant all on benchmark_production_qualifications to service_role');
  await db.query(readFileSync('supabase/migrations/20261028134500_benchmark_dashboard_task_approval.sql','utf8'));
  await db.query('set role service_role');
  const owner=randomUUID(),scope='d'.repeat(64);
  await db.query("insert into benchmark_production_qualifications values(715,$1,$2,$3,now()+interval '1 hour',null)",[owner,actor,exp]);
  await db.query("update work_projects set phase='development',status='running',approved_hash=$2,approval_hash=$2 where id=$1",[project,scope]);
  await db.query("update agent_missions set status='running' where id=$1",[claim.mission.id]);
  await db.query("update project_runs set binding=jsonb_build_object('scopeHash',$2::text,'contractHash',repeat('e',64)) where mission_id=$1",[claim.mission.id,scope]);
  const developer=(await db.query("select * from managed_agents where (config->>'development')::boolean limit 1")).rows[0];
  await db.query("update agent_missions set team=$2::jsonb where id=$1",[claim.mission.id,JSON.stringify([{id:developer.id,version:developer.version,config:developer.config}])]);
  await db.query("update mission_assignments set role='development',status='running',agent_id=$2,payload='{\"approved\":true,\"development_input\":\"Take Eleven\"}' where id=$1",[claim.job.id,developer.id]);
  const delegated=(await db.query('select mission_development_task($1,$2) task',[claim.job.id,claim.job.lease])).rows[0].task;
  assert.notEqual(delegated.actor_id,actor);assert.notEqual(delegated.chat_id,chat);
  await db.query("select transition_agent_task($1,'start')",[claim.job.id]);
  await db.query("update mission_assignments set status='waiting_external' where id=$1",[claim.job.id]);
  const approve='select benchmark_dashboard_full_task($1,$2,$3,true) approval';
  await assert.rejects(db.query(approve,[randomUUID(),claim.job.id,scope]),/authenticated owner/);
  await assert.rejects(db.query(approve,[owner,randomUUID(),scope]),/not eligible/);
  await assert.rejects(db.query(approve,[owner,claim.job.id,'f'.repeat(64)]),/not eligible/);
  const before=(await db.query('select spent_tokens from benchmark_budget_accounts where id=$1',[linked.account_id])).rows[0].spent_tokens;
  const approvals=await Promise.all([db.query(approve,[owner,claim.job.id,scope]),other.query(approve,[owner,claim.job.id,scope])]);
  assert.equal(approvals[0].rows[0].approval.approvalId,approvals[1].rows[0].approval.approvalId);
  const approvedRow=(await db.query('select * from benchmark_native_spending_approvals where task_id=$1',[claim.job.id])).rows[0];
  assert.equal(approvedRow.protocol_digest,protocolDigest((await db.query('select * from benchmark_three_arm_trials where id=$1',[trial])).rows[0],350000));
  await db.query('begin');
  await db.query('update benchmark_native_spending_approvals set revoked_at=now() where id=$1',[approvedRow.id]);
  await assert.rejects(db.query(approve,[owner,claim.job.id,scope]),/cannot be replaced/);
  await db.query('rollback');
  assert.equal((await db.query('select benchmark_full_task_provenance($1,$2) valid',[claim.job.id,project])).rows[0].valid,true);
  assert.equal((await db.query('select benchmark_full_task_provenance($1,$2) valid',[randomUUID(),project])).rows[0].valid,false);
  await db.query("update mission_assignments set status='running' where id=$1",[claim.job.id]);
  await db.query('select benchmark_bind_full_development_dispatch($1,$2,$3,$4)',[claim.job.id,project,scope,'e'.repeat(64)]);
  await db.query("update mission_assignments set status='waiting_external' where id=$1",[claim.job.id]);
  const granted=(await db.query('select benchmark_issue_execution_grant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) id',[owner,actor,chat,trial,approvedRow.id,'mfackrell/katie','gpt-5.3-codex',1,approvedRow.deadline,'6'.repeat(64)])).rows[0].id;
  assert.ok(granted);
  assert.equal((await db.query('select benchmark_dashboard_full_task($1) result',[owner])).rows[0].result.approvalState,'consumed');
  assert.equal((await db.query('select count(*)::int n from benchmark_native_spending_approvals where task_id=$1',[claim.job.id])).rows[0].n,1);
  assert.equal((await db.query('select spent_tokens from benchmark_budget_accounts where id=$1',[linked.account_id])).rows[0].spent_tokens,before);
  await db.query("update benchmark_production_qualifications set deadline=now()-interval '1 minute'");
  await assert.rejects(db.query(approve,[owner,claim.job.id,scope]),/authenticated owner/);
  await db.query('reset role');await db.query('set role authenticated');
  await assert.rejects(db.query(approve,[owner,claim.job.id,scope]),/permission denied/);
 }finally{
  for(const c of clients)try{await c.end()}catch{}
  if(started)try{run('pg_ctl',['-D',data,'-m','immediate','-w','stop'])}catch{}
  rmSync(root,{recursive:true,force:true});
 }
});

import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';import pg from 'pg';import {randomUUID} from 'node:crypto';
test('projects: real PostgreSQL idempotency, scope, lifecycle fencing and aggregate reservation races',{timeout:180000},async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||'/usr/lib/postgresql/16/bin',root=mkdtempSync(join(tmpdir(),'katie-projects-')),data=join(root,'data'),clients=[];let started=false;
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr||r.error?.message);};
 const connect=async()=>{const c=new pg.Client({host:root,port:55435,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});await c.connect();clients.push(c);return c;};
 try{run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);run('pg_ctl',['-D',data,'-l',join(root,'log'),'-o',`-h '' -k ${root} -p 55435`,'-w','start']);started=true;const db=await connect();await db.query(readFileSync('tests/fixtures/project-base.sql','utf8'));for(const f of ['20261016211426_agent_management.sql','20261016234048_autonomous_missions.sql',...readdirSync('supabase/migrations').filter(f=>f.endsWith('_chat_projects.sql')||f.endsWith('_project_review_recovery.sql')||f.endsWith('_project_phase_budgets.sql')||f.endsWith('_project_notes_preserve_scope.sql')||f.endsWith('_project_infrastructure_retry.sql')||f.endsWith('_project_verification_only_retry.sql')||f.endsWith('_project_browser_bootstrap_retry.sql')||f.endsWith('_autonomous_recovery_control_plane.sql'))])await db.query(readFileSync('supabase/migrations/'+f,'utf8'));await db.query('set role service_role');await db.query(readFileSync('tests/fixtures/project-state-assertions.sql','utf8'));await db.query(readFileSync('tests/fixtures/project-review-recovery.sql','utf8'));await db.query(readFileSync('tests/fixtures/project-verification-retry.sql','utf8'));await db.query(readFileSync('tests/fixtures/project-browser-bootstrap-retry.sql','utf8'));
  const job=(await db.query("select j.* from mission_assignments j join work_projects p on p.active_mission_id=j.mission_id where j.status='running' and j.role='development' limit 1")).rows[0];assert.ok(job);
  const rivals=await Promise.all([connect(),connect()]);for(const c of rivals)await c.query('set role service_role');const reservations=await Promise.all(rivals.map(c=>c.query('select reserve_mission_call($1,$2,$3,$4,$5) ok',[job.id,job.lease,randomUUID(),'fixture',20000])));assert.equal(reservations.filter(r=>r.rows[0].ok).length,1,'project prior charges plus concurrent reservations cannot exceed the shared allowance');assert.equal((await db.query('select status from work_projects')).rows[0].status,'blocked');assert.equal(Number((await db.query('select sum(reserved_tokens) amount from agent_missions')).rows[0].amount),50000);
  // Durable recovery is generic and does not create a new coding mission.
  const discovered=await db.query('select discover_recovery_cases() n');
  assert.ok(Number(discovered.rows[0].n)>=1);
  const recovery=(await db.query("select * from recovery_cases where source_type='project' limit 1")).rows[0];
  assert.ok(recovery);assert.equal(recovery.status,'observed');
  const lease=(await db.query('select claim_recovery_case() as c')).rows[0].c;
  assert.equal(lease.id,recovery.id);assert.equal(lease.status,'claimed');
  assert.equal(lease.attempt,1);
  const wrong=await db.query("select finish_recovery_case($1,$2,$3,$4,$5,$6) as result",
    [recovery.id,randomUUID(),'resolved','unknown','diagnose','Wrong lease']);
  assert.equal(wrong.rows[0].result,null);
  const finish=await db.query("select finish_recovery_case($1,$2,$3,$4,$5,$6) as result",
    [recovery.id,lease.lease,'requires_owner','unknown','owner_required','Case requires a scoped owner decision']);
  assert.equal(finish.rows[0].result.status,'requires_owner');
  const duplicate=await db.query('select discover_recovery_cases() n');
  assert.ok(Number(duplicate.rows[0].n)>=0);
  assert.equal((await db.query('select count(*)::int n from recovery_cases where id=$1',[recovery.id])).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from recovery_events where case_id=$1',[recovery.id])).rows[0].n,2);

  // A failed reviewed coding job can be retried only against its exact saved
  // mission/run, with original approval and prior accounting preserved.
  await db.query('begin');
  const fixtureProject='44444444-4444-4444-8444-444444444444';
  const fixtureMission=(await db.query('select active_mission_id from work_projects where id=$1',[fixtureProject])).rows[0].active_mission_id;
  await db.query("update work_projects set status='blocked',token_allowance=600000 where id=$1",[fixtureProject]);
  await db.query("update agent_missions set status='blocked' where id=$1",[fixtureMission]);
  await db.query("update mission_assignments set status='failed',result=$2::jsonb where mission_id=$1 and role='development'",[
    fixtureMission,JSON.stringify({external:{receipt:{run_id:39177788633,outcome:'BLOCKED',checks:{test:'false',review:'pass',repair:'failure'}}}}),
  ]);
  const args=[fixtureProject,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',fixtureMission,39177788633];
  const recover=async a=>(await db.query('select retry_project_infrastructure($1,$2,$3,$4,$5) saved',a)).rows[0].saved;
  assert.equal(await recover([...args.slice(0,4),39177788634]),null,'mismatched workflow receipt cannot retry');
  assert.equal(await recover([args[0],'99999999-9999-4999-8999-999999999999',...args.slice(2)]),null,'wrong actor cannot retry');
  const recovered=await recover(args);
  assert.equal(recovered.status,'running');assert.equal(recovered.phase,'development');
  assert.equal(recovered.active_mission_id,null);assert.equal(recovered.cycles,1);
  assert.equal(recovered.approved_hash,recovered.approval_hash);
  assert.equal(await recover(args),null,'infrastructure retry is exactly once');
  assert.equal((await db.query('select count(*) n from project_runs where project_id=$1 and outcome->>\'infrastructure_retry\'=\'true\'',[fixtureProject])).rows[0].n,'1');
  await db.query('rollback');
  await db.query('reset role');await db.query('set role anon');for(const table of ['work_projects','project_agents','project_runs','project_events'])await assert.rejects(db.query('select * from '+table),/permission denied/);await assert.rejects(db.query('select claim_work_project()'),/permission denied/);await assert.rejects(db.query("select retry_project_review('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222')"),/permission denied/);
 }finally{await Promise.allSettled(clients.map(c=>c.end()));if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);rmSync(root,{recursive:true,force:true});}
});

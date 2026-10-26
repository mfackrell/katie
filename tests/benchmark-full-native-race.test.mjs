import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
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
   '20261025205000_benchmark_native_owner_assignment_grants'])
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
 }finally{
  for(const c of clients)try{await c.end()}catch{}
  if(started)try{run('pg_ctl',['-D',data,'-m','immediate','-w','stop'])}catch{}
  rmSync(root,{recursive:true,force:true});
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
const migration=readFileSync('supabase/migrations/20261028210800_provider_availability_recovery.sql','utf8');
test('provider cooldown recovery is one-shot, fenced, preserves evidence and refuses unsafe replay', {timeout:60000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'katie-provider-recovery-')),bin=process.env.KATIE_TEST_PG_BIN||'/usr/lib/postgresql/16/bin';let started=false,db;
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr||r.error?.message)};
 try{
  run('initdb',['-D',join(root,'data'),'-U','postgres','-A','trust','--no-locale']);
  run('pg_ctl',['-D',join(root,'data'),'-l',join(root,'log'),'-o',`-h '' -k ${root} -p 55481`,'-w','start']);started=true;
  db=new pg.Client({host:root,port:55481,user:'postgres',database:'postgres'});await db.connect();
  await db.query(`create role anon;create role authenticated;
   create table work_projects(id uuid,status text,active_mission_id uuid,deadline timestamptz,approved_hash text,token_allowance int,lease uuid,lease_until timestamptz,failures int,detail text,updated_at timestamptz);
   create table agent_missions(id uuid,project_id uuid,status text,deadline timestamptz,calls int,max_calls int,reserved_tokens int,actual_tokens int,token_allowance int,project_evidence jsonb,created_at timestamptz,detail text,updated_at timestamptz);
   create table mission_assignments(id uuid,mission_id uuid,status text,role text,updated_at timestamptz,result jsonb,detail text,attempts int,lease uuid,lease_until timestamptz,available_at timestamptz);
   create table mission_calls(job_id uuid,status text);
   create table benchmark_full_project_bindings(project_id uuid);
   create table benchmark_full_continuations(id uuid,project_id uuid,account_id uuid,created_at timestamptz,deadline timestamptz);
   create table provider_health(provider_name text,status text,reason text,updated_at timestamptz,blocked_until timestamptz);
   create table project_events(project_id uuid,event text,data jsonb);
   create function benchmark_continuation_live(uuid,uuid,uuid) returns boolean language sql as 'select exists(select 1 from benchmark_full_continuations where id=$1 and account_id=$2 and project_id=$3 and deadline>now())';
   create function project_publish(uuid,text) returns void language sql as 'select';`);
  await db.query(migration);
  const p='00000000-0000-4000-8000-000000000001',m='00000000-0000-4000-8000-000000000002',j='00000000-0000-4000-8000-000000000003',c='00000000-0000-4000-8000-000000000004';
  const reset=async()=>{await db.query('truncate work_projects,agent_missions,mission_assignments,mission_calls,benchmark_full_project_bindings,benchmark_full_continuations,provider_health,project_events');await db.query(`insert into work_projects values($1,'blocked',$2,now()+interval '4 hours',null,350000,null,null,0,'blocked',now());
   insert into agent_missions values($2,$1,'blocked',now()+interval '1 hour',0,12,0,0,90000,jsonb_build_object('benchmarkContinuationId',$4::text),now()-interval '10 minutes',null,now());
   insert into mission_assignments values($3,$2,'failed','compose',now()-interval '2 minutes','{"checkpoint":"saved"}','No connected provider supports the required bounded orchestration tools',1,null,null,now());
   insert into benchmark_full_project_bindings values($1);
   insert into benchmark_full_continuations values($4,$1,$4,now()-interval '20 minutes',now()+interval '3 hours');
   insert into provider_health values('openai','blocked','provider billing or quota is unavailable',now()-interval '5 minutes',now()-interval '1 minute');`.replaceAll('$1',`'${p}'`).replaceAll('$2',`'${m}'`).replaceAll('$3',`'${j}'`).replaceAll('$4',`'${c}'`));};
  const recover=async()=> (await db.query('select recover_mission_credit_failure($1) ok',[p])).rows[0].ok;
  await reset();await db.query("update provider_health set blocked_until=now()+interval '1 minute'");assert.equal(await recover(),false,'active cooldown');
  await reset();assert.equal(await recover(),true,'expired cooldown queues genuine mission probe');assert.equal(await recover(),false,'duplicate recovery');
  let r=(await db.query('select * from project_events')).rows[0];assert.equal(r.data.availabilityVerified,false);assert.equal(r.data.priorResult.checkpoint,'saved');
  await db.query("update work_projects set status='blocked';update agent_missions set status='blocked';update mission_assignments set status='failed'");assert.equal(await recover(),false,'persistent failure never loops');
  await reset();await db.query("update benchmark_full_continuations set deadline=now()-interval '1 minute'");assert.equal(await recover(),false,'expired continuation');
  await reset();await db.query("update agent_missions set deadline=now()-interval '1 minute'");assert.equal(await recover(),false,'expired mission');
  await reset();await db.query('insert into mission_calls values($1,\'uncertain\')',[j]);assert.equal(await recover(),false,'uncertain paid request');
  await reset();await db.query(`update mission_assignments set result='{"diagnostic":{"providerAvailability":[{"kind":"credentials","provider":"openai"}]}}'`);assert.equal(await recover(),false,'credentials are not credit failures');
  await reset();await db.query(`update mission_assignments set result='{"diagnostic":{"providerAvailability":[{"kind":"unsupported_model","provider":"openai"}]}}'`);assert.equal(await recover(),false,'capability failure');
  await reset();await db.query(`update mission_assignments set result='{"checkpoint":"saved","diagnostic":{"providerAvailability":[{"kind":"cooldown","provider":"openai"}]}}'`);assert.equal(await recover(),true,'structured cooldown recovery');
  await reset();const rival=new pg.Client({host:root,port:55481,user:'postgres',database:'postgres'});await rival.connect();try{const outcomes=await Promise.all([recover(),rival.query('select recover_mission_credit_failure($1) ok',[p]).then(r=>r.rows[0].ok)]);assert.equal(outcomes.filter(Boolean).length,1,'parallel recovery queues once');}finally{await rival.end();}
  await reset();await db.query("delete from provider_health");assert.equal(await recover(),false,'unsubstantiated legacy generic failure');
 }finally{await db?.end();if(started)spawnSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','stop']);rmSync(root,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
test('missions: real PostgreSQL fencing, handoffs, permissions, budgets, approvals and concurrent claims',{timeout:180000},async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||'/usr/lib/postgresql/16/bin';const root=mkdtempSync(join(tmpdir(),'katie-missions-')),data=join(root,'data');const clients=[];let started=false;
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr||r.error?.message);};
 const connect=async()=>{const c=new pg.Client({host:root,port:55433,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});await c.connect();clients.push(c);return c;};
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);run('pg_ctl',['-D',data,'-l',join(root,'log'),'-o',`-h '' -k ${root} -p 55433`,'-w','start']);started=true;
  const db=await connect();await db.query(`create role anon;create role authenticated;create role service_role bypassrls;create table actors(id uuid primary key,name text,system_prompt text,review_mode text);create table chats(id uuid primary key,actor_id uuid references actors,title text,created_at timestamptz,updated_at timestamptz);create table chat_requests(request_id text primary key,actor_id text,chat_id text,status text,error_message text,updated_at timestamptz);grant select,update on chat_requests to service_role;create table repo_sync_runs(id uuid primary key,repository_full_name text);grant usage on schema public to service_role;grant select,insert,update on actors,chats,repo_sync_runs to service_role;alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
  for(const file of ['20261016211426_agent_management.sql','20261016234048_autonomous_missions.sql'])await db.query(readFileSync('supabase/migrations/'+file,'utf8'));
  await db.query('set role service_role');await db.query(readFileSync('tests/fixtures/mission-state-assertions.sql','utf8'));
  const cfg={name:'Concurrent worker',instructions:'Test durable admission.',research:false,attachments:false,development:false,reviewMode:'always',maxActiveTasks:4,maxInputChars:8000};
  const a=(await db.query('select save_managed_agent(null,$1,false) agent',[cfg])).rows[0].agent;
  const ids=Array.from({length:4},()=>randomUUID());
  for(const id of ids){await db.query('select create_mission($1,$2,$3)',[id,'Concurrent mission',[a.id]]);await db.query("select control_mission($1,'start')",[id]);}
  const workers=await Promise.all(ids.map(()=>connect()));for(const c of workers)await c.query('set role service_role');
  const results=await Promise.all(workers.map(c=>c.query('select claim_mission_work() claim')));const claims=results.map(r=>r.rows[0].claim).filter(Boolean);
  assert.equal(claims.length,3,'overlapping sessions cannot admit more than three background workers');assert.equal(new Set(claims.map(c=>c.job.id)).size,3);
  const j=claims[0].job,call=randomUUID();
  const reservations=await Promise.all(workers.slice(0,2).map(c=>c.query('select reserve_mission_call($1,$2,$3,$4,$5) accepted',[j.id,j.lease,call,'fixture',100])));
  assert.equal(reservations.filter(r=>r.rows[0].accepted).length,1,'duplicate call identity reserves exactly once');
  for(const c of workers.slice(0,2)){await c.query('reset role');await c.query('set role anon');await assert.rejects(c.query('select * from agent_missions'),/permission denied/);await assert.rejects(c.query('select claim_mission_work()'),/permission denied/);}
 }finally{await Promise.allSettled(clients.map(c=>c.end()));if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);rmSync(root,{recursive:true,force:true});}
});

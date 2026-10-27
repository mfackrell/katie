import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import config from '../config/benchmark-715-production-qualification.json' with {type:'json'};
const migration=readdirSync('supabase/migrations').find(x=>x.endsWith('_benchmark_production_owner_qualification.sql'));
const sqlFile=name=>readFileSync('supabase/migrations/'+name,'utf8');
test('owner transfer and production qualification are atomic, exclusive, idempotent and bounded in real PostgreSQL', {timeout:180000},async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||'/usr/lib/postgresql/16/bin';
 const root=mkdtempSync(join(tmpdir(),'katie-production-owner-')),data=join(root,'data');
 const clients=[];let started=false;
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr||r.error?.message)};
 const connect=async(database)=>{const c=new pg.Client({host:root,port:55488,user:'postgres',database});await c.connect();clients.push(c);return c};
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(root,'log'),'-o',`-h '' -k ${root} -p 55488`,'-w','start']);started=true;
  const admin=await connect('postgres');
  await admin.query('create role anon;create role authenticated;create role service_role bypassrls');
  await admin.query('create database source');await admin.query('create database destination');
  const stage=await connect('source'),prod=await connect('destination');
  const setup=async db=>{
   await db.query('create table actors(id uuid primary key);create table mission_calls(id uuid primary key)');
   for(const file of ['20261024163000_benchmark_durable_accounts.sql','20261025170000_benchmark_three_arm_trials.sql','20261025183000_benchmark_trial_accounts_and_projection.sql','202604030001_model_registry.sql'])await db.query(sqlFile(file));
   await db.query(`alter table benchmark_budget_accounts add column frozen_at timestamptz;
    alter table benchmark_budget_calls add column provider_namespace text;
    alter table benchmark_budget_calls add column provider_request_id text;
    alter table benchmark_budget_calls drop constraint benchmark_budget_calls_state_check;
    alter table benchmark_budget_calls add check(state in ('reserved','settled','unresolved','overrun'));
    create table benchmark_native_spending_approvals(id uuid default gen_random_uuid(),owner_id uuid,actor_id uuid,consumed_at timestamptz,revoked_at timestamptz);
    create table benchmark_execution_grants(id uuid,deadline timestamptz,revoked_at timestamptz,stopped_at timestamptz);
    grant usage on schema public to service_role;grant all on all tables in schema public to service_role`);
   await db.query(sqlFile(migration));
  };
  await setup(stage);await setup(prod);
  const actor=randomUUID(),owner=randomUUID(),exp=randomUUID(),p=config.protocol;
  for(const db of [stage,prod])await db.query('insert into actors values($1)',[actor]);
  const trialArgs=[exp,actor,p.baselineSha,p.contract_sha256,p.acceptance_sha256,p.model_policy_sha256,p.tool_profile_sha256,p.runtime_sha256];
  const addTrial=async(db,arm,replicate=1)=> (await db.query(`insert into benchmark_three_arm_trials(experiment_id,replicate,arm,owner_actor_id,baseline_sha,contract_sha256,acceptance_sha256,model_policy_sha256,tool_profile_sha256,runtime_sha256,state)
    values($1,$10,$9,$2,$3,$4,$5,$6,$7,$8,case when $9='full' then 'planned' else 'running' end) returning id`,[...trialArgs,arm,replicate])).rows[0].id;
  for(const arm of ['native','thin','full']){
   const tid=await addTrial(stage,arm);
   const aid=(await stage.query('insert into benchmark_budget_accounts(experiment_id,trial_id,arm,owner_actor_id,cap_tokens,spent_tokens) values($1,$2,$3,$4,350000,$5) returning id',[exp,tid,arm,actor,arm==='full'?0:20])).rows[0].id;
   if(arm!=='full')for(let i=0;i<4;i++)await stage.query("insert into benchmark_budget_calls(account_id,request_key,model,reserved_tokens,actual_tokens,state,provider_namespace) values($1,$2,'gpt-5.3-codex',5,5,'settled','nonbillable-synthetic-fixture')",[aid,String(i)]);
  }
  for(let i=0;i<2;i++)await stage.query('insert into benchmark_native_spending_approvals(owner_id,actor_id,consumed_at) values($1,$2,now())',[owner,actor]);
  const args=[owner,'123','a'.repeat(40),config.authorizationBodySha256,p];
  const transferQuery='select benchmark_claim_production_transfer($1,$2,$3,$4,$5) as receipt';
  await stage.query('set role anon');await assert.rejects(stage.query(transferQuery,args),/permission denied/);await stage.query('reset role');
  await assert.rejects(stage.query(transferQuery,[randomUUID(),...args.slice(1)]),/owner authority/);
  // Admission wins first: transfer waits on its account lock and then refuses
  // the newly committed unresolved attempt; it cannot certify a clean ledger.
  const sourceAccount=(await stage.query('select id from benchmark_budget_accounts order by id limit 1')).rows[0].id;
  const challenger=await connect('source');
  await stage.query('begin');
  const attempt=(await stage.query("select benchmark_reserve_call($1,'race-first','gpt-5.3-codex',1) as id",[sourceAccount])).rows[0].id;
  const blockedTransfer=challenger.query(transferQuery,args).then(()=>({allowed:true}),e=>({error:e.message}));
  for(let i=0;i<100;i++){
   const row=(await admin.query('select wait_event_type from pg_stat_activity where pid=$1',[challenger.processID])).rows[0];
   if(row?.wait_event_type==='Lock')break;
   await new Promise(r=>setTimeout(r,10));
   if(i===99)assert.fail('transfer did not wait on admission lock');
  }
  await stage.query('commit');assert.match((await blockedTransfer).error,/provider receipts/);
  assert.equal((await stage.query('select count(*) from benchmark_production_transfer_claims')).rows[0].count,'0');
  await stage.query('delete from benchmark_budget_calls where id=$1',[attempt]); // isolated test fixture only
  await stage.query('begin');
  const transfer=(await stage.query(transferQuery,args)).rows[0].receipt;
  const rival=await connect('source');
  const race=addTrial(rival,'native',2).then(()=>({allowed:true}),e=>({error:e.message}));
  const raceAdmission=challenger.query("select benchmark_reserve_call($1,'race-after','gpt-5.3-codex',1)",[sourceAccount]).then(()=>({allowed:true}),e=>({error:e.message}));
  await stage.query('commit');assert.match((await race).error,/transferred/);assert.match((await raceAdmission).error,/transferred/);
  assert.deepEqual((await stage.query(transferQuery,[owner,'999','b'.repeat(40),config.authorizationBodySha256,p])).rows[0].receipt,transfer);
  assert.equal((await stage.query('select count(*) from benchmark_budget_accounts where frozen_at is not null')).rows[0].count,'3');
  await assert.rejects(stage.query('update benchmark_budget_accounts set frozen_at=null'),/immutable/);
  await assert.rejects(stage.query("insert into benchmark_budget_calls(account_id,request_key,model,reserved_tokens) select id,'new','gpt-5.3-codex',1 from benchmark_budget_accounts limit 1"),/transferred/);
  assert.equal((await stage.query('select count(*) from benchmark_budget_calls')).rows[0].count,'8');
  await prod.query("insert into model_registry(provider_name,model_id,normalized_model_id,pricing_status,pricing_input_per_1m,pricing_output_per_1m,pricing_verified_at) values('openai','gpt-5.3-codex','gpt-5.3-codex','verified',1.75,14,now())");
  const qualify='select benchmark_qualify_production_owner($1,$2,$3,$4,$5,$6) as receipt';
  const qa=[owner,actor,'123','a'.repeat(40),transfer,p];
  await prod.query('set role authenticated');await assert.rejects(prod.query(qualify,qa),/permission denied/);await prod.query('reset role');
  await prod.query("alter table benchmark_budget_accounts add constraint injected_failure check(arm<>'thin')");
  await assert.rejects(prod.query(qualify,qa),/injected_failure/);
  for(const table of ['benchmark_three_arm_trials','benchmark_budget_accounts','benchmark_production_qualifications'])assert.equal((await prod.query(`select count(*) from ${table}`)).rows[0].count,'0');
  await prod.query('alter table benchmark_budget_accounts drop constraint injected_failure');
  const second=await connect('destination');
  const receipts=await Promise.all([prod.query(qualify,qa),second.query(qualify,qa)]);
  assert.deepEqual(receipts[0].rows,receipts[1].rows);
  const receipt=receipts[0].rows[0].receipt;
  assert.equal(receipt.experimentId,exp);assert.equal(receipt.arms.length,3);assert.equal(receipt.taskApprovalGranted,false);
  assert.equal((await prod.query('select count(*) from benchmark_native_spending_approvals')).rows[0].count,'0');
  assert.equal((await prod.query('select count(*) from benchmark_execution_grants')).rows[0].count,'0');
  await assert.rejects(addTrial(prod,'native',3),/replacement/);
  const originalBaseline=trialArgs[2];trialArgs[2]='f'.repeat(40);
  await assert.rejects(addTrial(prod,'native',3),/replacement/);trialArgs[2]=originalBaseline;
  await assert.rejects(prod.query("update benchmark_three_arm_trials set baseline_sha=repeat('f',40)"),/replacement/);
  await assert.rejects(prod.query('update benchmark_budget_accounts set cap_tokens=350001'),/immutable/);
  const account=receipt.arms.find(a=>a.arm==='full').accountId;
  const reserve=(db,key,tokens=1,model='openai:gpt-5.3-codex')=>db.query('select benchmark_reserve_call($1,$2,$3,$4) as id',[account,key,model,tokens]);
  await assert.rejects(reserve(prod,'wrong',1,'other-model'),/admission denied/);
  await prod.query("update model_registry set pricing_output_per_1m=null");await assert.rejects(reserve(prod,'null'),/admission denied/);
  await prod.query("update model_registry set pricing_output_per_1m=29");await assert.rejects(reserve(prod,'expensive'),/admission denied/);
  await prod.query("update model_registry set pricing_output_per_1m=14,pricing_verified_at=now()-interval '25 hours'");await assert.rejects(reserve(prod,'stale'),/admission denied/);
  await prod.query('update model_registry set pricing_verified_at=now()');
  const admitted=(await reserve(prod,'one',10)).rows[0].id;
  await assert.rejects(reserve(prod,'one',10),/duplicate/);
  await prod.query("update benchmark_budget_calls set state='unresolved' where id=$1",[admitted]);await assert.rejects(reserve(prod,'uncertain'),/admission denied/);
  await prod.query("update benchmark_budget_calls set state='reserved' where id=$1",[admitted]);await prod.query('select benchmark_settle_call($1,10)',[admitted]);
  const replay=(await prod.query(qualify,qa)).rows[0].receipt;
  assert.equal(replay.arms.find(a=>a.arm==='full').spentTokens,10);assert.equal(replay.deadline,receipt.deadline);
  const results=await Promise.allSettled([reserve(prod,'racer-a',200000),reserve(second,'racer-b',200000)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  await assert.rejects(reserve(prod,'exhaust',200000),/budget exhausted/);
  await prod.query("update benchmark_production_qualifications set deadline=now()-interval '1 second'");await assert.rejects(reserve(prod,'expired'),/admission denied/);
  const expiredReplay=(await prod.query(qualify,qa)).rows[0].receipt;assert.ok(Date.parse(expiredReplay.deadline)<Date.now());
 }finally{
  await Promise.allSettled(clients.map(c=>c.end()));
  if(started)spawnSync(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{encoding:'utf8',timeout:30000});
  rmSync(root,{recursive:true,force:true});
 }
});

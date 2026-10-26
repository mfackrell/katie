import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
const OWNER='11111111-1111-4111-8111-111111111111';
const ACTOR='22222222-2222-4222-8222-222222222222';
const CHAT='33333333-3333-4333-8333-333333333333';
const TRIAL='44444444-4444-4444-8444-444444444444';
const ACCOUNT='55555555-5555-4555-8555-555555555555';
const APPROVAL='66666666-6666-4666-8666-666666666666';
const TOKEN='a'.repeat(64);
test('real PostgreSQL Native/Thin owner grant issuance is atomic, one-time and arm-specific',
 {timeout:180000},async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||'/usr/lib/postgresql/16/bin';
 const root=mkdtempSync(join(tmpdir(),'nonfull-grant-db-'));
 const data=join(root,'data');let started=false;
 let db;
 const run=(name,args)=>{
  const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr||r.error?.message);
 };
 const seed=async arm=>{
  await db.query('truncate benchmark_execution_grants,benchmark_budget_calls,benchmark_native_spending_approvals,benchmark_budget_accounts,benchmark_three_arm_trials');
  await db.query('insert into benchmark_three_arm_trials values($1,$2,$3,$4)',
   [TRIAL,arm,'qualified',ACTOR]);
  await db.query('insert into benchmark_budget_accounts(id,trial_id,arm,owner_actor_id,cap_tokens) values($1,$2,$3,$4,$5)',
   [ACCOUNT,TRIAL,arm,ACTOR,100]);
  await db.query(`insert into benchmark_native_spending_approvals(
   id,owner_id,actor_id,chat_id,trial_id,account_id,repository,model,deadline,
   max_tokens,protocol_digest) values($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '10 minutes',100,$9)`,
   [APPROVAL,OWNER,ACTOR,CHAT,TRIAL,ACCOUNT,'mfackrell/katie','synthetic','b'.repeat(64)]);
 };
 const grant=async()=>db.query(`select benchmark_issue_nonfull_execution_grant(
  $1,$2,$3,$4,$5,$6,$7,1,now()+interval '5 minutes',$8) id`,
  [OWNER,ACTOR,CHAT,TRIAL,APPROVAL,'mfackrell/katie','synthetic',TOKEN]);
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(root,'log'),'-o',`-h '' -k ${root} -p 55489`,'-w','start']);
  started=true;
  db=new pg.Client({host:root,port:55489,user:'postgres',database:'postgres'});
  await db.connect();
  await db.query(readFileSync('tests/sql/benchmark-nonfull-grant-schema.sql','utf8'));
  await db.query(readFileSync('supabase/migrations/20261026130000_benchmark_nonfull_execution_grants.sql','utf8'));
  await db.query('set role service_role');
  for(const arm of ['native','thin']){
   await seed(arm);
   const successful=await grant();
   assert.ok(successful.rows[0].id);
   const state=await db.query('select state from benchmark_three_arm_trials where id=$1',[TRIAL]);
   assert.equal(state.rows[0].state,'running');
   const approvals=await db.query('select consumed_at from benchmark_native_spending_approvals where id=$1',[APPROVAL]);
   assert.ok(approvals.rows[0].consumed_at);
   await assert.rejects(grant(),/owner grant authorization missing/);
   const num=await db.query('select count(*)::int n from benchmark_execution_grants');
   assert.equal(num.rows[0].n,1);
  }
  await seed('full');
  await assert.rejects(grant(),/qualified trial missing/);
  await seed('native');
  await db.query('update benchmark_native_spending_approvals set revoked_at=now()');
  await assert.rejects(grant(),/owner grant authorization missing/);
 }finally{
  if(db)try{await db.end()}catch{}
  if(started)try{run('pg_ctl',['-D',data,'-m','immediate','-w','stop'])}catch{}
  rmSync(root,{recursive:true,force:true});
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

// This fixture never connects to DATABASE_URL or a production database.
test('historical Grok cost reconciliation requires 47 verified receipts and is idempotent', {timeout:120000}, async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||['/usr/lib/postgresql/16/bin','/usr/lib/postgresql/17/bin','/tmp/katie-pg-bin'].find(x=>existsSync(join(x,'initdb')));
 assert.ok(bin,'A disposable PostgreSQL fixture is required');
 const dir=mkdtempSync(join(tmpdir(),'grok-cost-pg-')),data=join(dir,'data');
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr||r.error?.message);};
 const db=new pg.Client({host:'127.0.0.1',port:55483,user:'postgres',database:'postgres'});
 const migration=readFileSync(new URL('../supabase/migrations/20261103164000_standalone_historical_grok_cost_reconciliation.sql',import.meta.url),'utf8');
 let started=false,connected=false;
 try {
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(dir,'log'),'-o',"-h 127.0.0.1 -k '' -p 55483",'-w','start']);started=true;
  await db.connect();connected=true;
  await db.query(readFileSync(new URL('./sql/standalone-accounting-schema.sql',import.meta.url),'utf8'));
  await db.query(readFileSync(new URL('../supabase/migrations/20261028193000_standalone_provider_attempt_ledger.sql',import.meta.url),'utf8'));
  await db.query(migration); // Fresh installations with no legacy receipts are unchanged.
  const owner=randomUUID(),actor=randomUUID(),chat=randomUUID(),model='grok-4.7',pricing='grok-fixture';
  await db.query("insert into public.actors(id,name,actor_kind) values($1,'grok-test','standard')",[actor]);
  await db.query("insert into public.chats(id,actor_id,title) values($1,$2,'Grok test')",[chat,actor]);
  await db.query('select public.standalone_bind_scope($1,$2,$3)',[owner,actor,chat]);
  await db.query("insert into public.standalone_owner_configuration(owner_id,timezone,per_call_limit_microusd,request_limit_microusd) values($1,'America/Chicago',1000000,5000000)",[owner]);
  await db.query("insert into public.standalone_pricing_versions(version,metadata) values($1,'{}'::jsonb)",[pricing]);
  const insertSql=[
   'insert into public.standalone_provider_attempts',
   '(owner_id,actor_id,chat_id,request_id,attempt_key,base_attempt_key,source_prepared_hash,',
   'prepared_hash,prepared_payload,pricing_version,provider,model,category,preflight_estimate,',
   'estimator_version,reason,state,reserved_microusd,actual_microusd,budget_revision,',
   'provider_receipt_id,usage,evidence,response_checkpoint,dispatched_at,settled_at,created_at)',
   "values($1,$2,$3,'fixture-'||$11,'grok:0','grok:0',repeat('a',64),",
   "repeat('a',64),'{}'::jsonb,$4,'grok',$5,'chat','{}'::jsonb,",
   "'fixture','saved receipt','settled',20000,$7,1,$6,$8::jsonb,$9::jsonb,$10::jsonb,",
   "now(),now(),'2026-10-30T12:00:00Z')"
  ].join(' ');
  async function seed(i,correct=false){
   const receipt='grok-receipt-'+i,old=correct?11743:5000,next=i===46?11749:11743;
   const usage={prompt_tokens:3000,completion_tokens:500,total_tokens:4700,inputTokens:3000,
    outputTokens:correct?1700:500,completion_tokens_details:{reasoning_tokens:1200},
    cost_in_usd_ticks:next*10000};
   const evidence={kind:'provider_receipt',pricingVersion:pricing,pricedModel:model,requestedModel:model};
   const checkpoint={status:200,statusText:'OK',headers:[['content-type','application/json']],
    body:JSON.stringify({id:receipt,model,usage})};
   await db.query(insertSql,[owner,actor,chat,pricing,model,receipt,old,
    JSON.stringify(usage),JSON.stringify(evidence),JSON.stringify(checkpoint),String(i)]);
  }
  for(let i=0;i<47;i++)await seed(i);
  await assert.rejects(db.query(migration),/GROK_HISTORICAL_RECEIPT_INVENTORY_CHANGED/);
  await db.query('rollback');
  assert.equal((await db.query("select count(*)::int n from standalone_attempt_events where kind='historical_cost_correction'")).rows[0].n,0);
  await seed(47,true);
  await db.query(migration);
  const summary=async()=>(await db.query(
   "select count(*)::int n,count(*) filter(where evidence#>>'{historicalCostCorrection,version}'='xai-reported-ticks-20261103-v1')::int corrected,sum(actual_microusd) total_cost,count(distinct provider_receipt_id)::int receipts from standalone_provider_attempts where provider='grok'")).rows[0];
  let row=await summary();
  assert.equal(row.n,48);assert.equal(row.corrected,47);assert.equal(row.receipts,48);
  assert.equal(Number(row.total_cost),47*5000+11743+316927);
  const countEvents=async()=>(await db.query("select count(*)::int n from standalone_attempt_events where kind='historical_cost_correction'")).rows[0].n;
  assert.equal(await countEvents(),47);
  const repaired=(await db.query("select actual_microusd,usage,evidence from standalone_provider_attempts where request_id='fixture-0'")).rows[0];
  assert.equal(Number(repaired.actual_microusd),11743);
  assert.equal(Number(repaired.usage.outputTokens),1700);
  assert.equal(repaired.evidence.historicalCostCorrection.previousMicrousd,'5000');
  const intact=(await db.query("select actual_microusd,evidence from standalone_provider_attempts where request_id='fixture-47'")).rows[0];
  assert.equal(Number(intact.actual_microusd),11743);
  assert.equal(intact.evidence.historicalCostCorrection,undefined);
  await db.query(migration); // Repeat is a no-op, including events.
  row=await summary();assert.equal(row.corrected,47);
  assert.equal(await countEvents(),47);
 }finally{
  if(connected)await db.end().catch(()=>{});
  if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
 }
});

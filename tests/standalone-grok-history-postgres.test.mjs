import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

const owner='04ed6c05-a586-4a56-ba81-1b50e378746b';
const sql=readFileSync(new URL('../supabase/migrations/20261103170000_standalone_grok_issue966_reconciliation.sql',import.meta.url),'utf8');

test('issue 966: Grok receipts are corrected atomically, audited once, and never retransmitted', {timeout:120000}, async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||['/usr/lib/postgresql/16/bin','/usr/lib/postgresql/17/bin','/tmp/katie-pg-bin'].find(p=>existsSync(join(p,'initdb')));
 assert.ok(bin,'PostgreSQL initdb/pg_ctl required for real ledger test');
 const dir=mkdtempSync(join(tmpdir(),'grok-history-pg-')),data=join(dir,'data');
 const port=55474;
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr||r.error?.message||name);
 };
 let started=false,admin;
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(dir,'log'),'-o','-h 127.0.0.1 -k '+String.fromCharCode(39,39)+' -p '+port,'-w','start']);
  started=true;
  admin=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});
  await admin.connect();
  await admin.query(readFileSync(new URL('./sql/standalone-accounting-schema.sql',import.meta.url),'utf8'));
  await admin.query(readFileSync(new URL('../supabase/migrations/20261028193000_standalone_provider_attempt_ledger.sql',import.meta.url),'utf8'));
  await admin.query(sql);
  assert.equal((await admin.query('select count(*)::int n from standalone_provider_attempts')).rows[0].n,0,'fresh databases receive no synthetic history');

  const actor=randomUUID(),chat=randomUUID(),hash='a'.repeat(64);
  await admin.query("insert into actors(id,name) values($1,'Grok test actor')",[actor]);
  await admin.query("insert into chats(id,actor_id,title) values($1,$2,'Grok test chat')",[chat,actor]);
  await admin.query("select standalone_bind_scope($1,$2,$3)",[owner,actor,chat]);
  await admin.query("select standalone_register_pricing('grok-fixture-pricing','{}'::jsonb)");
  const insert=[
   'insert into standalone_provider_attempts (owner_id,actor_id,chat_id,request_id,attempt_key,prepared_hash,prepared_payload,',
   'source_prepared_hash,base_attempt_key,pricing_version,provider,model,category,preflight_estimate,estimator_version,reason,',
   'resolved_model,state,reserved_microusd,actual_microusd,budget_revision,usage,evidence,provider_receipt_id,response_checkpoint,',
   'created_at,dispatched_at,settled_at) values ($1,$2,$3,$4,$5,$6,$7,$6,$5,',
   "'grok-fixture-pricing','grok','grok-4.7','chat','{}'::jsonb,'fixture','test','grok-4.7','settled',$8,$9,1,$10,$11,$12,$13,",
   "'2026-11-01T11:59:00Z','2026-11-01T12:00:00Z','2026-11-01T12:01:00Z')"
  ].join(' ');
  const receipts=[];
  for(let i=1;i<=48;i++){
   const oldCost=i<=46?10000:i===47?1425322:16000;
   const corrected=i<=46?11000:i===47?1696249:16000;
   const ticks=corrected*10000-(i<=23?3333:0);
   const receipt='fixture-grok-'+i;receipts.push(receipt);
   const usage={inputTokens:20,prompt_tokens:20,outputTokens:10,completion_tokens:10,total_tokens:130,
    completion_tokens_details:{reasoning_tokens:100},cost_in_usd_ticks:ticks};
   const evidence={kind:'provider_receipt',requestHash:hash,pricingVersion:'grok-fixture-pricing',
    requestedModel:'grok-4.7',resolvedModel:'grok-4.7',pricedModel:'grok-4.7',pricingUnknown:false};
   const checkpoint={status:200,statusText:'OK',headers:[],
    body:JSON.stringify({id:receipt,model:'grok-4.7',usage})};
   await admin.query(insert,[owner,actor,chat,'grok-fixture-'+i,'chat:0',hash,JSON.stringify({model:'grok-4.7'}),
    corrected+100,oldCost,JSON.stringify(usage),JSON.stringify(evidence),receipt,JSON.stringify(checkpoint)]);
  }
  // The complete migration must fail closed and roll back when one receipt is inconsistent.
  await admin.query("update standalone_provider_attempts set usage=jsonb_set(usage,'{total_tokens}','131'::jsonb) where provider_receipt_id=$1",[receipts[0]]);
  await assert.rejects(admin.query(sql),/GROK_966_INVALID_RECEIPT_OR_USAGE/);
  await admin.query('rollback');
  assert.equal((await admin.query("select count(*)::int n from standalone_attempt_events where kind='historical_cost_correction'")).rows[0].n,0);
  assert.equal((await admin.query("select sum(actual_microusd) s from standalone_provider_attempts where provider='grok'")).rows[0].s,'1901322');
  await admin.query("update standalone_provider_attempts set usage=jsonb_set(usage,'{total_tokens}','130'::jsonb) where provider_receipt_id=$1",[receipts[0]]);
  await admin.query(sql);

  const after=(await admin.query([
   'select count(*)::int n,',
   "count(*) filter(where evidence#>>'{historicalCostCorrection,batch}'='issue-966-grok-history-20261103')::int corrected,",
   'sum(actual_microusd) total_cost,count(distinct provider_receipt_id)::int receipts,',
   "count(*) filter(where usage->>'outputTokens'='110')::int updated_output",
   "from standalone_provider_attempts where provider='grok'"
  ].join(' '))).rows[0];
  assert.equal(after.n,48);
  assert.equal(after.corrected,47);
  assert.equal(after.total_cost.toString(),'2218249','corrected 47 plus unchanged 16,000');
  assert.equal(after.receipts,48);
  assert.equal(after.updated_output,47);
  const audit=(await admin.query([
    "select count(*)::int n,coalesce(sum((details->>'correctedMicrousd')::numeric-(details->>'originalMicrousd')::numeric),0) delta",
    "from standalone_attempt_events where kind='historical_cost_correction'"
  ].join(' '))).rows[0];
  assert.equal(audit.n,47);assert.equal(audit.delta.toString(),'316927');

  // A migration retry cannot revise already corrected receipts or duplicate audit events.
  await admin.query(sql);
  assert.equal((await admin.query("select count(*)::int n from standalone_attempt_events where kind='historical_cost_correction'")).rows[0].n,47);
  const legacy=(await admin.query('select actual_microusd,usage from standalone_provider_attempts where provider_receipt_id=$1',[receipts[47]])).rows[0];
  assert.equal(legacy.actual_microusd,'16000');
  assert.equal(legacy.usage.outputTokens,10);
 } finally{
  if(admin)await admin.end().catch(()=>{});
  if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
 }
});

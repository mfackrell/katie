import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

// This suite never calls a paid provider or mutates production infrastructure.
test('reporting-only accounting: over-limit dispatch, independent fallback, unknown cost, idempotency and owner isolation', {timeout:120000}, async()=>{
  const bin=process.env.KATIE_TEST_PG_BIN||['/usr/lib/postgresql/16/bin','/usr/lib/postgresql/17/bin','/tmp/katie-pg-bin'].find(p=>existsSync(join(p,'initdb')));
  assert.ok(bin,'isolated native PostgreSQL is required (KATIE_TEST_PG_BIN)');
  const dir=mkdtempSync(join(tmpdir(),'reporting-only-pg-')),data=join(dir,'data'),port=55519;
  const run=(name,args)=>{
    const result=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,(result.stderr||result.error?.message||'')+(existsSync(join(dir,'log'))?readFileSync(join(dir,'log'),'utf8'):''));
  };
  const clients=[];let started=false;
  const connect=async(role)=>{
    const client=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});
    await client.connect();clients.push(client);
    if(role)await client.query('set role '+role);
    return client;
  };
  const rpc=async(c,name,args)=>{
    const keys=Object.keys(args),values=Object.values(args).map(value=>value&&typeof value==='object'?JSON.stringify(value):value);
    return (await c.query('select standalone_'+name+'('+keys.map((key,i)=>key+' => $'+(i+1)).join(',')+') value',values)).rows[0].value;
  };
  const migration=file=>readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
  try {
    run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
    run('pg_ctl',['-D',data,'-l',join(dir,'log'),'-o',"-h 127.0.0.1 -k '' -p "+port,'-w','start']);started=true;
    const admin=await connect();
    await admin.query(readFileSync(new URL('./sql/standalone-accounting-schema.sql',import.meta.url),'utf8'));
    for(const file of [
      '20261028193000_standalone_provider_attempt_ledger.sql',
      '20261029153000_standalone_deleted_scope_history.sql',
      '20261029170000_standalone_pricing_and_enrollment.sql',
      '20261029190000_standalone_actor_authority.sql',
      '20261029200000_standalone_uncertain_exposure_continuation.sql',
      '20261029210000_standalone_qwen_infrastructure.sql',
      '20261029224959_standalone_uncertainty_owner_limits.sql',
      '20261030193000_qwen_long_prompt_policy_v2.sql',
      '20261030230000_venice_dolphin_vision_fallback.sql',
      '20261031011500_standalone_owner_selected_uncached.sql',
      '20261031230000_standalone_chat_uncertainty_owner_binding.sql',
    ]) await admin.query(migration(file));
    const service=await connect('service_role');
    const owner=randomUUID(),actor=randomUUID(),chat=randomUUID();
    await admin.query("insert into actors values($1,'reporting-only fixture','standard')",[actor]);
    await admin.query("insert into chats(id,actor_id,title) values($1,$2,'reporting only')",[chat,actor]);
    await rpc(service,'bind_scope',{p_owner:owner,p_actor:actor,p_chat:chat});
    await rpc(service,'configure',{p_owner:owner,p_timezone:'America/Chicago',p_call:'1',p_request:'2'});
    const version='reporting-only-fixture';
    await rpc(service,'register_pricing',{p_version:version,p_metadata:{version,models:[]}});
    const workflow=request=>({p_owner:owner,p_actor:actor,p_chat:chat,p_request:request,p_hash:'a'.repeat(64),p_body:{task:'safely complete this saved request'}});
    const attempt=(request,key,provider,reserved)=>({
      p_owner:owner,p_actor:actor,p_chat:chat,p_request:request,p_key:key,p_hash:'b'.repeat(64),
      p_payload:{schemaVersion:'standalone-request-v1',provider,model:'fixture-model',endpoint:'/v1',
        payload:{model:'fixture-model'},hash:'b'.repeat(64)},
      p_pricing:version,p_provider:provider,p_model:'fixture-model',p_reserved:String(reserved),
      p_category:'routing',p_estimate:{status:'estimated',reservationMicrousd:String(reserved),
        requestHash:'b'.repeat(64),pricingVersion:version,estimatorVersion:'fixture-estimator'},
      p_estimator:'fixture-estimator',p_reason:'Owner-authorized synthetic provider attempt'
    });
    const oldLease=await rpc(service,'claim_workflow',workflow('historically-paused'));
    const historicallyPaused=await rpc(service,'admit',attempt('historically-paused','financial-pause','openai',100000));
    assert.equal(historicallyPaused.state,'paused','older migration gates calls above financial limit');
    await admin.query(migration('20261119160000_accounting_reporting_only.sql'));
    const resumedRow=await rpc(service,'lookup_attempt',{p_owner:owner,p_request:'historically-paused',p_key:'financial-pause'});
    assert.equal(resumedRow.state,'reserved','new migration releases prior cost-paused work');
    assert.equal((await rpc(service,'claim_dispatch',{p_owner:owner,p_attempt:resumedRow.id})).state,'dispatched');
    assert.equal(await rpc(service,'claim_dispatch',{p_owner:owner,p_attempt:resumedRow.id}),null,'atomic provider dispatch remains one-shot');
    await rpc(service,'mark_uncertain',{p_owner:owner,p_attempt:resumedRow.id,p_reason:'Provider receipt unavailable'});
    const released=await rpc(service,'finish_workflow',{p_owner:owner,p_request:'historically-paused',p_lease:oldLease.lease_token,p_status:'paused'});
    assert.equal(released.status,'paused');
    assert.equal((await rpc(service,'claim_workflow',{...workflow('historically-paused'),p_resume:true})).claimed,true,
      'previously unacknowledged uncertain cost cannot stop owner-bound resume');
    const history=await admin.query("select details->>'previous_state' old_state from standalone_attempt_events where attempt_id=$1 and kind='state_changed'",[resumedRow.id]);
    assert.ok(history.rows.some(row=>row.old_state==='paused'),'historical financial pause preserved in append-only events');
    const claimed=await rpc(service,'claim_workflow',workflow('new-task'));
    assert.equal(claimed.claimed,true);
    const first=await rpc(service,'admit',attempt('new-task','primary','openai',500000));
    assert.equal(first.state,'reserved','low per-call limit is reporting-only');
    assert.equal((await rpc(service,'claim_dispatch',{p_owner:owner,p_attempt:first.id})).state,'dispatched');
    await rpc(service,'checkpoint_response',{p_owner:owner,p_attempt:first.id,
      p_checkpoint:{status:200,statusText:'OK',headers:[],body:'{"answer":"saved result with no receipt"}'}});
    await rpc(service,'mark_uncertain',{p_owner:owner,p_attempt:first.id,p_reason:'Billing receipt absent'});
    assert.equal(await rpc(service,'claim_dispatch',{p_owner:owner,p_attempt:first.id}),null,'uncertain operation is not resent');
    const fallback=await rpc(service,'admit',attempt('new-task','independent-fallback','anthropic',10));
    assert.equal(fallback.state,'reserved','unconfirmed prior spending cannot prevent another authorized provider');
    assert.equal((await rpc(service,'claim_dispatch',{p_owner:owner,p_attempt:fallback.id})).state,'dispatched');
    const settled=await rpc(service,'settle',{p_owner:owner,p_attempt:fallback.id,p_provider:'anthropic',
      p_receipt:'authoritative-second-provider-receipt',p_actual:'175',
      p_usage:{inputTokens:22,outputTokens:8},p_evidence:{kind:'provider_usage',monetaryReceipt:true}});
    assert.equal(settled.state,'settled');
    assert.equal(settled.actual_microusd,'175','actual charge is retained even above the estimate');
    const missing=await rpc(service,'admit',attempt('new-task','unpriced-third','openai',0));
    assert.equal(missing.state,'reserved','missing price quote is not an execution gate');
    assert.equal((await rpc(service,'claim_dispatch',{p_owner:owner,p_attempt:missing.id})).state,'dispatched');
    await rpc(service,'record_partial_usage',{p_owner:owner,p_attempt:missing.id,
      p_usage:{inputTokens:50,outputTokens:20},p_evidence:{kind:'provider_usage',pricingUnknown:true}});
    const rows=await admin.query('select attempt_key,state,actual_microusd,usage,evidence from standalone_provider_attempts where owner_id=$1 and request_id=$2',[owner,'new-task']);
    const original=rows.rows.find(x=>x.attempt_key==='primary');
    const unpriced=rows.rows.find(x=>x.attempt_key==='unpriced-third');
    assert.equal(original.actual_microusd,null,'unknown primary cost is not represented as zero');
    assert.equal(unpriced.actual_microusd,null,'zero reservation does not invent a zero actual cost');
    assert.equal(unpriced.evidence.pricingUnknown,true);
    assert.equal(unpriced.usage.inputTokens,50);
    assert.equal((await rpc(service,'finish_workflow',{p_owner:owner,p_request:'new-task',
      p_lease:claimed.lease_token,p_status:'completed',p_result:{body:'completed',status:200,headers:[]}})).status,'completed',
      'open financial records cannot prevent completion of delivered work');
    assert.equal((await rpc(service,'claim_workflow',{...workflow('new-task'),p_resume:true})).claimed,false,
      'completed work stays durably idempotent');
    const foreignOwner=randomUUID();
    await assert.rejects(rpc(service,'admit',{...attempt('separate','foreign','openai',5),p_owner:foreignOwner}),/SCOPE_DENIED/);
    assert.equal(await rpc(service,'claim_dispatch',{p_owner:foreignOwner,p_attempt:first.id}),null,
      'cross-owner dispatch cannot claim an attempt');
    await rpc(service,'claim_workflow',workflow('owner-cancelled'));
    const cancelled=await rpc(service,'admit',attempt('owner-cancelled','stop','openai',5));
    await rpc(service,'cancel',{p_owner:owner,p_attempt:cancelled.id});
    await assert.rejects(rpc(service,'admit',attempt('owner-cancelled','next','anthropic',5)),/REQUEST_CANCELLED/);
    assert.equal(await rpc(service,'claim_dispatch',{p_owner:owner,p_attempt:cancelled.id}),null);
    console.log('REPORTING_ONLY_NATIVE_POSTGRES_GATE_SECURITY_AND_RECEIPT_PASS');
  } finally {
    await Promise.allSettled(clients.map(client=>client.end()));
    if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
    rmSync(dir,{recursive:true,force:true});
  }
});

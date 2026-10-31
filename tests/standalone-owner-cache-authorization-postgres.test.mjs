import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

test('unreviewed cache metadata requires one explicit owner authorization before same-model dispatch', {timeout:120000}, async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||['/usr/lib/postgresql/16/bin','/usr/lib/postgresql/17/bin','/tmp/katie-pg-bin'].find(p=>existsSync(join(p,'initdb')));
 assert.ok(bin,'PostgreSQL initdb/pg_ctl required');
 const dir=mkdtempSync(join(tmpdir(),'selected-uncached-approval-')),data=join(dir,'data');
 let started=false;const connections=[];
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,(r.stderr||r.error?.message||'')+(existsSync(join(dir,'log'))?readFileSync(join(dir,'log'),'utf8'):''));};
 const connect=async(role)=>{const c=new pg.Client({host:'127.0.0.1',port:55524,user:'postgres',database:'postgres'});await c.connect();connections.push(c);if(role)await c.query('set role '+role);return c;};
 const rpc=async(c,name,args)=>{const keys=Object.keys(args),vals=Object.values(args).map(v=>v&&typeof v==='object'?JSON.stringify(v):v);return (await c.query(`select standalone_${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) value`,vals)).rows[0].value;};
 try {
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(dir,'log'),'-o',"-h 127.0.0.1 -k '' -p 55524",'-w','start']);started=true;
  const admin=await connect();
  await admin.query(readFileSync(new URL('./sql/standalone-accounting-schema.sql',import.meta.url),'utf8'));
  for(const file of [
    '20261028193000_standalone_provider_attempt_ledger.sql',
    '20261029153000_standalone_deleted_scope_history.sql',
    '20261029170000_standalone_pricing_and_enrollment.sql',
    '20261029190000_standalone_actor_authority.sql',
    '20261029200000_standalone_uncertain_exposure_continuation.sql',
    '20261031011500_standalone_owner_selected_uncached.sql',
  ]) await admin.query(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  const one=await connect('service_role'),other=await connect('service_role');
  const owner=randomUUID(),outsider=randomUUID(),actor=randomUUID(),chat=randomUUID(),request='owner-selected-uncached';
  await admin.query("insert into actors values($1,'standard actor','standard')",[actor]);
  await admin.query("insert into chats(id,actor_id,title) values($1,$2,'same model')",[chat,actor]);
  await admin.query('insert into self_tool_owner_grants(owner_id,actor_id,chat_id) values($1,$2,$3)',[owner,actor,chat]);
  await rpc(one,'bind_scope',{p_owner:owner,p_actor:actor,p_chat:chat});
  const config=await rpc(one,'configure',{p_owner:owner,p_timezone:'America/Chicago',p_call:'500000',p_request:'2000000'});
  await rpc(one,'register_pricing',{p_version:'fixture-v1',p_metadata:{fixture:true}});
  const wf={p_owner:owner,p_actor:actor,p_chat:chat,p_request:request,p_hash:'a'.repeat(64),p_body:{original:'saved image message'}};
  let lease=await rpc(one,'claim_workflow',wf);assert.equal(lease.claimed,true);
  const estimate={status:'estimated',reservationMicrousd:'600',pricingVersion:'fixture-v1',estimatorVersion:'standalone-selected-model-uncached-v1',requestHash:'b'.repeat(64),ownerApprovalRequired:'selected_model_uncached'};
  const original={model:'gpt-5.4-mini-2026-03-17',messages:[{role:'user',content:'the exact same long prompt'}],max_completion_tokens:128};
  const input={p_owner:owner,p_actor:actor,p_chat:chat,p_request:request,p_key:'chat:0',p_hash:'b'.repeat(64),p_payload:{schemaVersion:'standalone-request-v1',provider:'openai',model:original.model,endpoint:'/v1/chat/completions',payload:original,hash:'b'.repeat(64)},p_pricing:'fixture-v1',p_provider:'openai',p_model:original.model,p_reserved:'600',p_category:'capability_lead',p_estimate:estimate,p_estimator:estimate.estimatorVersion,p_reason:'Owner exact-model decision'};
  const invalid={...input,p_request:'invalid-cache-metadata',p_key:'chat:1',p_payload:{...input.p_payload,payload:{...original,prompt_cache_key:'not-reviewed'}}};
  await assert.rejects(rpc(one,'admit',invalid),/STANDALONE_UNCACHED_APPROVAL_INVALID/);
  const attempt=await rpc(one,'admit',input);
  assert.equal(attempt.state,'paused','below-limit request still needs owner approval');
  assert.equal(attempt.pause_reason,'selected_model_uncached');
  assert.equal(await rpc(one,'claim_dispatch',{p_owner:owner,p_attempt:attempt.id}),null,'never silently paid');
  assert.equal((await rpc(one,'admit',input)).id,attempt.id,'preflight is idempotent');
  await rpc(one,'finish_workflow',{p_owner:owner,p_request:request,p_lease:lease.lease_token,p_status:'paused'});
  assert.equal((await rpc(one,'claim_workflow',{...wf,p_resume:true})).blocked,'approval_required');
  const approve={p_owner:owner,p_attempt:attempt.id,p_hash:input.p_hash,p_pricing:'fixture-v1',p_revision:config.budget_revision,p_reserved:'600'};
  await assert.rejects(rpc(other,'approve',{...approve,p_owner:outsider}),/STANDALONE_APPROVAL_DENIED/);
  await assert.rejects(rpc(one,'approve',{...approve,p_hash:'c'.repeat(64)}),/STANDALONE_APPROVAL_STALE/);
  const authorized=await rpc(one,'approve',approve);assert.equal(authorized.state,'reserved');
  assert.equal(authorized.approved_hash,input.p_hash);
  lease=await rpc(one,'claim_workflow',{...wf,p_resume:true});assert.equal(lease.claimed,true);
  const dispatched=await rpc(one,'claim_dispatch',{p_owner:owner,p_attempt:attempt.id});
  assert.equal(dispatched.state,'dispatched');
  assert.deepEqual(dispatched.prepared_payload.payload,original,'same model and entire request untouched');
  assert.equal(await rpc(other,'claim_dispatch',{p_owner:owner,p_attempt:attempt.id}),null,'no repeat dispatch');
  // Legacy pause occurred after Qwen had completed, without a paused OpenAI
  // attempt. The scoped recovery function must find it without any upload.
  const oldRequest='saved-unpriced-legacy';
  const oldWf={...wf,p_request:oldRequest,p_hash:'c'.repeat(64)};
  const oldLease=await rpc(one,'claim_workflow',oldWf);
  await rpc(one,'finish_workflow',{p_owner:owner,p_request:oldRequest,p_lease:oldLease.lease_token,p_status:'paused',
    p_result:{body:'{"type":"accounting_pause","code":"standalone_unsupported_billing","message":"No reviewed no-fee cache metadata policy for this exact model"}\\n',status:200,headers:[]}});
  assert.deepEqual(await rpc(one,'owner_cache_authorization_recovery',{p_owner:owner,p_actor:actor,p_chat:chat}),{requestId:oldRequest});
  await assert.rejects(rpc(other,'owner_cache_authorization_recovery',{p_owner:outsider,p_actor:actor,p_chat:chat}),/STANDALONE_SCOPE_DENIED/);

 } finally {
  await Promise.allSettled(connections.map(c=>c.end()));
  if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
 }
});

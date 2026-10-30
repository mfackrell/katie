import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

test('Venice independent vision fallback is admitted atomically with a reviewed price and immutable payload', {timeout:120000},async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||['/usr/lib/postgresql/16/bin','/usr/lib/postgresql/17/bin'].find(p=>existsSync(join(p,'initdb')));
 assert.ok(bin,'PostgreSQL fixture server required');
 const dir=mkdtempSync(join(tmpdir(),'standalone-venice-pg-')),data=join(dir,'data'),port=55513;
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});
   assert.equal(r.status,0,(r.stderr||r.error?.message||'')+(existsSync(join(dir,'log'))?readFileSync(join(dir,'log'),'utf8'):''));};
 const connections=[];let started=false;
 const connect=async(role)=>{const c=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});await c.connect();connections.push(c);if(role)await c.query('set role '+role);return c;};
 const rpc=async(c,name,args)=>{const keys=Object.keys(args),vals=Object.values(args).map(v=>v&&typeof v==='object'?JSON.stringify(v):v);
   return (await c.query('select standalone_'+name+'('+keys.map((k,i)=>k+' => $'+(i+1)).join(',')+') value',vals)).rows[0].value;};
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(dir,'log'),'-o',"-h 127.0.0.1 -k '' -p "+port,'-w','start']);started=true;
  const admin=await connect();
  await admin.query(readFileSync(new URL('./sql/standalone-accounting-schema.sql',import.meta.url),'utf8'));
  for(const file of ['20261028193000_standalone_provider_attempt_ledger.sql','20261029153000_standalone_deleted_scope_history.sql',
      '20261029170000_standalone_pricing_and_enrollment.sql','20261029190000_standalone_actor_authority.sql',
      '20261029200000_standalone_uncertain_exposure_continuation.sql','20261029210000_standalone_qwen_infrastructure.sql',
      '20261030193000_qwen_long_prompt_policy_v2.sql','20261030183000_venice_dolphin_vision_fallback.sql'])
    await admin.query(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  const service=await connect('service_role'),owner=randomUUID(),actor=randomUUID(),chat=randomUUID();
  await admin.query("insert into actors values($1,'Venice fixture','standard')",[actor]);
  await admin.query("insert into chats(id,actor_id,title) values($1,$2,'Venice fixture chat')",[chat,actor]);
  await rpc(service,'bind_scope',{p_owner:owner,p_actor:actor,p_chat:chat});
  await admin.query('insert into self_tool_owner_grants(owner_id,actor_id,chat_id) values($1,$2,$3)',[owner,actor,chat]);
  const configure=(perCall='500000',perRequest='2000000')=>rpc(service,'configure',{p_owner:owner,p_timezone:'America/Chicago',p_call:perCall,p_request:perRequest});
  await configure();
  const model='venice-uncensored-1-2',version='standalone-venice-dolphin-vision-v1';
  await rpc(service,'register_pricing',{p_version:version,p_metadata:{version,provider:'venice',model,reservationMicrousd:'100000',inputUsdPerMillion:0.2,outputUsdPerMillion:0.9}});
  const prompt='Analyze the primary focal point and details carefully.';
  const source='a'.repeat(64);
  const payload={model,temperature:0,max_tokens:4096,stream:false,store:false,
    venice_parameters:{enable_web_search:'off',enable_web_scraping:false,include_venice_system_prompt:false},
    messages:[{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:'data:image/png;base64,QUJDRA=='}}]}]};
  const hash='b'.repeat(64);
  const prepared={schemaVersion:'standalone-venice-still-v1',provider:'venice',model,
    endpoint:'/api/v1/chat/completions',payload,attachmentId:'test-attachment',sourceHash:source,question:prompt,hash,serializedBody:JSON.stringify(payload)};
  const input=(request,payloadToUse=prepared,h=hash)=>({p_owner:owner,p_actor:actor,p_chat:chat,p_request:request,p_key:'venice-fallback',
    p_hash:h,p_payload:payloadToUse,p_pricing:version,p_provider:'venice',p_model:model,p_reserved:'100000',
    p_category:'attachment-observation',p_estimate:{status:'estimated',requestHash:h,pricingVersion:version,estimatorVersion:version,reservationMicrousd:'100000'},
    p_estimator:version,p_reason:'Reviewed Venice vision fallback'});
  const attempt=await rpc(service,'admit',input('good-venice-request'));
  assert.equal(attempt.state,'reserved');
  assert.equal(attempt.reserved_microusd,'100000');
  const claimed=await rpc(service,'claim_dispatch',{p_owner:owner,p_attempt:attempt.id});
  assert.equal(claimed.state,'dispatched');
  assert.equal(await rpc(service,'claim_dispatch',{p_owner:owner,p_attempt:attempt.id}),null,'only one dispatch can win');
  const complete={p_owner:owner,p_attempt:attempt.id,
    p_checkpoint:{status:200,statusText:'OK',headers:[['content-type','application/json']],
      body:JSON.stringify({id:'response-synthetic',model,choices:[{finish_reason:'stop',message:{content:'Primary focal point: cup. Detailed focal-point observations: ceramic glaze.'}}]})},
    p_evidence:{status:'completed',sourceHash:source}};
  const saved=await rpc(service,'complete_venice_estimate',complete);
  assert.equal(saved.state,'estimated');
  assert.equal(saved.actual_microusd,null,'usage is not an authoritative monetary receipt');
  assert.equal(saved.evidence.reservedMicrousd,'100000');
  assert.deepEqual(await rpc(service,'complete_venice_estimate',complete),saved,'same saved outcome is idempotent');
  await assert.rejects(rpc(service,'complete_venice_estimate',{...complete,p_checkpoint:{...complete.p_checkpoint,body:'{"different":"result"}'}}),/CHECKPOINT_CONFLICT|COMPLETION_INVALID/);
  const invalidHash='c'.repeat(64);
  const invalidPayload={...payload,venice_parameters:{...payload.venice_parameters,enable_web_search:'on'}};
  const invalidPrepared={...prepared,payload:invalidPayload,hash:invalidHash,serializedBody:JSON.stringify(invalidPayload)};
  const injected=await rpc(service,'admit',input('web-search-injected',invalidPrepared,invalidHash));
  await assert.rejects(rpc(service,'claim_dispatch',{p_owner:owner,p_attempt:injected.id}),/STANDALONE_VENICE_POLICY_DENIED/,'billable tools are forbidden');
  const invalidRow=await rpc(service,'lookup_attempt',{p_owner:owner,p_request:'web-search-injected',p_key:'venice-fallback'});
  assert.equal(invalidRow.state,'reserved','rejected request was never dispatched');
  await configure('50000','2000000');
  const paused=await rpc(service,'admit',input('over-call-threshold'));
  assert.equal(paused.state,'paused');assert.equal(paused.pause_reason,'per_call_threshold');
  assert.equal(await rpc(service,'claim_dispatch',{p_owner:owner,p_attempt:paused.id}),null);
  console.log('VENICE_ATOMIC_ADMISSION_REPLAY_OWNER_BUDGET_AND_FAIL_CLOSED_PASS');
 }finally{
  await Promise.allSettled(connections.map(c=>c.end()));
  if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
 }
});

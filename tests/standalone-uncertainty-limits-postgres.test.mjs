import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

test('uncertainty obeys existing owner limits atomically without changing exposure or dispatch identity', {timeout:120000}, async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||['/usr/lib/postgresql/16/bin','/usr/lib/postgresql/17/bin','/tmp/katie-pg-bin'].find(p=>existsSync(join(p,'initdb')));
 assert.ok(bin,'PostgreSQL initdb/pg_ctl required (set KATIE_TEST_PG_BIN)');
 const dir=mkdtempSync(join(tmpdir(),'standalone-uncertain-pg-')),data=join(dir,'data');
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,(r.stderr||r.error?.message||'')+(existsSync(join(dir,'log'))?readFileSync(join(dir,'log'),'utf8'):''));};
 const connections=[];let started=false;
 const connect=async(role)=>{const c=new pg.Client({host:'127.0.0.1',port:55509,user:'postgres',database:'postgres'});await c.connect();connections.push(c);if(role)await c.query('set role '+role);return c;};
 const rpc=async(c,name,args)=>{const keys=Object.keys(args),vals=Object.values(args).map(v=>v&&typeof v==='object'?JSON.stringify(v):v);return (await c.query(`select standalone_${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) value`,vals)).rows[0].value;};
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(dir,'log'),'-o',"-h 127.0.0.1 -k '' -p 55509",'-w','start']);started=true;
  const admin=await connect();
  await admin.query(readFileSync(new URL('./sql/standalone-accounting-schema.sql',import.meta.url),'utf8'));
  for(const file of ['20261028193000_standalone_provider_attempt_ledger.sql','20261029153000_standalone_deleted_scope_history.sql','20261029170000_standalone_pricing_and_enrollment.sql','20261029190000_standalone_actor_authority.sql','20261029200000_standalone_uncertain_exposure_continuation.sql','20261029210000_standalone_qwen_infrastructure.sql','20261029224959_standalone_uncertainty_owner_limits.sql','20261031230000_standalone_chat_uncertainty_owner_binding.sql'])await admin.query(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  const one=await connect('service_role');
  const owner=randomUUID(),actor=randomUUID(),chat=randomUUID();
  await admin.query("insert into actors values($1,'standard','standard')",[actor]);
  await admin.query("insert into chats(id,actor_id,title) values($1,$2,'cost policy')",[chat,actor]);
  // Adult Katie has a verified chat owner binding but no self-tool execution grant.
  await rpc(one,'bind_scope',{p_owner:owner,p_actor:actor,p_chat:chat});
  const config=await rpc(one,'configure',{p_owner:owner,p_timezone:'America/Chicago',p_call:'500000',p_request:'2000000'});
  assert.equal((await admin.query('select count(*) from self_tool_owner_grants where owner_id=$1 and actor_id=$2',[owner,actor])).rows[0].count,'0','ordinary chat has no privileged self-tool grant');
  await rpc(one,'register_pricing',{p_version:'policy-fixture',p_metadata:{fixture:true}});
  const wf=request=>({p_owner:owner,p_actor:actor,p_chat:chat,p_request:request,p_hash:'a'.repeat(64),p_body:{message:'original request'}});
  const input=(request,key,cost)=>({p_owner:owner,p_actor:actor,p_chat:chat,p_request:request,p_key:key,p_hash:'b'.repeat(64),p_payload:{model:'fixture'},p_pricing:'policy-fixture',p_provider:'fixture',p_model:'fixture',p_reserved:String(cost),p_category:key,p_estimate:{status:'estimated',reservationMicrousd:String(cost),requestHash:'b'.repeat(64),pricingVersion:'policy-fixture',estimatorVersion:'fixture'},p_estimator:'fixture',p_reason:key});
  const dispatch=async(request,key,cost)=>{
   let a=await rpc(one,'admit',input(request,key,cost));
   if(a.state==='paused')a=await rpc(one,'approve',{p_owner:owner,p_attempt:a.id,p_hash:a.prepared_hash,p_pricing:a.pricing_version,p_revision:config.budget_revision,p_reserved:String(cost)});
   assert.ok(await rpc(one,'claim_dispatch',{p_owner:owner,p_attempt:a.id}));return a;
  };
  const mark=a=>rpc(one,'mark_uncertain',{p_owner:owner,p_attempt:a.id,p_reason:'Submission or usage unknown'});
  const accepted=a=>rpc(one,'uncertain_exposure_accepted',{p_owner:owner,p_attempt:a.id});
  const total=async request=>String(await rpc(admin,'request_committed',{p_owner:owner,p_request:request}));
  for(const [name,before,cost,auto] of [['qwen',310000,20000,true],['selector',0,6273,true],['under',0,490000,true],['exact-call',0,500000,true],['over-call',0,510000,false],['over-request',1750000,400000,false],['exact-request',1510000,490000,true]]){
   const request='case-'+name;let lease=await rpc(one,'claim_workflow',wf(request));
   if(before){const prior=await dispatch(request,'settled-support',before);await rpc(one,'settle',{p_owner:owner,p_attempt:prior.id,p_provider:'fixture',p_receipt:'receipt-'+name,p_actual:String(before),p_usage:{inputTokens:1},p_evidence:{kind:'provider_receipt'}});}
   const a=await dispatch(request,name,cost);await mark(a);
   assert.equal(await accepted(a),auto,name);assert.equal(await total(request),String(before+cost));
   assert.equal(await rpc(one,'claim_dispatch',{p_owner:owner,p_attempt:a.id}),null,'no retransmission');
   await mark(a);assert.equal(await accepted(a),auto,'repeat marking does not recreate authorization');
   const count=await admin.query('select count(*) from standalone_uncertain_exposure_authorizations where attempt_id=$1',[a.id]);assert.equal(count.rows[0].count,auto?'1':'0');
   if(auto){const rows=await admin.query('select grant_chat_id,grant_created_at from standalone_uncertain_exposure_authorizations where attempt_id=$1',[a.id]);assert.equal(rows.rows[0].grant_chat_id,null,'owner binding is sufficient');assert.equal(rows.rows[0].grant_created_at,null);}
   await rpc(one,'finish_workflow',{p_owner:owner,p_request:request,p_lease:lease.lease_token,p_status:'paused'});
   const resume=await rpc(one,'claim_workflow',{...wf(request),p_resume:true});
   assert.equal(Boolean(resume.claimed),auto);
   if(!auto){
    assert.equal(resume.blocked,'unresolved_provider_attempt');
    const args={p_owner:owner,p_attempt:a.id,p_revision:config.budget_revision,p_reserved:String(cost)};
    await rpc(one,'accept_uncertain_exposure',args);await rpc(one,'accept_uncertain_exposure',args);
    lease=await rpc(one,'claim_workflow',{...wf(request),p_resume:true});assert.equal(lease.claimed,true);
    assert.equal((await rpc(one,'claim_workflow',{...wf(request),p_resume:true})).claimed,false,'one workflow lease');
    assert.equal(await rpc(one,'claim_dispatch',{p_owner:owner,p_attempt:a.id}),null);
   }
   assert.equal(await total(request),String(before+cost),'acceptance never frees or doubles reservation');
  }
  await rpc(one,'claim_workflow',wf('direct-transition'));
  const direct=await dispatch('direct-transition','receipt-helper',20000);
  await admin.query("update standalone_provider_attempts set state='uncertain' where id=$1",[direct.id]);
  assert.equal(await accepted(direct),true,'receipt/identifier uncertainty uses the same policy');
  await admin.query("delete from standalone_attempt_events where attempt_id=$1 and kind='uncertain_exposure_auto_authorized'",[direct.id]);
  assert.equal(await accepted(direct),true,'legacy manual acceptance remains valid');
  assert.equal(await rpc(one,'auto_authorize_uncertain_exposure',{p_owner:owner,p_attempt:direct.id}),true);
  assert.equal((await admin.query("select count(*) from standalone_attempt_events where attempt_id=$1 and kind='uncertain_exposure_auto_authorized'",[direct.id])).rows[0].count,'1','small previously accepted exposure becomes informational too');
  const request='multiple-small';const lease=await rpc(one,'claim_workflow',wf(request));
  for(const [index,cost] of [6273,20000,30000].entries()){const a=await dispatch(request,'helper-'+index,cost);await mark(a);assert.equal(await accepted(a),true);}
  assert.equal(await total(request),'56273');
  assert.equal((await rpc(one,'finish_workflow',{p_owner:owner,p_request:request,p_lease:lease.lease_token,p_status:'completed'})).status,'completed');
  assert.equal((await rpc(one,'claim_workflow',{...wf(request),p_resume:true})).claimed,false,'completed request cannot restart');
  assert.equal((await rpc(one,'admit',input('ordinary','over-call',510000))).pause_reason,'per_call_threshold');
  // Normal cumulative admission remains unchanged, including pending reservations.
  await dispatch('normal-request','existing',1750000);
  assert.equal((await rpc(one,'admit',input('normal-request','extra',400000))).pause_reason,'request_threshold');
  // Deny cross-owner acceptance and immediately invalidate owner-binding
  // authorization on scope revocation, even after a successful auto-accept.
  const checkedRequest='scope-security';
  await rpc(one,'claim_workflow',wf(checkedRequest));
  const scoped=await dispatch(checkedRequest,'scope-proof',6539);
  await mark(scoped);
  assert.equal(await accepted(scoped),true);
  await assert.rejects(rpc(one,'accept_uncertain_exposure',{p_owner:randomUUID(),p_attempt:scoped.id,p_revision:config.budget_revision,p_reserved:'6539'}),/ACCEPTANCE_DENIED/);
  const unchanged=await admin.query('select state,reserved_microusd from standalone_provider_attempts where id=$1',[scoped.id]);
  assert.equal(unchanged.rows[0].state,'uncertain');
  assert.equal(unchanged.rows[0].reserved_microusd,'6539');
  await admin.query('update standalone_owner_bindings set revoked_at=now() where owner_id=$1 and actor_id=$2 and chat_id=$3',[owner,actor,chat]);
  assert.equal(await accepted(scoped),false,'revoked owner binding invalidates prior authorization');
  assert.equal(await total(checkedRequest),'6539','revocation does not free or duplicate exposure');
 }finally{
  await Promise.all(connections.map(c=>c.end().catch(()=>{})));
  if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
 }
});

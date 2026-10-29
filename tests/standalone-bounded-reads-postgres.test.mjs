import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

test('bounded usage scales with the day and active work, preserves accounting and uses indexes', {timeout:120000}, async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||['/usr/lib/postgresql/16/bin','/usr/lib/postgresql/17/bin','/tmp/katie-pg-bin'].find(p=>existsSync(join(p,'initdb')));
 assert.ok(bin,'PostgreSQL initdb/pg_ctl required (set KATIE_TEST_PG_BIN)');
 const dir=mkdtempSync(join(tmpdir(),'standalone-uncertain-pg-')),data=join(dir,'data');
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,(r.stderr||r.error?.message||'')+(existsSync(join(dir,'log'))?readFileSync(join(dir,'log'),'utf8'):''));};
 const connections=[];let started=false;
 const connect=async(role)=>{const c=new pg.Client({host:'127.0.0.1',port:55512,user:'postgres',database:'postgres'});await c.connect();connections.push(c);if(role)await c.query('set role '+role);return c;};
 const rpc=async(c,name,args)=>{const keys=Object.keys(args),vals=Object.values(args).map(v=>v&&typeof v==='object'?JSON.stringify(v):v);return (await c.query(`select standalone_${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) value`,vals)).rows[0].value;};
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(dir,'log'),'-o',"-h 127.0.0.1 -k '' -p 55512",'-w','start']);started=true;
  const admin=await connect();
  await admin.query(readFileSync(new URL('./sql/standalone-accounting-schema.sql',import.meta.url),'utf8'));
  for(const file of ['20261028193000_standalone_provider_attempt_ledger.sql','20261029153000_standalone_deleted_scope_history.sql','20261029170000_standalone_pricing_and_enrollment.sql','20261029190000_standalone_actor_authority.sql','20261029200000_standalone_uncertain_exposure_continuation.sql','20261029210000_standalone_qwen_infrastructure.sql','20261029224959_standalone_uncertainty_owner_limits.sql','20261029232424_standalone_bounded_usage_reads.sql'])await admin.query(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  const one=await connect('service_role');
  const owner=randomUUID(),actor=randomUUID(),chat=randomUUID();
  await admin.query("insert into actors values($1,'standard','standard')",[actor]);
  await admin.query("insert into chats(id,actor_id,title) values($1,$2,'bounded reads')",[chat,actor]);
  await admin.query('insert into self_tool_owner_grants(owner_id,actor_id,chat_id) values($1,$2,$3)',[owner,actor,chat]);
  await rpc(one,'bind_scope',{p_owner:owner,p_actor:actor,p_chat:chat});
  await rpc(one,'configure',{p_owner:owner,p_timezone:'America/Chicago',p_call:'500000',p_request:'2000000'});
  await rpc(one,'register_pricing',{p_version:'bounded-fixture',p_metadata:{fixture:true}});
  const clock=(await admin.query("select now() as instant,((now() at time zone 'America/Chicago')::date::timestamp at time zone 'America/Chicago') as lo")).rows[0];
  const base=`insert into standalone_provider_attempts(owner_id,actor_id,chat_id,request_id,attempt_key,prepared_hash,source_prepared_hash,base_attempt_key,prepared_payload,pricing_version,provider,model,category,preflight_estimate,estimator_version,reason,state,reserved_microusd,actual_microusd,provider_receipt_id,budget_revision,created_at,dispatched_at,usage)`;
  const seed=async(key,state,reserved,actual,at,provider='openai',usage=null)=>{
   return (await admin.query(base+` values($1,$2,$3,'test-request',$4,repeat('a',64),repeat('a',64),$4,'{"payload":{}}','bounded-fixture',$5,'fixture','helper','{}','fixture','fixture',$6,$7,$8,$9,1,$10,case when $6 in('settled','dispatched','uncertain','estimated') then $10::timestamptz else null end,$11) returning id`,[owner,actor,chat,key,provider,state,reserved,actual,actual===null?null:'receipt-'+key,at,usage])).rows[0].id;
  };
  const today=new Date(+new Date(clock.lo)+3600000).toISOString();
  await seed('settled','settled',500,100,today,'openai',{inputTokens:12,outputTokens:3,cachedInputTokens:4});
  await seed('reserved','reserved',200,null,today);
  await seed('uncertain','uncertain',300,null,today);
  await seed('infra','estimated',20000,null,today,'runpod');
  await seed('paused','paused',400,null,today);
  await seed('dispatched','dispatched',500,null,today);
  await seed('cancelled','cancelled',0,null,today);
  await seed('earlier','uncertain',700,null,new Date(+new Date(clock.lo)-1).toISOString());
  // A realistic historical ledger, with many more events than attempts.
  await admin.query(base+` select $1,$2,$3,'historical-'||i,'history-'||i,repeat('a',64),repeat('a',64),'history-'||i,jsonb_build_object('payload',repeat('x',1024)),'bounded-fixture','openai','fixture','historical','{}','fixture','historical','settled',10,10,'history-receipt-'||i,1,'2020-01-01'::timestamptz+i*interval '1 minute','2020-01-01'::timestamptz+i*interval '1 minute','{"inputTokens":1,"outputTokens":1}'::jsonb from generate_series(1,20000) i`,[owner,actor,chat]);
  await admin.query("insert into standalone_attempt_events(attempt_id,owner_id,kind,details) select a.id,a.owner_id,'history',jsonb_build_object('note',repeat('x',100)) from standalone_provider_attempts a cross join generate_series(1,5) i where a.owner_id=$1 and a.category='historical'",[owner]);
  await admin.query('analyze standalone_provider_attempts;analyze standalone_attempt_events');
  const usage=await rpc(one,'daily_usage',{p_owner:owner,p_actor:actor,p_now:clock.instant.toISOString()});
  assert.equal(usage.totals.estimatedCostMicrousd,'100');assert.equal(usage.totals.pendingExposureMicrousd,'600');assert.equal(usage.totals.uncertainExposureMicrousd,'800');assert.equal(usage.totals.estimatedInfrastructureMicrousd,'20000');
  assert.equal(usage.totals.inputTokens,12);assert.equal(usage.totals.outputTokens,3);assert.equal(usage.totals.attemptCount,7);assert.equal(usage.unresolvedEarlier.uncertainExposureMicrousd,'700');
  assert.equal(usage.attempts.length,7);assert.equal(usage.providers.length,2);assert.equal(usage.models.length,2);assert.equal(usage.totals.cachedInputTokens,4);assert.equal(usage.providers.find(p=>p.provider==='openai').estimatedCostMicrousd,'100');assert.equal(usage.providers.find(p=>p.provider==='runpod').estimatedInfrastructureMicrousd,'20000');
  const snapshot=()=>rpc(one,'usage_snapshot',{p_owner:owner,p_actor:actor,p_chat:chat,p_all:false});
  const first=await snapshot();assert.equal(first.attempts.length,5);assert.ok(first.attempts.every(a=>['paused','reserved','dispatched','uncertain'].includes(a.state)));assert.equal(first.events,undefined);
  const size=JSON.stringify(first).length;assert.ok(size<30000,'response excludes 20,000 payloads and 100,000 events');
  const recent=await rpc(one,'recent_activity',{p_owner:owner,p_actor:actor});assert.equal(recent.length,25);
  const cursor=recent.at(-1);const next=await rpc(one,'recent_activity',{p_owner:owner,p_actor:actor,p_before:cursor.created_at,p_before_id:cursor.id});assert.equal(next.length,25);assert.ok(next.every(a=>!recent.some(b=>b.id===a.id)));
  await assert.rejects(rpc(one,'snapshot',{p_owner:owner}),/permission denied/);
  const legacy=await rpc(admin,'snapshot',{p_owner:owner});assert.equal(legacy.attempts.length,25);assert.deepEqual(legacy.events,[]);
  const details=await rpc(one,'attempt_details',{p_owner:owner,p_attempt:recent[0].id});assert.equal(details.attempts.length,1);
  const dst=await rpc(one,'daily_usage',{p_owner:owner,p_actor:actor,p_now:'2026-03-08T18:00:00Z'});assert.equal((Date.parse(dst.end)-Date.parse(dst.start))/3600000,23);
  // EXPLAIN the exact range/active/event predicates used inside the read models.
  const plans=[];
  for(const [sql,args] of [
   ["select id from standalone_provider_attempts where owner_id=$1 and coalesce(dispatched_at,created_at)>=$2::timestamptz and coalesce(dispatched_at,created_at)<$2::timestamptz+interval '1 day'",[owner,clock.lo]],
   ["select id from standalone_provider_attempts where owner_id=$1 and actor_id=$2 and chat_id=$3 and state in('paused','reserved','dispatched','uncertain') order by created_at desc,id desc limit 100",[owner,actor,chat]],
   ["select 1 from standalone_attempt_events where attempt_id=$1 and kind='receipt_conflict'",[recent[0].id]]
  ]){const result=await admin.query('explain (analyze,buffers,format json) '+sql,args);plans.push(JSON.stringify(result.rows[0]['QUERY PLAN']));}
  assert.match(plans[0],/standalone_attempts_owner_day/);assert.match(plans[1],/standalone_attempts_active_scope/);assert.match(plans[2],/standalone_events_attempt_kind/);
  console.log('BOUNDED QUERY PLANS '+JSON.stringify(plans.map(p=>JSON.parse(p))));
  const health=await connect();
  const healthStarted=Date.now();
  await Promise.all([...(Array.from({length:5},()=>snapshot())),health.query('select count(*) from actors'),health.query('select count(*) from chats')]);
  assert.ok(Date.now()-healthStarted<5000,'ordinary reads remain responsive during bounded polling');
  await admin.query("insert into standalone_attempt_events(attempt_id,owner_id,kind,details) select a.id,a.owner_id,'more-history','{}' from standalone_provider_attempts a cross join generate_series(1,5) i where a.owner_id=$1 and a.category='historical'",[owner]);
  assert.equal(JSON.stringify(await snapshot()).length,size,'historical event growth cannot inflate routine response');
  const config=await rpc(one,'read_configuration',{p_owner:owner});assert.equal(config.timezone,'America/Chicago');assert.equal(config.per_call_limit_microusd,'500000');assert.equal(config.request_limit_microusd,'2000000');
 }finally{
  await Promise.all(connections.map(c=>c.end().catch(()=>{})));
  if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
 }
});

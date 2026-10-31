import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

test('Qwen recovery uses scoped service-only RPCs while direct ledger SELECT remains revoked',{timeout:120000},async()=>{
  const bin=process.env.KATIE_TEST_PG_BIN||['/usr/lib/postgresql/16/bin','/usr/lib/postgresql/17/bin','/tmp/katie-pg-bin'].find(p=>existsSync(join(p,'initdb')));
  assert.ok(bin,'Postgres bin required');
  const dir=mkdtempSync(join(tmpdir(),'qwen-cron-pg-')),data=join(dir,'data'),port=55593;
  const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,(r.stderr||r.error?.message||'')+(existsSync(join(dir,'log'))?readFileSync(join(dir,'log'),'utf8'):''));};
  const clients=[];let started=false;
  const connect=async(role)=>{const client=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});await client.connect();clients.push(client);if(role)await client.query('set role '+role);return client;};
  try{
    run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
    run('pg_ctl',['-D',data,'-l',join(dir,'log'),'-o',`-h 127.0.0.1 -k '' -p ${port}`,'-w','start']);started=true;
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
      '20261029232424_standalone_bounded_usage_reads.sql',
      '20261031190000_qwen_cron_bounded_read_rpcs.sql'
    ])await admin.query(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
    const service=await connect('service_role');
    const permissions=await admin.query(`select
      has_table_privilege('service_role','public.standalone_provider_attempts','SELECT') as attempts,
      has_table_privilege('service_role','public.standalone_workflows','SELECT') as workflows,
      has_function_privilege('service_role','public.standalone_recoverable_qwen_jobs()','EXECUTE') as service_exec,
      has_function_privilege('anon','public.standalone_recoverable_qwen_jobs()','EXECUTE') as anon_exec,
      has_function_privilege('authenticated','public.standalone_verified_cron_qwen_owner(uuid,uuid,text)','EXECUTE') as auth_exec`);
    assert.deepEqual(permissions.rows[0],{attempts:false,workflows:false,service_exec:true,anon_exec:false,auth_exec:false});
    const owner=randomUUID(),actor=randomUUID(),chat=randomUUID(),otherChat=randomUUID(),request='qwen-paused';
    await admin.query("insert into actors values($1,'standard','standard')",[actor]);
    await admin.query("insert into chats(id,actor_id,title) values($1,$2,'Recovery fixture'),($3,$2,'Wrong chat')",[chat,actor,otherChat]);
    await admin.query("insert into self_tool_owner_grants(owner_id,actor_id,chat_id) values($1,$2,$3)",[owner,actor,chat]);
    await service.query("select public.standalone_bind_scope($1,$2,$3)",[owner,actor,chat]);
    await admin.query("insert into standalone_pricing_versions(version,metadata) values('standalone-runpod-qwen-still-v2','{}')");
    await admin.query(`insert into standalone_workflows(owner_id,actor_id,chat_id,request_id,request_hash,request_body,status,error)
      values($1,$2,$3,$4,repeat('a',64),'{}','paused','standalone_runpod_in_progress')`,[owner,actor,chat,request]);
    await admin.query(`insert into standalone_provider_attempts(owner_id,actor_id,chat_id,request_id,attempt_key,prepared_hash,source_prepared_hash,base_attempt_key,prepared_payload,pricing_version,provider,model,category,preflight_estimate,estimator_version,reason,state,reserved_microusd,budget_revision,provider_request_id)
      values($1,$2,$3,$4,'qwen-fixture',repeat('a',64),repeat('a',64),'qwen-fixture','{}','standalone-runpod-qwen-still-v2','runpod','Qwen/Qwen3-VL-8B-Instruct','attachment-observation','{}','standalone-runpod-qwen-still-v2','fixture','dispatched',20000,1,'accepted-job-123')`,[owner,actor,chat,request]);
    const list=await service.query('select * from public.standalone_recoverable_qwen_jobs()');
    assert.equal(list.rows.length,1);
    assert.equal(list.rows[0].owner_id,owner);
    assert.equal(list.rows[0].provider_request_id,'accepted-job-123');
    const exact=await service.query('select public.standalone_verified_cron_qwen_owner($1,$2,$3) owner',[actor,chat,request]);
    assert.equal(exact.rows[0].owner,owner);
    const other=await service.query('select public.standalone_verified_cron_qwen_owner($1,$2,$3) owner',[actor,otherChat,request]);
    assert.equal(other.rows[0].owner,null);
    await admin.query("update standalone_workflows set status='failed' where owner_id=$1 and request_id=$2",[owner,request]);
    assert.equal((await service.query('select * from public.standalone_recoverable_qwen_jobs()')).rows.length,0);
    assert.equal((await service.query('select public.standalone_verified_cron_qwen_owner($1,$2,$3) owner',[actor,chat,request])).rows[0].owner,null);
  }finally{
    for(const client of clients)await client.end().catch(()=>{});
    if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
    rmSync(dir,{recursive:true,force:true});
  }
});

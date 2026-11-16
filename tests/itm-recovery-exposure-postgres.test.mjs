import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import pg from "pg";

// Independent SQL qualification in an isolated temporary PostgreSQL server.
// No network, no provider calls, and never connects to production Supabase.
test("native ITM recovery inspection is actor-bound and preserves prior paid provider history",{
  timeout:90000,
  skip:!process.env.KATIE_TEST_PG_BIN,
},async()=>{
  const bin=process.env.KATIE_TEST_PG_BIN;
  const root=mkdtempSync(join(tmpdir(),"katie-itm-gate-")),data=join(root,"data");
  let server=false,client;
  const run=(name,args)=>{
    const r=spawnSync(join(bin,name),args,{encoding:"utf8",timeout:30000});
    assert.equal(r.status,0,r.stderr||r.error?.message);
  };
  try{
    run("initdb",["-D",data,"-U","postgres","-A","trust","--no-locale","-E","UTF8"]);
    run("pg_ctl",["-D",data,"-l",join(root,"postgres.log"),"-o",`-h '' -k ${root} -p 55492`,"-w","start"]);
    server=true;
    client=new pg.Client({host:root,port:55492,user:"postgres",database:"postgres",connectionTimeoutMillis:5000});
    await client.connect();
    await client.query("create role service_role nologin; create role anon nologin; create role authenticated nologin");
    await client.query(`
      create table public.chats(id uuid primary key,actor_id uuid not null);
      create table public.standalone_provider_attempts(
        actor_id uuid not null,chat_id uuid not null,provider text not null,
        category text not null,state text not null,prepared_payload jsonb
      );
      create table public.intermediate_memory_batch_attempts(
        actor_id uuid not null,chat_id uuid not null,batch_end_message_id text not null,
        state text not null,claimed_at timestamptz not null,
        processor_version text, error_code text
      );
    `);
    const migration=readFileSync("supabase/migrations/20261115194500_itm_native_claude_recovery_exposure.sql","utf8");
    await client.query(migration);
    const actor=randomUUID(),chat=randomUUID(),other=randomUUID(),end=randomUUID();
    await client.query("insert into chats(id,actor_id) values($1,$2)",[chat,actor]);
    const inspect=async()=>(
      await client.query("select public.inspect_itm_batch_provider_exposure($1,$2,$3) flags",[actor,chat,end])
    ).rows[0].flags;
    const none={grok_sent:false,anthropic_sent:false,paused:false,in_flight:false,terminal:false};
    assert.deepEqual(await inspect(),none);
    const serializedBody=JSON.stringify({messages:[{role:"user",content:`Batch [${end}] quoted source`}]});
    await client.query(`
      insert into standalone_provider_attempts(actor_id,chat_id,provider,category,state,prepared_payload)
      values($1,$2,'grok','memory-summary','uncertain',jsonb_build_object('serializedBody',$3::text))
    `,[actor,chat,serializedBody]);
    assert.deepEqual(await inspect(),{...none,grok_sent:true});
    await client.query(`
      insert into standalone_provider_attempts(actor_id,chat_id,provider,category,state,prepared_payload)
      values($1,$2,'anthropic','memory-summary','paused',jsonb_build_object('serializedBody',$3::text))
    `,[actor,chat,serializedBody]);
    assert.deepEqual(await inspect(),{...none,grok_sent:true,paused:true});
    await client.query(`
      insert into intermediate_memory_batch_attempts(actor_id,chat_id,batch_end_message_id,state,claimed_at)
      values($1,$2,$3,'processing',now())
    `,[actor,chat,end]);
    assert.deepEqual(await inspect(),{...none,grok_sent:true,paused:true,in_flight:true});
    await client.query("update intermediate_memory_batch_attempts set claimed_at=now()-interval '11 minutes'");
    assert.deepEqual(await inspect(),{...none,grok_sent:true,paused:true});
    await client.query("update standalone_provider_attempts set state='settled' where provider='anthropic'");
    assert.deepEqual(await inspect(),{...none,grok_sent:true,anthropic_sent:true});
    await client.query(`
      update intermediate_memory_batch_attempts
      set state='blocked',processor_version='two-stage-30-messages-v12-claude-native-failclosed-recovery:grok',
          error_code='ITM_TERMINAL: standalone_unsupported_billing'
      where actor_id=$1 and chat_id=$2 and batch_end_message_id=$3
    `,[actor,chat,end]);
    assert.deepEqual(await inspect(),{...none,grok_sent:true,anthropic_sent:true,terminal:true});
    const otherBody=JSON.stringify({messages:[{role:"user",content:"Different batch [deadbeef]"}]});
    await client.query(`
      insert into standalone_provider_attempts(actor_id,chat_id,provider,category,state,prepared_payload)
      values($1,$2,'grok','memory-summary','uncertain',jsonb_build_object('serializedBody',$3::text))
    `,[actor,chat,otherBody]);
    assert.deepEqual(await inspect(),{...none,grok_sent:true,anthropic_sent:true,terminal:true});
    await assert.rejects(client.query(
      "select public.inspect_itm_batch_provider_exposure($1,$2,$3)",[other,chat,end]
    ),/Unrecognized actor\/chat/);
    const access=await client.query(`
      select has_function_privilege('anon',
        'public.inspect_itm_batch_provider_exposure(uuid,uuid,text)','EXECUTE') anon,
        has_function_privilege('service_role',
        'public.inspect_itm_batch_provider_exposure(uuid,uuid,text)','EXECUTE') service
    `);
    assert.deepEqual(access.rows[0],{anon:false,service:true});
    await client.query("set role service_role");
    assert.deepEqual(await inspect(),{...none,grok_sent:true,anthropic_sent:true,terminal:true});
    await client.query("reset role");
  }finally{
    if(client)await client.end().catch(()=>undefined);
    if(server)run("pg_ctl",["-D",data,"-m","immediate","-w","stop"]);
    rmSync(root,{recursive:true,force:true});
  }
});

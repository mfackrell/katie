import test, {mock} from 'node:test';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync, existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import pg from 'pg';

test('native preference migration denies browser roles and enforces durable scope references', {
  timeout: 90000,
}, async () => {
  const installed = existsSync('/usr/lib/postgresql') ? readdirSync('/usr/lib/postgresql').sort((a,b) => Number(b)-Number(a)) : [];
  const bin = process.env.KATIE_TEST_PG_BIN || installed.map(version=>join('/usr/lib/postgresql',version,'bin')).find(path=>existsSync(join(path,'initdb')));
  assert.ok(bin && existsSync(join(bin, 'initdb')), 'Install PostgreSQL or set KATIE_TEST_PG_BIN; this required regression must run.');
  const root = mkdtempSync(join(tmpdir(), 'katie-routing-preferences-'));
  const data = join(root, 'data'), log = join(root, 'postgres.log');
  let started = false, client;
  const run = (name, args) => {
    const result = spawnSync(join(bin, name), args, {encoding: 'utf8', timeout: 30000});
    assert.equal(result.status, 0, [result.stderr, result.error?.message,
      existsSync(log) ? readFileSync(log, 'utf8') : ''].filter(Boolean).join('\n'));
  };
  try {
    run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
    run('pg_ctl', ['-D', data, '-l', log, '-o', `-h '' -k ${root} -p 55496`, '-w', 'start']);
    started = true;
    client = new pg.Client({host: root, port: 55496, user: 'postgres', database: 'postgres', connectionTimeoutMillis: 5000});
    await client.connect();
    await client.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create table public.actors(id uuid primary key); create table public.chats(id uuid primary key);`);
    await client.query(readFileSync('supabase/migrations/20261117140000_routing_preferences.sql', 'utf8'));
    const owner = '11111111-1111-4111-8111-111111111111';
    const actor = '22222222-2222-4222-8222-222222222222';
    const chat = '33333333-3333-4333-8333-333333333333';
    await client.query('insert into auth.users values ($1)', [owner]);
    await client.query('insert into actors values ($1)', [actor]);
    await client.query('insert into chats values ($1)', [chat]);
    for (const role of ['anon', 'authenticated']) {
      await client.query(`set role ${role}`);
      for (const table of ['user_routing_preferences', 'conversation_routing_preferences']) {
        await assert.rejects(client.query(`select * from ${table}`), {code: '42501'});
        await assert.rejects(client.query(`delete from ${table}`), {code: '42501'});
        await assert.rejects(client.query(`update ${table} set mode='best_value'`), {code: '42501'});
      }
      await assert.rejects(client.query('insert into user_routing_preferences values ($1,$2)', [owner, 'best_answer']), {code: '42501'});
      await assert.rejects(client.query('insert into conversation_routing_preferences values ($1,$2,$3,$4)', [owner, actor, chat, 'best_answer']), {code: '42501'});
      await client.query('reset role');
    }
    await client.query('set role service_role');
    await client.query('insert into user_routing_preferences values ($1,$2)', [owner, 'best_answer']);
    await client.query('insert into conversation_routing_preferences values ($1,$2,$3,$4)', [owner, actor, chat, 'best_value']);
    await assert.rejects(client.query("update user_routing_preferences set mode='cheap'"), {code: '23514'});
    await client.query('update conversation_routing_preferences set mode=null');
    assert.equal((await client.query('select mode from conversation_routing_preferences')).rows[0].mode, null);
    await client.query('reset role');
    // Exercise the real private ledger schema and scope verifier, then the new
    // read-only resolver. No production connection string is accepted here.
    await client.query(`alter table actors add column actor_kind text default 'standard';
      alter table chats add column actor_id uuid references actors(id);
      create table managed_agents(actor_id uuid);`);
    await client.query('update chats set actor_id=$1 where id=$2',[actor,chat]);
    await client.query(readFileSync('supabase/migrations/20261028193000_standalone_provider_attempt_ledger.sql','utf8'));
    await client.query(readFileSync('supabase/migrations/20261117150000_routing_observations.sql','utf8'));
    await client.query('insert into standalone_owner_bindings(owner_id,actor_id,chat_id) values($1,$2,$3)',[owner,actor,chat]);
    const compiled = createRequire(new URL('../.test-dist/routing-postgres.cjs', import.meta.url));
    const {auditRoutingDelivery} = compiled('./lib/router/routing-delivery-audit');
    const {resolveRoutingEvidence} = compiled('./lib/router/observed-evidence');
    const {runWithStandaloneAccounting} = compiled('./lib/standalone-accounting/context');
    const {buildCandidateMetadata} = compiled('./lib/router/model-intent');
    const {OpenAiProvider} = compiled('./lib/providers/openai-provider');
    const admin = compiled('./lib/data/supabase/admin');
    const audit = {...auditRoutingDelivery({userMessage:'Rewrite this email', selectedIntent:'rewrite',
      answer:'Dear team, here is the revised plan.', imageCount:0}),
      classifiedIntent:'rewrite',provider:'openai',model:'gpt-4o-mini'};
    assert.equal(audit.status,'unverified','actual successful written-delivery audit cannot certify quality');
    for (const [request,intent,age] of [['relevant','rewrite','1 day'],['other-task','code-generation','1 day'],['stale','rewrite','40 days']]) {
      await client.query(`insert into standalone_workflows(owner_id,actor_id,chat_id,request_id,request_hash,request_body,status,checkpoints,updated_at)
        values($1,$2,$3,$4,repeat('a',64),'{}','completed',$5,now()-$6::interval)`,
        [owner,actor,chat,request,JSON.stringify({'routing-delivery-audit:v1':{...audit,classifiedIntent:intent}}),age]);
    }
    const rpc = 'select standalone_routing_observations($1,$2,$3,$4,$5) as evidence';
    const args = [owner,actor,chat,'current','rewrite'];
    for (const role of ['anon','authenticated']) {
      await client.query(`set role ${role}`);
      await assert.rejects(client.query(rpc,args),{code:'42501'});
      await client.query('reset role');
    }
    await client.query('set role service_role');
    const observed = (await client.query(rpc,args)).rows[0].evidence;
    assert.deepEqual(observed.observations.map(row=>row.request_id),['relevant']);
    assert.equal(observed.observations[0].output_tokens,null,'no receipts means unknown usage');
    assert.equal(observed.observations[0].overhead_micro_usd,null,'no helper receipts means unknown overhead');
    assert.equal(observed.overhead_micro_usd,null,'no current receipts means unknown overhead');
    await client.query('reset role');
    await client.query("insert into standalone_pricing_versions(version,metadata) values('test','{}')");
    const receipt = async (request, key, category, usage, cost) => client.query(`
      insert into standalone_provider_attempts(owner_id,actor_id,chat_id,request_id,attempt_key,
       prepared_hash,prepared_payload,source_prepared_hash,base_attempt_key,pricing_version,provider,model,
       category,preflight_estimate,estimator_version,reason,state,reserved_microusd,actual_microusd,
       budget_revision,usage,provider_receipt_id)
      values($1,$2,$3,$4,$5,repeat('a',64),'{}',repeat('a',64),$5,'test','openai','gpt-4o-mini',
       $6,'{}','test','test','settled',$8,$8,1,$7,$4||$5)`,
      [owner,actor,chat,request,key,category,usage,cost]);
    await receipt('relevant','chat:0','chat',{outputTokens:80,cachedInputTokens:12},'40');
    await receipt('relevant','chat:1','chat',{outputTokens:120,cachedInputTokens:8},'50');
    await receipt('relevant','helper:0','routing',{outputTokens:5,cachedInputTokens:0},'23');
    await receipt('current','helper:0','routing',{outputTokens:5,cachedInputTokens:0},'17');
    await client.query('set role service_role');
    const database = mock.method(admin,'getSupabaseAdminClient',() => ({rpc: async (name, input) => {
      assert.equal(name,'standalone_routing_observations');
      return {data:(await client.query(rpc,[input.p_owner,input.p_actor,input.p_chat,input.p_request,input.p_intent])).rows[0].evidence,error:null};
    }}));
    try {
      const result = await runWithStandaloneAccounting({userId:owner,actorId:actor,chatId:chat,requestId:'current'},
        () => resolveRoutingEvidence([buildCandidateMetadata('openai','gpt-4o-mini','rewrite')],
          [new OpenAiProvider('test-only')],{name:'Katie',persona:'Actor voice',summary:'',history:[],user:'Rewrite my next email'},'rewrite'));
      const candidate = result.candidates['openai:gpt-4o-mini'];
      assert.deepEqual(candidate.quality,{status:'unknown',observations:[]});
      assert.equal(candidate.economics.expected_output_tokens,100);
      assert.equal(candidate.economics.expected_cache_hit_tokens,10);
      assert.equal(candidate.economics.expected_attempts,2);
      assert.deepEqual(candidate.economics.provenance,['relevant']);
      assert.equal(candidate.economics.expected_total_control_plane_micro_usd,'23');
      assert.match(candidate.economics.expected_all_in_micro_usd,/^[0-9]+$/);
    } finally {database.mock.restore();}
    await assert.rejects(client.query(rpc,[owner,'44444444-4444-4444-8444-444444444444',chat,'current','rewrite']),/STANDALONE_SCOPE_DENIED/);
    await assert.rejects(client.query(rpc,['44444444-4444-4444-8444-444444444444',actor,chat,'current','rewrite']),/STANDALONE_SCOPE_DENIED/);
    await client.query('reset role');
    // Remove private ledger references before checking preference FK cascades.
    await client.query('delete from standalone_attempt_events');
    await client.query('delete from standalone_provider_attempts');
    await client.query('delete from standalone_workflows');
    await client.query('delete from standalone_owner_bindings');
    await client.query('delete from chats where id=$1', [chat]);
    assert.equal((await client.query('select * from conversation_routing_preferences')).rowCount, 0);
    assert.equal((await client.query('select * from user_routing_preferences')).rowCount, 1);
    const rls = await client.query("select relrowsecurity from pg_class where relname in ('user_routing_preferences','conversation_routing_preferences')");
    assert.ok(rls.rows.length === 2 && rls.rows.every(row => row.relrowsecurity));
  } finally {
    await client?.end();
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(root, {recursive: true, force: true});
  }
});

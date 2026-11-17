import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import pg from 'pg';

test('native preference migration denies browser roles and enforces durable scope references', {
  timeout: 90000, skip: !process.env.KATIE_TEST_PG_BIN,
}, async () => {
  const bin = process.env.KATIE_TEST_PG_BIN;
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

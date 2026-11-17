import test, { mock } from 'node:test';
import * as workflow from '../lib/standalone-accounting/workflow';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET, PATCH } from '../app/api/routing-preferences/route';
import { resolveChatRoutingMode, resolveRoutingPreferences } from '../lib/routing-preferences/server';
import { readFileSync } from 'node:fs';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const chatId = '44444444-4444-4444-8444-444444444444';
const chat2 = '55555555-5555-4555-8555-555555555555';
type Row = Record<string, unknown>;
const rows: Record<string, Row[]> = {};
let writes = 0;
let denyScope = false;
let databaseFailure = false;
class Query {
  filters: Row = {};
  constructor(readonly table: string) {}
  select() { return this; }
  eq(key: string, value: unknown) { this.filters[key] = value; return this; }
  async maybeSingle() {
    return {data: (rows[this.table] ?? []).find(row => Object.entries(this.filters).every(([key, value]) => row[key] === value)) ?? null, error: databaseFailure ? {message: 'offline'} : null};
  }
  async upsert(row: Row) {
    writes++;
    const table = rows[this.table] ??= [];
    const existing = table.find(item => item.owner_id === row.owner_id && item.chat_id === row.chat_id && item.actor_id === row.actor_id);
    if (existing) Object.assign(existing, row); else table.push({...row});
    return {data: null, error: null};
  }
}
const db = {from: (table: string) => new Query(table), async rpc(name: string, args: Row) {
  assert.equal(name, 'standalone_authorize_scope');
  return {data: !denyScope && args.p_owner === owner && args.p_actor === actorId && [chatId, chat2].includes(args.p_chat as string), error: null};
}};
function request(method = 'GET', body?: unknown, token = 'owner', scope = {actorId, chatId}) {
  return new NextRequest(`http://localhost/api/routing-preferences?${new URLSearchParams(scope)}`, {
    method, headers: token ? {authorization: `Bearer ${token}`, 'content-type': 'application/json'} : {},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
}
async function save(target: string, mode: unknown, chat = chatId) {
  const response = await PATCH(request('PATCH', {actorId, chatId: chat, target, mode}));
  assert.equal(response.status, 200);
  return response.json();
}
test('routing preference API and resolver preserve persistence and isolate scopes', async t => {
  const originalFetch = globalThis.fetch;
  const originalDb = globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__;
  const originalEnv = {...process.env};
  globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__ = db as unknown as NonNullable<typeof originalDb>;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://auth.example.test';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-test';
  delete process.env.KATIE_OWNER_AUTH_USER_ID;
  globalThis.fetch = async (_input, init) => {
    const token = new Headers(init?.headers).get('authorization');
    return Response.json({id: token === 'Bearer other' ? other : owner, is_anonymous: token === 'Bearer anonymous'});
  };
  try {
    await t.test('missing rows default to Best Value without writes', async () => {
      const result = await GET(request());
      assert.equal(result.status, 200);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await result.json(), {global: 'best_value', conversation: null, effective: 'best_value'});
      assert.equal(writes, 0);
    });
    await t.test('global change survives a fresh request and resolver invocation', async () => {
      await save('global', 'best_answer');
      assert.equal((await resolveRoutingPreferences(request(), {actorId, chatId})).effective, 'best_answer');
      assert.equal((await (await GET(request())).json()).global, 'best_answer');
    });
    await t.test('conversation switch and clear are independent from another conversation', async () => {
      await save('conversation', 'best_value');
      assert.equal((await resolveRoutingPreferences(request(), {actorId, chatId})).effective, 'best_value');
      assert.equal((await resolveRoutingPreferences(request(), {actorId, chatId: chat2})).effective, 'best_answer');
      await save('global', 'best_value');
      await save('conversation', 'best_answer');
      assert.equal((await save('conversation', null)).effective, 'best_value');
    });
    await t.test('concurrent writes to different scopes survive reload without lost global fields', async () => {
      await Promise.all([save('global', 'best_answer'), save('conversation', 'best_value', chat2)]);
      assert.deepEqual(await resolveRoutingPreferences(request(), {actorId, chatId: chat2}), {global: 'best_answer', conversation: 'best_value', effective: 'best_value'});
      await Promise.all([save('conversation', 'best_answer'), save('conversation', 'best_value')]);
      assert.equal((await resolveRoutingPreferences(request(), {actorId, chatId})).effective, 'best_value');
    });
    await t.test('invalid modes, spoofed IDs, null global, unknown scope and malformed JSON fail without writes', async () => {
      const before = writes;
      for (const extra of [{mode: 'cheap'}, {mode: null}, {ownerId: other}, {actorId: 'bad'}, {target: 'all'}]) {
        assert.equal((await PATCH(request('PATCH', {actorId, chatId, target: 'global', mode: 'best_answer', ...extra}))).status, 400);
      }
      assert.equal((await PATCH(new NextRequest('http://localhost/api/routing-preferences', {method: 'PATCH', body: '{'}))).status, 400);
      assert.equal(writes, before);
    });
    await t.test('unauthenticated, anonymous, other user and other actor are denied on reads and writes', async () => {
      const before = writes;
      for (const token of ['', 'anonymous', 'other']) {
        assert.equal((await GET(request('GET', undefined, token))).status, 403);
        assert.equal((await PATCH(request('PATCH', {actorId, chatId, target: 'global', mode: 'best_answer'}, token))).status, 403);
      }
      assert.equal((await GET(request('GET', undefined, 'owner', {actorId: other, chatId}))).status, 403);
      denyScope = true;
      assert.equal((await PATCH(request('PATCH', {actorId, chatId, target: 'conversation', mode: null}))).status, 403);
      denyScope = false;
      assert.equal(writes, before);
    });
    await t.test('database read failure is explicit, never an invented default', async () => {
      databaseFailure = true;
      assert.equal((await GET(request())).status, 503);
      databaseFailure = false;
    });
    await t.test('chat uses only admitted owner and scope, ignores forged UI hints, and skips reads for manual models', async () => {
      const admitted = mock.method(workflow, 'currentStandaloneWorkflow', () => ({workflow: {
        owner_id: owner, actor_id: actorId, chat_id: chatId,
      }} as ReturnType<typeof workflow.currentStandaloneWorkflow>));
      try {
        await save('global', 'best_answer');
        await save('conversation', 'best_value');
        const forged = {actorId, chatId, routing_mode: 'best_answer'};
        assert.equal(await resolveChatRoutingMode(forged, false), 'best_value');
        await save('conversation', null);
        assert.equal(await resolveChatRoutingMode({actorId, chatId}, false), 'best_answer');
        await assert.rejects(resolveChatRoutingMode({actorId: other, chatId}, false));
        await assert.rejects(resolveChatRoutingMode({actorId, chatId: chat2}, false));
        databaseFailure = true;
        assert.equal(await resolveChatRoutingMode({actorId, chatId}, true), 'best_value');
        await assert.rejects(resolveChatRoutingMode({actorId, chatId}, false), /unavailable/);
        databaseFailure = false;
        admitted.mock.mockImplementation(() => ({workflow: {owner_id: other, actor_id: actorId, chat_id: chatId}} as ReturnType<typeof workflow.currentStandaloneWorkflow>));
        assert.equal(await resolveChatRoutingMode({actorId, chatId}, false), 'best_value', 'guest defaults without sign-in or owner preference leakage');
        admitted.mock.mockImplementation(() => undefined);
        await assert.rejects(resolveChatRoutingMode({actorId, chatId}, false));
        const chatSource = readFileSync('app/api/chat/route.ts', 'utf8');
        assert.doesNotMatch(chatSource, /routing_mode: payload.routing_mode/);
        assert.equal((chatSource.match(/routing_mode: routingMode/g) ?? []).length, 3);
      } finally {databaseFailure = false; admitted.mock.restore();}
    });
    await t.test('migration denies direct browser access and leaves existing tables untouched', () => {
      const sql = readFileSync('supabase/migrations/20261117140000_routing_preferences.sql', 'utf8');
      for (const table of ['user_routing_preferences', 'conversation_routing_preferences']) assert.match(sql, new RegExp(`alter table public.${table} enable row level security`));
      assert.match(sql, /from public, anon, authenticated/);
      assert.match(sql, /to service_role/);
      assert.doesNotMatch(sql, /alter table public\.(actors|chats)|create policy/i);
    });
    await t.test('chat retains manual override payload and sends mode only for automatic selection', () => {
      const source = readFileSync('components/chat-panel.tsx', 'utf8');
      assert.match(source, /routingPreferences.value && !selectedOverride \? \{ routing_mode: routingPreferences.value.effective \}/);
      assert.match(source, /overrideProvider: selectedOverride\?\.providerName/);
      assert.match(source, /overrideModel: selectedOverride\?\.modelId/);
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__ = originalDb;
    process.env = originalEnv;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/**
 * Non-network structural admission gates for issue #688.
 * These tests intentionally do not claim live acceptance.
 * Full completion requires authenticated production tool receipts.
 */
const route=readFileSync('app/api/chat/route.ts','utf8');
const source=readFileSync('lib/tools/self-inspection.ts','utf8');
const authorization=readFileSync('lib/tools/authorization.ts','utf8');
const loop=readFileSync('lib/tools/loop.ts','utf8');

test('standalone model tools require explicit owner session and bound grant, never display name alone',()=>{
 assert.match(authorization,/KATIE_SELF_ACTOR_ID/);
 assert.match(authorization,/auth\/v1\/user/);
 assert.match(authorization,/self_tool_owner_grants/);
 assert.match(authorization,/\.eq\('actor_id', actorId\)\.eq\('chat_id', chatId\)/);
 assert.match(route,/authorizeSelfToolCaller\(request, actorId, chatId\)/);
 assert.match(route,/actorId === process\.env\.KATIE_SELF_ACTOR_ID/);
 assert.doesNotMatch(route,/selfToolsEnabled = selfToolActor\?\.data\?\.name/);
});

test('tool-enabled conversation retains router-selected provider and auditable results',()=>{
 assert.match(route,/runSelfInspection\(/);
 assert.match(source,/runModelTools\(/);
 assert.match(loop,/authorize/);
 assert.match(source,/self_tool_receipts/);
 assert.match(source,/github_read_file/);
 assert.match(source,/vercel_production/);
});

test('model-accessible change reporting must not pretend to mutate production',()=>{
 assert.match(source,/name: 'change_capability'/);
 assert.match(source,/No deployment is authorized by inspection/);
 assert.match(source,/Repository writes require the existing source-bound/);
});

test('source evidence and deployment acceptance must remain distinct',()=>{
 assert.match(source,/repository HEAD, not verified production SHA/i);
 assert.match(source,/katie-mu\.vercel\.app/);
});

test('owner grants migration provisions composite FK eligibility before use',()=>{
 const sql=readFileSync('supabase/migrations/20261023130000_self_tool_owner_grants.sql','utf8');
 assert.match(sql,/create unique index if not exists chats_id_actor_id_unique_for_self_tool_grants on public\.chats\(id, actor_id\)/i);
 assert.match(sql,/foreign key \(chat_id, actor_id\) references public\.chats\(id, actor_id\)/i);
 assert.match(sql,/enable row level security/i);
 assert.match(sql,/revoke all on public\.self_tool_owner_grants from public, anon, authenticated/i);
});

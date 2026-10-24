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

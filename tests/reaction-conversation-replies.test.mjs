import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const panel=fs.readFileSync('components/chat-panel.tsx','utf8');
const reactions=fs.readFileSync('components/message-reactions.tsx','utf8');
const route=fs.readFileSync('app/api/message-reactions/route.ts','utf8');
const worker=fs.readFileSync('lib/chat/reaction-reply-worker.ts','utf8');
const migration=fs.readFileSync('supabase/migrations/20261023205000_reaction_reply_jobs.sql','utf8');
test('saved reaction creates durable obligation and server owns generation',()=>{
 assert.match(migration,/create table if not exists public.reaction_reply_jobs/);
 assert.match(migration,/create trigger reaction_reply_enqueue after insert on public.actor_reaction_events/);
 assert.match(migration,/for update skip locked/);
 assert.match(route,/processReactionReply\(job.id,req.nextUrl.origin\)/);
 assert.match(worker,/POST as executeNormalChat/);
 assert.match(worker,/x-request-id/);
 assert.match(worker,/await response.text\(\)/);
 assert.match(worker,/getChatRequest\(job.request_id\)/);
});
test('browser only refreshes persisted replies, never owns generation',()=>{
 assert.match(panel,/katie:reaction-reply-queued/);
 assert.match(panel,/api\/messages\?chatId/);
 assert.doesNotMatch(panel,/void onSubmit\(\{ preventDefault\(\) \{\} \} as FormEvent, reactionTurn\)/);
 assert.match(reactions,/onReaction\(next\)/);
});

test('reaction replies use verified job-scoped internal owner without weakening ordinary chat',()=>{
 const authorization=fs.readFileSync('lib/chat/reaction-internal-authorization.ts','utf8');
 const workflow=fs.readFileSync('lib/standalone-accounting/workflow.ts','utf8');
 const migration=fs.readFileSync('supabase/migrations/20261031174500_reaction_reply_internal_owner.sql','utf8');
 assert.match(worker,/runWithVerifiedReactionReply\(job,\(\)=>executeNormalChat\(request\)\)/);
 assert.match(authorization,/standalone_reaction_reply_owner/);
 assert.match(authorization,/scope\.run\(Object\.freeze/);
 assert.match(authorization,/current\.actorId !== actorId \|\| current\.chatId !== chatId/);
 assert.match(workflow,/verifiedReactionOwner\(actorId,chatId,requestId,resumed\)/);
 assert.match(workflow,/authorizeStandaloneCaller\(request,actorId,chatId\)/);
 assert.match(migration,/j\.status='processing' and j\.lease_until>now\(\)/);
 assert.match(migration,/standalone_verify_scope\(b\.owner_id,j\.actor_id,j\.chat_id\)/);
 assert.match(migration,/revoke all on function public\.standalone_reaction_reply_owner/);
});

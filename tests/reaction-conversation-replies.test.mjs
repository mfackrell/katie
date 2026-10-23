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

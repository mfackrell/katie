import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const panel=fs.readFileSync('components/chat-panel.tsx','utf8');
const reactions=fs.readFileSync('components/message-reactions.tsx','utf8');
const route=fs.readFileSync('app/api/message-reactions/route.ts','utf8');
const worker=fs.readFileSync('lib/chat/reaction-reply-worker.ts','utf8');
const migration=fs.readFileSync('supabase/migrations/20261023205000_reaction_reply_jobs.sql','utf8');
const verifiedOwner=fs.readFileSync('supabase/migrations/20261103185000_verified_reaction_reply_owner.sql','utf8');
const workflow=fs.readFileSync('lib/standalone-accounting/workflow.ts','utf8');
const chat=fs.readFileSync('app/api/chat/route.ts','utf8');
test('saved reaction creates durable obligation and server owns generation',()=>{
 assert.match(migration,/create table if not exists public.reaction_reply_jobs/);
 assert.match(migration,/create trigger reaction_reply_enqueue after insert on public.actor_reaction_events/);
 assert.match(migration,/for update skip locked/);
 assert.match(route,/processReactionReply\(job.id,req.nextUrl.origin\)/);
 assert.match(worker,/executeVerifiedReactionReplyChat/);
 assert.match(worker,/executeVerifiedReactionReplyChat\(request,job.id\)/);
 assert.doesNotMatch(worker,/POST as executeNormalChat/);
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

test('reaction internal chat path is server-only and preserves metered workflow',()=>{
 assert.match(chat,/export async function executeVerifiedReactionReplyChat/);
 assert.match(chat,/executeVerifiedReactionReplyWorkflow\(request,payload,executeChat,jobId\)/);
 assert.match(chat,/role\.actor_kind==="executive"/);
 assert.match(workflow,/standalone_verified_reaction_reply_owner/);
 assert.match(workflow,/executeScopedStandaloneWorkflow\(request,payload,execute,ownerId\)/);
 assert.match(workflow,/runWithStandaloneAccounting/);
 assert.match(workflow,/standalone_claim_workflow|\x60claim_workflow\x60/);
 assert.match(workflow,/verifiedReactionOwner\s*\? verifiedReactionOwner/);
 assert.doesNotMatch(worker,/headers:\s*\{[^}]*authorization:/);
});
test('internal authorization requires leased persisted reaction and unique active owner scope',()=>{
 assert.match(verifiedOwner,/j\.status='processing'/);
 assert.match(verifiedOwner,/j\.lease_until > now\(\)/);
 assert.match(verifiedOwner,/j\.request_id=p_request/);
 assert.match(verifiedOwner,/j\.actor_id=p_actor and j\.chat_id=p_chat/);
 assert.match(verifiedOwner,/m\.role='assistant'/);
 assert.match(verifiedOwner,/b\.revoked_at is null/);
 assert.match(verifiedOwner,/v_count <> 1/);
 assert.match(verifiedOwner,/revoke all on function public\.standalone_verified_reaction_reply_owner/);
 assert.match(verifiedOwner,/grant execute on function public\.standalone_verified_reaction_reply_owner[\s\S]+to service_role/);
 assert.doesNotMatch(verifiedOwner,/to anon|to authenticated/);
});

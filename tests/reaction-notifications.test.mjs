import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const migration = fs.readFileSync('supabase/migrations/20261023194500_actor_reaction_events.sql','utf8');
const context = fs.readFileSync('lib/memory/assemble-context.ts','utf8');
const actor = fs.readFileSync('lib/chat/message-reactions.ts','utf8');
const ui = fs.readFileSync('components/message-reactions.tsx','utf8');
test('feedback events are atomic, actor addressed and include changes/removals',()=>{
 assert.match(migration,/after insert or update or delete on public.message_reactions/);
 assert.match(migration,/values \(OLD.actor_id,OLD.chat_id,OLD.message_id,null,'removed'\)/);
 assert.match(migration,/values \(NEW.actor_id,NEW.chat_id,NEW.message_id,NEW.reaction,'added'\)/);
 assert.match(migration,/OLD.reaction is distinct from NEW.reaction/);
 assert.match(migration,/enable row level security/);
});
test('actor only loads its own notifications with original reply context',()=>{
 assert.match(actor,/\.eq\("actor_id", actorId\)/);
 assert.match(actor,/\.eq\("actor_id",actorId\)\.eq\("role","assistant"\)/);
 assert.match(actor,/reaction removed; do not continue treating it as an endorsement/);
 assert.match(context,/recentActorReactionEvents\(actorId, chatId\)/);
});
test('UI confirms server acknowledged delivery but not independent model execution',()=>{
 assert.match(ui,/Reaction delivered to Katie’s feedback inbox/);
 assert.doesNotMatch(ui,/Katie has processed your feedback/);
});
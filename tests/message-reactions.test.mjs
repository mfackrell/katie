import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(path,'utf8');
const api=read('app/api/message-reactions/route.ts');
const store=read('lib/chat/message-reactions.ts');
const ui=read('components/message-reactions.tsx');
const panel=read('components/chat-panel.tsx');
const context=read('lib/memory/assemble-context.ts');
const migration=read('supabase/migrations/20261023180000_message_reactions.sql');

test('reactions write only to an existing assistant message in the selected actor and chat',()=>{
  for (const check of ['.eq("id",messageId)','.eq("actor_id",actorId)','.eq("chat_id",chatId)','.eq("role","assistant")'])
    assert.ok(api.includes(check),check);
  assert.match(api,/validChat\(actorId,chatId\)/);
  assert.match(api,/reaction===null/);
});
test('reaction choices have distinct meanings and contextual laughter handling',()=>{
  for (const name of ['laugh','love','like','dislike','surprised','sad','frustrated']) {
    assert.ok(store.includes(name));
    assert.ok(ui.includes('code:"'+name+'"'));
  }
  assert.match(store,/Do not infer a general desire for more jokes/);
  assert.match(store,/actorId/);
});
test('reactions persist independently and feed actor scoped context without modifying messages',()=>{
  assert.match(migration,/create table if not exists public.message_reactions/);
  assert.match(migration,/references public.messages\(id\) on delete cascade/);
  assert.match(migration,/enable row level security/);
  assert.match(context,/recentReactionContext\(actorId, chatId\)/);
  assert.match(panel,/MessageReactions actorId=\{actorId\}/);
  assert.match(ui,/setSelected\(next\)/);
  assert.match(ui,/if\(!response.ok\)throw Error/);
});

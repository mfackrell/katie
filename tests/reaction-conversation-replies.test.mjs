import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const panel=fs.readFileSync('components/chat-panel.tsx','utf8');
const reactions=fs.readFileSync('components/message-reactions.tsx','utf8');

test('reactions invoke existing full chat route, not a standalone hardcoded provider',()=>{
  assert.match(panel,/async function onSubmit\(event: FormEvent, reactionContent\?: string\)/);
  assert.match(panel,/const content = reactionContent \?\? input\.trim\(\)/);
  assert.match(panel,/void onSubmit\(\{ preventDefault\(\) \{\} \} as FormEvent, reactionTurn\)/);
  assert.match(panel,/await fetch\("\/api\/chat"/);
  assert.match(panel,/message\.content;/);
});
test('reaction saves before generation and preserves draft/attachments',()=>{
  assert.ok(reactions.indexOf('if(!response.ok)throw Error') < reactions.indexOf('onReaction(next)'));
  assert.match(panel,/if \(!reactionContent\) \{\s*setInput\(""/);
  assert.match(panel,/reactionContent \? \[\] : \[\.\.\.selectedImages\]/);
  assert.match(panel,/disabled=\{loading \|\| Boolean\(managedAgentId\)\}/);
});

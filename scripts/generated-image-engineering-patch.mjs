import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

// Temporary transport utility, removed before the implementation PR. No network,
// secrets, arbitrary eval, provider dispatch or production data are accessed.
const allowed = [
  'app/api/chat/route.ts','components/chat-panel.tsx','lib/chat/attachment-continuity.ts',
  'lib/types/chat.ts','lib/uploads/stored-uploads.ts','tests/chat-clarification-routing.test.mjs',
  'tests/media-memory-route.test.mjs','tests/pdf-saved-comparison.test.mjs',
  'tests/pdf-source-scope.test.mjs','tests/video-timeline-review.test.mjs',
];
const newBlobs = {
  'lib/images/generated-source.ts':'a3d6ce429ad606a45c216ae0cafa7b6d4b6a8e10',
  'lib/uploads/generated-image-store.ts':'f0969ac2032cd7b9c84d44c8641927ba757355b9',
  'lib/uploads/generated-image-service.ts':'b0ea5e213aabe259a0b7f9bca798dc3c890824a6',
  'lib/chat/image-source-followup.ts':'6acb96feaa098f3777317d015d0617ae44a73349',
  'lib/uploads/generated-image-observation.ts':'35abca6316789520d31db1c51573e958fcbdba90',
  'tests/generated-image-perception.test.ts':'6f68f316a352ef05bab3ab741d309bc3355bd84a',
};
const digest = text => createHash('sha256').update(text).digest('hex');
for (const [path,sha] of Object.entries(newBlobs)) {
  const bytes=readFileSync(path);
  const blob=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(blob,sha,`New source differs from tested local tree: ${path}`);
}
const plan=JSON.parse(readFileSync('scripts/generated-image-splices.json','utf8'));
assert.deepEqual(plan.map(p=>p.path),allowed);
const outputs=[];
for(const p of plan){
  const before=readFileSync(p.path,'utf8');
  if(digest(before)===p.after){outputs.push([p.path,before]);continue;}
  assert.equal(digest(before),p.before,`Source head changed: ${p.path}`);
  const lines=before.match(/[^\n]*\n|[^\n]+$/g)??[];
  let last=Infinity;
  for(const change of [...p.changes].reverse()){
    assert.ok(Number.isSafeInteger(change.line)&&change.line>=0&&change.line<=lines.length&&change.line<last);
    assert.ok(Number.isSafeInteger(change.remove)&&change.remove>=0);
    assert.equal(typeof change.text,'string');
    lines.splice(change.line,change.remove,...(change.text.match(/[^\n]*\n|[^\n]+$/g)??[]));
    last=change.line;
  }
  const after=lines.join('');
  assert.equal(digest(after),p.after,`Patched bytes differ from tested local tree: ${p.path}`);
  outputs.push([p.path,after]);
}
// Only write after ALL source and patch identity checks have passed.
for(const [path,text] of outputs)writeFileSync(path,text);
writeFileSync('/tmp/generated-image-paths.txt',allowed.join('\n')+'\n');
console.log('All 16 implementation/test files match the locally qualified source tree.');

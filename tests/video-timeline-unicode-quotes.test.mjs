import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync('lib/video-timeline/intent.ts','utf8'), {
  compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText, {exports,require:()=>({})});
const {timelineIntent,resolveTimelineSource} = exports;
const file = {id:'video',chatId:'source',fileName:'same.mp4',mimeType:'video/mp4'};

function firstQuery(request) {
  const selected = resolveTimelineSource(request,[],[file],[]).source;
  assert.equal(selected?.id,file.id);
  const result = timelineIntent(request,selected.fileName);
  assert.equal(result.kind,'first');
  assert.doesNotMatch(result.query,/same|mp4/i);
  return result;
}

test('review regression preserves curly-quoted event terms after the resolved filename',()=>{
  for (const [open,close] of [['“','”'],['‘','’'],['«','»'],['「','」'],['『','』']]) {
    for (const filename of ['same.mp4','"same.mp4"']) {
      const quoted = `${open}please${close}`;
      const result = firstQuery(`When did the error first appear in ${filename}—${quoted}?`);
      assert.equal(result.query,`error ${quoted}`);
    }
  }
});

test('every Unicode quotation mark survives both filename cleanup and courtesy cleanup',()=>{
  let count = 0;
  for (let point=0;point<=0x10ffff;point++) {
    const quote = String.fromCodePoint(point);
    if (!/\p{Quotation_Mark}/u.test(quote)) continue;
    count++;
    for (const spacing of ['', ' ', '  ']) {
      const quoted = `${quote}${spacing}please${quote}`;
      const result = firstQuery(`When did the error first appear in same.mp4—${quoted}?`);
      assert.equal(result.query,`error ${quoted.replace(/\s+/g,' ')}`,`U+${point.toString(16)}`);
    }
    // A closing quotation mark alone is not permission to remove the event term.
    assert.equal(firstQuery(`When did the error first appear in same.mp4—please${quote}?`).query,`error please${quote}`);
  }
  assert.ok(count>=30);
});

test('plain courtesy still disappears while quoted courtesy remains literal evidence',()=>{
  assert.equal(firstQuery('When did the error first appear in same.mp4—please?').query,'error');
  assert.equal(firstQuery('When did the error first appear in same.mp4。').query,'error');
  assert.equal(firstQuery('When did the error first appear in same.mp4—“please”? please.').query,'error “please”');
  assert.equal(firstQuery('When did the error first appear in same.mp4—"please"?').query,'error "please"');
  assert.equal(firstQuery('When did the word “please” first appear in same.mp4?').query,'word “please”');
});

test('quote handling preserves numeric bounds, source constraints and unrelated intents',()=>{
  const result = firstQuery('When did the error first appear between 00:20 and 00:45 in same.mp4—“please”?');
  assert.equal(result.query,'error “please”');assert.equal(result.start,20);assert.equal(result.end,45);
  assert.equal(timelineIntent('What happened in the last 30 seconds?','same.mp4').kind,'tail');
  assert.equal(timelineIntent('Build a timeline of World War II','same.mp4'),null);
  assert.equal(resolveTimelineSource('When did the error first appear in missing.mp4—“please”?',[],[file],[]).source,undefined);
  assert.match(timelineIntent('When did the error first appear in same.mp4backup?','same.mp4').query,/same mp4backup/);
});

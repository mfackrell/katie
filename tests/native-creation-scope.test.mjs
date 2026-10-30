import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync('scripts/benchmark/native-development-child.mjs','utf8');
const start=source.indexOf('const prompts='),end=source.indexOf('const {reviewMessage}=',start);
assert.ok(start>=0&&end>start);
const prompt=phase=>vm.runInNewContext(source.slice(start,end)+'anchored',{phase,baseline:'a'.repeat(40)});

test('implementation and repair explicitly create missing authorized paths without expanding authority',()=>{
 for(const phase of ['implementation','repair']){
  const text=prompt(phase);
  assert.match(text,/Read the immutable owner request/);
  assert.match(text,/scope defines where changes are permitted, not which files must already exist/);
  assert.match(text,/create the required directories and files within the allowed paths and continue implementation and tests/);
  assert.match(text,/Missing authorized paths alone.*are not a repository mismatch/);
  assert.match(text,/genuine repository, permission, or authorization mismatches must still block execution/);
  assert.match(text,/Never create or modify files outside approved paths, change the frozen requirements, or bypass scope validation/);
 }
});

test('independent reviews remain read-only and baseline anchored',()=>{
 for(const phase of ['review','final-review']){
  const text=prompt(phase);
  assert.match(text,/Do not edit/);
  assert.match(text,/git diff a{40}\.\.\.HEAD/);
  assert.doesNotMatch(text,/create the required directories/);
 }
});

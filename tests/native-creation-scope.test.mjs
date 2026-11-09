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

test('test generation and its output obey the same frozen implementation paths',()=>{
 for(const phase of ['implementation','repair']){
  const text=prompt(phase);
  assert.match(text,/Test files, browser probes, fixtures, screenshots, reports and generated test output are subject to the SAME approved paths/);
  assert.match(text,/Do not default to a repository-level tests\/ directory unless that directory is explicitly authorized/);
  assert.match(text,/Put task-specific tests inside an approved implementation directory and invoke them by their exact path/);
  assert.match(text,/Disable or redirect generated output/);
  assert.match(text,/never remove, widen or bypass the scope guard/);
 }
});

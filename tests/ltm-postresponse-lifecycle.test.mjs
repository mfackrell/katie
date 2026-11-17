import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

const exports={};
vm.runInNewContext(ts.transpileModule(readFileSync('lib/standalone-accounting/memory-scheduling.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{exports});
const {scheduleMemoryPersistence}=exports;

test('standalone chat settles without awaiting paid memory jobs',async()=>{
  const order=[];let callback;
  await scheduleMemoryPersistence(true,async()=>order.push('memory'),persist=>{callback=persist});
  order.push('chat settled');
  assert.deepEqual(order,['chat settled']);
  await callback();
  assert.deepEqual(order,['chat settled','memory']);
});

test('memory failure belongs to deferred task and does not block the user chat',async()=>{
  const failure=Error('Memory provider temporarily unavailable');let callback;
  await assert.doesNotReject(scheduleMemoryPersistence(true,async()=>{throw failure},persist=>{callback=persist}));
  await assert.rejects(callback(),error=>error===failure);
});

test('managed chat also uses deferred memory processing',async()=>{
  let runs=0,callback;
  await scheduleMemoryPersistence(false,async()=>{runs++},persist=>{callback=persist});
  assert.equal(runs,0);
  await callback();assert.equal(runs,1);
});

test('post-answer memory no longer depends on chat-scoped checkpoints or abort signal',()=>{
  const route=readFileSync('app/api/chat/route.ts','utf8');
  assert.match(route,/await scheduleMemoryPersistence\(Boolean\(currentStandaloneWorkflow\(\)\), persistAccountedMemory, after\)/);
  assert.match(route,/maybeUpdateSummary\(chatId\)/);
  assert.match(route,/maybeUpdateRelevantLongTermMemory\(actorId, chatId, message\)/);
  assert.doesNotMatch(route,/cachedWorkflowValue\("memory-(?:retention|summary|cleanup)"/);
});

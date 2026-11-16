import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
import {AsyncLocalStorage} from 'node:async_hooks';
const exports={};
vm.runInNewContext(ts.transpileModule(readFileSync('lib/standalone-accounting/memory-scheduling.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports});
const {scheduleMemoryPersistence}=exports;
test('standalone workflow waits for paid memory checkpoint before completion',async()=>{
 const order=[];let release;const gate=new Promise(resolve=>{release=resolve});
 const done=scheduleMemoryPersistence(true,async()=>{order.push('memory started');await gate;order.push('memory checkpointed')},()=>assert.fail('standalone must not defer approval out of workflow')).then(()=>order.push('workflow completed'));
 await Promise.resolve();assert.deepEqual(order,['memory started']);release();await done;
 assert.deepEqual(order,['memory started','memory checkpointed','workflow completed']);
});
test('standalone accounting pause propagates instead of completing the workflow',async()=>{
 const denial=Object.assign(Error('Exact memory attempt needs approval'),{code:'standalone_approval_required'});
 await assert.rejects(scheduleMemoryPersistence(true,async()=>{throw denial},()=>assert.fail('must not defer')),error=>error===denial);
});
test('managed agent retains deferred memory scheduling without blocking its response',async()=>{
 let callback;let runs=0;
 await scheduleMemoryPersistence(false,async()=>{runs++},value=>{callback=value});
 assert.equal(runs,0);assert.equal(typeof callback,'function');await callback();assert.equal(runs,1);
});

test('post-answer memory survives browser abort without losing owner accounting identity',async()=>{
 const contextExports={};
 vm.runInNewContext(ts.transpileModule(readFileSync('lib/standalone-accounting/context.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
 }).outputText,{
  exports:contextExports,
  require:name=>{
    assert.equal(name,'node:async_hooks');
    return {AsyncLocalStorage};
  },
 });
 const {runWithStandaloneAccounting,runWithDurablePostAnswerAccounting,getAccountingScope,nextStandaloneAttempt}=contextExports;
 const aborted=new AbortController();
 await runWithStandaloneAccounting({
  userId:'owner',actorId:'actor',chatId:'chat',requestId:'saved-request',activity:'chat',signal:aborted.signal,
 },async()=>{
  // The assistant answer stream is already closed and the client disconnected.
  aborted.abort();
  await scheduleMemoryPersistence(true,async()=>{
   await runWithDurablePostAnswerAccounting(async()=>{
    const scope=getAccountingScope();
    assert.equal(scope.kind,'standalone');
    assert.equal(scope.context.signal,undefined);
    assert.equal(scope.context.userId,'owner');
    assert.equal(scope.context.requestId,'saved-request');
    assert.equal(nextStandaloneAttempt().attemptKey,'chat:0');
    await Promise.resolve();
    assert.equal(nextStandaloneAttempt().attemptKey,'chat:1');
   });
  },()=>assert.fail('standalone memory must remain in the durable workflow'));
  assert.equal(getAccountingScope().context.signal.aborted,true);
  assert.equal(nextStandaloneAttempt().attemptKey,'chat:2',
   'detached memory must share the original paid-attempt counter');
 });
 assert.equal(getAccountingScope(),undefined,'no accounting authority escapes its parent scope');
});

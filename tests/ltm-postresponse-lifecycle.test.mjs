import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
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

import test from 'node:test';import assert from 'node:assert/strict';
import {meteredRequest} from '../scripts/benchmark/metered-request.mjs';
const base={requestId:'r1',model:'test',maxInputTokens:20,maxOutputTokens:30};
test('reservation precedes provider, reconciliation follows',async()=>{
 const order=[];
 const response=await meteredRequest({...base,reserve:async x=>{order.push('reserve');assert.equal(x.upperTokens,50);return{accepted:true,id:'lease'};},
  invoke:async()=>{order.push('provider');return{usage:{inputTokens:11,outputTokens:9}};},
  finalize:async x=>{order.push('finalize');assert.equal(x.status,'completed');return{committed:true}}});
 assert.equal(response.usage.outputTokens,9);assert.deepEqual(order,['reserve','provider','finalize']);
});
test('denied reservation never calls provider',async()=>{
 let called=false;
 await assert.rejects(meteredRequest({...base,reserve:async()=>({accepted:false}),invoke:async()=>{called=true},finalize:async()=>{}}),/EXHAUSTED/);
 assert.equal(called,false);
});
test('missing usage retains unresolved reservation',async()=>{
 const states=[];
 await assert.rejects(meteredRequest({...base,reserve:async()=>({accepted:true,id:'x'}),invoke:async()=>({}),finalize:async x=>{states.push(x.status)}}),/USAGE_UNVERIFIED/);
 assert.deepEqual(states,['unresolved']);
});
test('network failure retains unresolved reservation',async()=>{
 const states=[];
 await assert.rejects(meteredRequest({...base,reserve:async()=>({accepted:true,id:'x'}),invoke:async()=>{throw Error('timeout')},finalize:async x=>{states.push(x.status)}}),/timeout/);
 assert.deepEqual(states,['unresolved']);
});
test('commit failure must not return success',async()=>{
 await assert.rejects(meteredRequest({...base,reserve:async()=>({accepted:true,id:'x'}),invoke:async()=>({usage:{inputTokens:1,outputTokens:1}}),finalize:async()=>({committed:false})}),/COMMIT_FAILED/);
});

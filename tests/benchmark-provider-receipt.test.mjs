import test from 'node:test';import assert from 'node:assert/strict';
import {durableBenchmarkAdapter} from '../scripts/benchmark/durable-adapter.mjs';
test('provider receipt forwards immutable ID and actual usage',async()=>{
 const records=[];
 const db={rpc:async(name,args)=>{records.push({name,args});return{data:'overrun',error:null}}};
 const result=await durableBenchmarkAdapter(db,'account').reconcileProviderReceipt({
  reservationId:'hold',providerNamespace:'provider-a',providerRequestId:'external-request-1',inputTokens:100,outputTokens:2
 });
 assert.equal(result,'overrun');
 assert.deepEqual(records,[{name:'benchmark_reconcile_receipt',args:{p_call:'hold',p_namespace:'provider-a',p_provider_request:'external-request-1',p_actual:102}}]);
});
test('invalid or incomplete provider receipts never reach database',async()=>{
 let reached=false;
 const db={rpc:async()=>{reached=true;return{data:true}}};
 await assert.rejects(durableBenchmarkAdapter(db,'account').reconcileProviderReceipt({
  reservationId:'hold',providerNamespace:'provider-a',providerRequestId:'',inputTokens:1,outputTokens:1
 }),/RECEIPT_INCOMPLETE/);
 assert.equal(reached,false);
});

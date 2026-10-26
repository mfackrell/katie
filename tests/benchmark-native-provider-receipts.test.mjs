import test from 'node:test';
import assert from 'node:assert/strict';
import {createResponsesProvider,createCanonicalReceiptWriter}
 from '../scripts/benchmark/native-provider-receipts.mjs';
const key='synthetic-test-'+('k'.repeat(45));
const sse=(id,used)=>[
 'event: response.created\ndata: {}',
 'event: response.completed\ndata: '+JSON.stringify({type:'response.completed',
  response:{id,usage:{total_tokens:used}}}),
 'data: [DONE]',''
].join('\n\n');
test('provider receipt is derived from terminal Responses SSE, never request claims',async()=>{
 const provider=createResponsesProvider({apiKey:key,fetchImpl:async()=>new Response(sse('resp_real_fixture',19),
  {status:200,headers:{'content-type':'text/event-stream'}})});
 const receipt=await provider({model:'test',stream:true});
 assert.equal(receipt.providerRequestId,'resp_real_fixture');
 assert.equal(receipt.actualTokens,19);
});
test('partial stream preserves unknown charge instead of manufacturing zero',async()=>{
 const provider=createResponsesProvider({apiKey:key,fetchImpl:async()=>new Response(
  'event: response.created\ndata: {}\n\n',{status:200})});
 await assert.rejects(provider({model:'test'}),/AUTHORITATIVE_RECEIPT_MISSING/);
});
test('canonical receipt writer persists only settled or overrun states',async()=>{
 const seen=[];
 const writer=createCanonicalReceiptWriter({rpc:async(n,args)=>{seen.push([n,args]);return{data:'settled',error:null}}});
 assert.equal(await writer({operationId:'op-1',namespace:'synthetic',providerRequestId:'resp-1',actualTokens:7}),'settled');
 assert.equal(seen[0][0],'benchmark_reconcile_receipt');
 assert.equal(seen[0][1].p_actual,7);
 const denied=createCanonicalReceiptWriter({rpc:async()=>({data:null,error:{message:'denied'}})});
 await assert.rejects(denied({operationId:'op-1',namespace:'synthetic',providerRequestId:'resp-1',actualTokens:7}),/LEDGER_RECEIPT_REJECTED/);
});

test('incomplete terminal carries authoritative usage for reconciliation',async()=>{
 const payload='event: response.incomplete\\ndata: '+JSON.stringify({type:'response.incomplete',response:{id:'resp_incomplete',status:'incomplete',usage:{total_tokens:4096}}})+'\\n\\n';
 const provider=createResponsesProvider({apiKey:key,fetchImpl:async()=>new Response(payload,{status:200})});
 const receipt=await provider({model:'test'});
 assert.equal(receipt.providerRequestId,'resp_incomplete');
 assert.equal(receipt.actualTokens,4096);
});

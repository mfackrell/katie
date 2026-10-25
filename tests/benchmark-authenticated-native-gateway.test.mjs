import test from 'node:test';
import assert from 'node:assert/strict';
import {forwardAuthorizedModelRequest,tokenDigest} from '../scripts/benchmark/authenticated-native-gateway.mjs';
const token='synthetic-only-token-'+('x'.repeat(50));
const request={grantToken:token,trialId:'trial-1',executionEpoch:1,model:'mock',
 requestBody:{model:'mock'},upperTokens:40,providerNamespace:'fixture'};
test('denied grant never reaches model provider',async()=>{
 let forwarded=0;
 await assert.rejects(forwardAuthorizedModelRequest({...request,
 db:{rpc:async()=>({data:null,error:{message:'denied'}})},
 upstream:async()=>{forwarded++;},recordReceipt:async()=>{}}),/ADMISSION_DENIED/);
 assert.equal(forwarded,0);
});
test('every provider retry reserves a distinct operation and records receipt',async()=>{
 const calls=[],receipts=[];
 const db={rpc:async(name,args)=>{calls.push([name,args]);return{data:'operation-'+calls.length,error:null}}};
 for(let i=0;i<2;i++)await forwardAuthorizedModelRequest({...request,db,
 upstream:async()=>({providerRequestId:'provider-'+i,actualTokens:24}),
 recordReceipt:async receipt=>receipts.push(receipt)});
 assert.equal(calls.length,2);
 assert.equal(new Set(calls.map(x=>x[1].p_request_key)).size,2);
 assert.deepEqual(receipts.map(x=>x.actualTokens),[24,24]);
 assert.ok(calls.every(x=>x[1].p_digest===tokenDigest(token)));
});
test('uncertain provider outcome retains reservation and never records zero usage',async()=>{
 let released=0;
 await assert.rejects(forwardAuthorizedModelRequest({...request,
 db:{rpc:async()=>({data:'held-operation',error:null})},
 upstream:async()=>{throw Error('dropped after forwarding')},
 recordReceipt:async()=>{released++;}}),e=>e.message==='GATEWAY_UPSTREAM_UNCERTAIN'&&e.operationId==='held-operation');
 assert.equal(released,0);
});
test('invalid or short token cannot reach provider',async()=>{
 let started=0;
 await assert.rejects(forwardAuthorizedModelRequest({...request,grantToken:'fake',
 db:{rpc:async()=>{started++;return{data:'x',error:null}}},
 upstream:async()=>{started++;},recordReceipt:async()=>{}}),/TOKEN_INVALID/);
 assert.equal(started,0);
});

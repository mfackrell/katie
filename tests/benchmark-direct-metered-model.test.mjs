import test from 'node:test';import assert from 'node:assert/strict';
import {directMeteredModelCall} from '../scripts/benchmark/direct-metered-model.mjs';
test('direct inference checks durable reservation before provider call',async()=>{
 const calls=[];
 const db={rpc:async(name)=>{calls.push(name);return {data:name==='benchmark_reserve_call'?'reservation':true,error:null}}};
 const result=await directMeteredModelCall({db,accountId:'acct',requestId:'id',model:'model',
  maxInputTokens:20,maxOutputTokens:30,provider:async()=>{
   calls.push('provider');return {usage:{inputTokens:4,outputTokens:5}};
  }});
 assert.equal(result.usage.inputTokens,4);
 assert.deepEqual(calls,['benchmark_reserve_call','provider','benchmark_settle_call']);
});
test('direct inference denied by database never reaches provider',async()=>{
 let providerCalled=false;
 const db={rpc:async()=>({data:null,error:{message:'budget exhausted'}})};
 await assert.rejects(directMeteredModelCall({db,accountId:'acct',requestId:'id',model:'model',
 maxInputTokens:10,maxOutputTokens:20,provider:async()=>{providerCalled=true;}}),/LEDGER_RPC_FAILED/);
 assert.equal(providerCalled,false);
});

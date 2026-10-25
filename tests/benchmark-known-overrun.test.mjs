import test from 'node:test';
import assert from 'node:assert/strict';
import {durableBenchmarkAdapter} from '../scripts/benchmark/durable-adapter.mjs';
test('known overrun is recorded with actual provider usage and never treated as success',async()=>{
 const calls=[];
 const db={rpc:async(name,args)=>{
  calls.push({name,args});
  return {data:name==='benchmark_reserve_call'?'reserved-id':true,error:null};
 }};
 await assert.rejects(durableBenchmarkAdapter(db,'account-id').execute({
  requestId:'provider-1',model:'fixture',maxInputTokens:10,maxOutputTokens:10,
  invoke:async()=>({usage:{inputTokens:100,outputTokens:2}})
 }),/BENCHMARK_PROVIDER_CAP_VIOLATION/);
 assert.deepEqual(calls.map(x=>x.name),['benchmark_reserve_call','benchmark_record_overrun']);
 assert.equal(calls[1].args.p_actual,102);
});
test('ambiguous network failures leave full reservation held',async()=>{
 const calls=[];
 const db={rpc:async(name)=>{calls.push(name);return{data:'reserved-id',error:null}}};
 await assert.rejects(durableBenchmarkAdapter(db,'account').execute({
  requestId:'network',model:'fixture',maxInputTokens:10,maxOutputTokens:10,
  invoke:async()=>{throw Error('connection reset')}
 }),/connection reset/);
 assert.deepEqual(calls,['benchmark_reserve_call']);
});
test('overrun record failure never reports a successful response',async()=>{
 const db={rpc:async(name)=>name==='benchmark_record_overrun'
  ?{data:null,error:{message:'ledger unavailable'}}
  :{data:'reserved-id',error:null}};
 await assert.rejects(durableBenchmarkAdapter(db,'account').execute({
  requestId:'lost',model:'fixture',maxInputTokens:10,maxOutputTokens:10,
  invoke:async()=>({usage:{inputTokens:50,outputTokens:1}})
 }),/BENCHMARK_LEDGER_RPC_FAILED/);
});

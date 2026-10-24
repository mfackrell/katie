import test from 'node:test';
import assert from 'node:assert/strict';
import {durableBenchmarkAdapter} from '../scripts/benchmark/durable-adapter.mjs';
test('durable adapter reserves before provider and settles reported usage',async()=>{
 const events=[];
 const db={rpc:async(name,args)=>{
  events.push(name);
  if(name==='benchmark_reserve_call'){assert.equal(args.p_tokens,30);return {data:'call-id',error:null}}
  if(name==='benchmark_settle_call'){assert.equal(args.p_actual,12);return {data:true,error:null}}
  throw Error('unexpected rpc');
 }};
 const agent=durableBenchmarkAdapter(db,'account-1');
 const response=await agent.execute({requestId:'r1',model:'model',maxInputTokens:10,maxOutputTokens:20,invoke:async()=>{
  events.push('provider');return {usage:{inputTokens:7,outputTokens:5}};
 }});
 assert.equal(response.usage.outputTokens,5);
 assert.deepEqual(events,['benchmark_reserve_call','provider','benchmark_settle_call']);
});
test('failed provider call leaves durable hold in place',async()=>{
 const events=[];
 const db={rpc:async(name)=>{events.push(name);return {data:'reserved-id',error:null}}};
 await assert.rejects(durableBenchmarkAdapter(db,'account-1').execute({requestId:'r2',model:'model',maxInputTokens:10,maxOutputTokens:10,invoke:async()=>{throw Error('network timeout')}}),/timeout/);
 assert.deepEqual(events,['benchmark_reserve_call']);
});
test('budget increases only redeem stored approval IDs',async()=>{
 const events=[];
 const db={rpc:async(name,args)=>{events.push([name,args]);return {data:true,error:null}}};
 const result=await durableBenchmarkAdapter(db,'account-1').redeemApprovedIncrease('owner-approved-1');
 assert.equal(result,true);
 assert.deepEqual(events,[['benchmark_redeem_approval',{p_approval:'owner-approved-1'}]]);
});

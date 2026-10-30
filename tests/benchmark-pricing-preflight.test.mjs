import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readVerifiedBenchmarkPricing,assertBenchmarkDollarCeiling} from '../scripts/benchmark/paid-dollar-ceiling.mjs';
const price={pricing_status:'verified',pricing_input_per_1m:'1.75',pricing_output_per_1m:'14'};
const options=delays=>({sleep:async ms=>delays.push(ms)});
test('transient read retries are bounded and diagnostics never expose raw errors',async()=>{
 for(const response of [{status:522,error:{message:'secret URL Bearer credential'}},{status:503,error:{}},{status:0,error:{}},{status:400,error:{code:'57P03'}},{status:503,error:{code:'PGRST002'}}]){
  let calls=0;const delays=[];
  await assert.rejects(readVerifiedBenchmarkPricing(async signal=>{assert.ok(signal instanceof AbortSignal);calls++;return response;},options(delays)),{message:'NATIVE_HOST_DENIED: model price evidence read unavailable (attempts=3)'});
  assert.equal(calls,3);assert.deepEqual(delays,[250,750]);
 }
});
test('read retries may recover verified evidence, but never synthesize evidence',async()=>{
 let calls=0;const delays=[];
 const result=await readVerifiedBenchmarkPricing(async()=>{if(++calls===1)throw new TypeError('fetch failed');return {data:price,status:200,error:null};},options(delays));
 assert.equal(result,price);assert.equal(calls,2);assert.deepEqual(delays,[250]);
});
test('permanent errors, missing rows and unverified records do not retry',async()=>{
 for(const [response,message] of [
  [{status:401,error:{message:'Bearer secret'}},'read failed (attempts=1)'],
  [{status:406,error:{code:'PGRST116'}},'read failed (attempts=1)'],
  [{status:200,data:null,error:null},'record missing'],
  [{status:200,data:{...price,pricing_status:'estimated'}},'not verified'],
  [{status:200,data:{...price,pricing_status:'missing'}},'not verified']]){
  let calls=0;await assert.rejects(readVerifiedBenchmarkPricing(async()=>{calls++;return response;},{sleep:()=>assert.fail('Permanent denial cannot retry')}),{message:'NATIVE_HOST_DENIED: model price evidence '+message});assert.equal(calls,1);
 }
});
test('host executes exact read-only pricing filter and preserves dollar ceiling before authority',async()=>{
 const source=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
 const start=source.indexOf('const pricing=await readVerifiedBenchmarkPricing('),end=source.indexOf('let delegatedTask=',start);
 assert.ok(start>0&&end>start);assert.ok(end<source.indexOf('const grantToken='));
 const execute=new (Object.getPrototypeOf(async function(){}).constructor)('db','readVerifiedBenchmarkPricing','assertBenchmarkDollarCeiling','approval','account','productionRuntime','continuation','denied',source.slice(start,end));
 let reads=0;const filters=[];
 const db={from(table){assert.equal(table,'model_registry');return {select(fields){assert.equal(fields,'pricing_input_per_1m,pricing_output_per_1m,pricing_status');return this;},eq(k,v){filters.push([k,v]);return this;},abortSignal(signal){assert.ok(signal instanceof AbortSignal);return this;},async maybeSingle(){reads++;return {data:price,status:200};}};}};
 await execute(db,readVerifiedBenchmarkPricing,assertBenchmarkDollarCeiling,{model:'gpt-5.3-codex',max_tokens:350000},{cap_tokens:350000},true);
 assert.equal(reads,1);assert.deepEqual(filters,[['provider_name','openai'],['model_id','gpt-5.3-codex']]);
 await assert.rejects(execute(db,readVerifiedBenchmarkPricing,assertBenchmarkDollarCeiling,{model:'gpt-5.3-codex',max_tokens:350000},{cap_tokens:3500000},true),/BENCHMARK_USD_TOKEN_CEILING_EXCEEDED/);
 let monetaryReads=0;db.rpc=async(name,args)=>{assert.equal(name,'benchmark_full_monetary_control');assert.deepEqual(args,{p_account:'account',p_continuation:'continuation'});monetaryReads++;return {data:{version:'atomic-exposure-v1',cumulativeTokenCap:550000,dollarCeilingMicrousd:10000000}};};
 const denied=message=>{throw Error(message);};
 await execute(db,readVerifiedBenchmarkPricing,()=>assert.fail('v5 uses atomic exposure'),{model:'gpt-5.3-codex',max_tokens:550000},{id:'account',cap_tokens:350000},true,{id:'continuation',plan:{version:5}},denied);
 assert.equal(monetaryReads,1);db.rpc=async()=>({error:{message:'unavailable'}});
 await assert.rejects(execute(db,readVerifiedBenchmarkPricing,()=>assert.fail(),{model:'gpt-5.3-codex',max_tokens:550000},{id:'account'},true,{id:'continuation',plan:{version:5}},denied),/atomic cumulative monetary control unavailable/);
});


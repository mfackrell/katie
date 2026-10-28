import test from 'node:test';
import assert from 'node:assert/strict';
import {fullBenchmarkProjectDecision} from '../scripts/benchmark/full-project-gate.mjs';

const stage='https://iytvavgbaainnsrecmcx.supabase.co';
const prod='https://barclcqataqyvifoeyop.supabase.co';
const gates={dispatchEnabled:true,nativeDispatchEnabled:true,trialId:'trial-715-full'};

test('the existing isolated staging target remains eligible with both dispatch gates and its trial',()=>{
 assert.equal(fullBenchmarkProjectDecision({candidate:true,databaseUrl:stage,...gates}),'full');
});
test('production requires an explicit production environment opt-in',()=>{
 assert.equal(fullBenchmarkProjectDecision({candidate:true,databaseUrl:prod,...gates}),'blocked');
 assert.equal(fullBenchmarkProjectDecision({candidate:true,databaseUrl:prod,environment:'production',...gates}),'full');
});
test('recognized benchmark databases fail closed when the trial or either dispatch gate is absent',()=>{
 assert.equal(fullBenchmarkProjectDecision({candidate:true,databaseUrl:prod,environment:'production',...gates,trialId:null}),'blocked');
 assert.equal(fullBenchmarkProjectDecision({candidate:true,databaseUrl:stage,...gates,nativeDispatchEnabled:false}),'blocked');
});
test('ordinary game projects keep the normal route and unknown databases cannot opt into Full',()=>{
 assert.equal(fullBenchmarkProjectDecision({candidate:false,databaseUrl:prod,...gates}),'ordinary');
 assert.equal(fullBenchmarkProjectDecision({candidate:true,databaseUrl:'https://other.supabase.co',environment:'production',...gates}),'ordinary');
});

const {loadFullBenchmarkBinding}=await import('../scripts/benchmark/full-project-gate.mjs');
const env={NEXT_PUBLIC_SUPABASE_URL:prod,KATIE_FULL_BENCHMARK_ENVIRONMENT:'production',
 KATIE_FULL_BENCHMARK_DISPATCH:'enabled',KATIE_NATIVE_BENCHMARK_DISPATCH:'enabled',
 KATIE_FULL_BENCHMARK_TRIAL_ID:'trial-715-full'};
function database(data,error=null){
 const calls=[];const query={select:()=>query,eq:(column,value)=>{calls.push([column,value]);return query},maybeSingle:async()=>({data,error})};
 return {calls,from:table=>{assert.equal(table,'benchmark_full_project_bindings');return query}};
}
test('production and staging discover the exact durable Full binding before routing or dispatch',async()=>{
 const binding={trial_id:'trial-715-full',baseline_sha:'frozen'};
 for(const runtime of [env,{...env,NEXT_PUBLIC_SUPABASE_URL:stage,KATIE_FULL_BENCHMARK_ENVIRONMENT:'staging'}]){
  const db=database(binding);
  assert.deepEqual(await loadFullBenchmarkBinding(db,'project-715',runtime),binding);
  assert.deepEqual(db.calls,[['project_id','project-715']]);
 }
});
test('disabled, misconfigured and mismatched Full bindings never become ordinary unmetered work',async()=>{
 for(const change of [{KATIE_FULL_BENCHMARK_DISPATCH:''},{KATIE_NATIVE_BENCHMARK_DISPATCH:''},
  {KATIE_FULL_BENCHMARK_ENVIRONMENT:''},{NEXT_PUBLIC_SUPABASE_URL:'https://other.supabase.co'},
  {KATIE_FULL_BENCHMARK_TRIAL_ID:'different'}]){
  const db=database({trial_id:'trial-715-full'});
  await assert.rejects(loadFullBenchmarkBinding(db,'p',{...env,...change}),/Full benchmark/);
  assert.equal(db.calls.length,1);
 }
 await assert.rejects(loadFullBenchmarkBinding(database(null,{message:'offline'}),'p',env),/failed closed/);
});
test('ordinary projects are unaffected even when Full is enabled or disabled',async()=>{
 assert.equal(await loadFullBenchmarkBinding(database(null),'ordinary',env),null);
 assert.equal(await loadFullBenchmarkBinding(database(null),'ordinary',{}),null);
 assert.equal(await loadFullBenchmarkBinding(database(null),null,env),null);
});

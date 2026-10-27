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

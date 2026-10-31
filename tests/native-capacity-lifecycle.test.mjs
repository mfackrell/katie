import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {executeNativeDevelopmentLifecycle} from '../scripts/benchmark/native-development-lifecycle.mjs';
const source=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
// Exercise the host's actual lifecycle control with nonbillable phase/verifier doubles.
const text=source.slice(source.indexOf(" const verifyCandidate="),source.indexOf(' if(!evidencePath'));
async function run({testResults=[true],verdicts=['pass','pass'],infrastructure=false,version6=true}={}){
 const phases=[],verifications=[];let callback,ci=0,decisions=0;
 const context={recovery:null,lastCompleted:{},executeNativeDevelopmentLifecycle,continuation:{plan:{capacityRenewal:version6}},root:'/temp',process:{execPath:'node',env:{RUNNER_TEMP:'/temp'}},boundary:{root:'/work'},requestFile:'/request',diagnostics:{},diagnosticSecrets:[],gatewayFailure:null,child:null,join:(...x)=>x.join('/'),rmSync:()=>{},sanitizeEvidence:x=>x,saveDiagnostics:()=>{},denied:x=>{throw Error('NATIVE_HOST_DENIED: '+x)},readFileSync:()=>{if(infrastructure)return '{"kind":"infrastructure"}';throw Error('missing');},commitCandidate:()=>('head-'+phases.length),safelyRunPhase:async(p,findings)=>{phases.push(p);if(p==='repair')assert.match(findings,/Trusted deterministic/);return {verdict:verdicts[decisions++]??'pass',findings:'independent findings'};},spawn:()=>{const pass=testResults[Math.min(ci++,testResults.length-1)];verifications.push(pass);return {stdout:{on:()=>{}},stderr:{on:()=>{}},once:(event,fn)=>{if(event==='close')queueMicrotask(()=>fn(pass?0:1));}}}};
 // Implementation/repair return no review decision.
 context.safelyRunPhase=async(p,findings)=>{phases.push(p);if(p==='repair')assert.match(findings,/Trusted deterministic/);if(p==='review'||p==='final-review')return {verdict:verdicts[decisions++]??'pass',findings:'independent findings'};};
 let error;try{await vm.runInNewContext('(async()=>{'+text+'})()',context);}catch(e){error=e.message;}
 return {phases,verifications,error};
}
test('deterministic failure reaches the same bounded repair even when initial source review passes',async()=>{
 const r=await run({testResults:[false,true]});assert.deepEqual(r.phases,['implementation','review','repair','final-review']);assert.deepEqual(r.verifications,[false,true]);assert.equal(r.error,undefined);
});
test('a passed candidate still receives final independent review; no unnecessary repair',async()=>{
 const r=await run();assert.deepEqual(r.phases,['implementation','review','final-review']);assert.equal(r.error,undefined);
});
test('failed bounded repair or final review is terminal without another paid attempt',async()=>{
 const r=await run({testResults:[false,false]});assert.deepEqual(r.phases,['implementation','review','repair']);assert.match(r.error,/bounded repair/);
 const v=await run({verdicts:['pass','changes_requested']});assert.match(v.error,/final review/);
});
test('baseline infrastructure failure never consumes a model repair',async()=>{
 const r=await run({infrastructure:true,testResults:[false]});assert.deepEqual(r.phases,['implementation']);assert.match(r.error,/infrastructure/);
});
test('new authority is explicit and never reuses automatic process retry',()=>{
 assert.match(source,/let ownerApprovedSuccessor=continuation\?\.plan\?\.capacityRenewal===true/);
 assert.match(source,/continuation.plan.version===6\?625000:550000/);
});


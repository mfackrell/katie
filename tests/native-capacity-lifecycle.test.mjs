import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {capacityProgress} from '../scripts/benchmark/native-capacity-forecast.mjs';
import {executeNativeDevelopmentLifecycle} from '../scripts/benchmark/native-development-lifecycle.mjs';
const source=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
// Exercise the host's actual lifecycle control with nonbillable phase/verifier doubles.
const text=source.slice(source.indexOf(" const verifyCandidate="),source.indexOf(' if(!evidencePath'));
async function run({testResults=[true],verdicts=['pass','pass'],infrastructure=false,version6=true,ordinary=false,recovery=null}={}){
 const phases=[],verifications=[],durable=[],forecasts=[];let callback,ci=0,decisions=0;
 const context={preserveWip:()=>durable.push(structuredClone(context.lastCompleted)),git:()=>String(ci),ordinary,pauseForCapacity:()=>{},forecastCapacity:async phase=>{forecasts.push(capacityProgress({binding:{},phase,recovery:context.capacityRecovery,completedStages:[...context.capacityCompletedStages],notRequiredStages:[...context.capacityNotRequiredStages]}));},latestCapacityForecast:{status:'indeterminate'},capacityCompletedStages:new Set(),capacityNotRequiredStages:new Set(),recovery,capacityRecovery:recovery,lastCompleted:recovery?.lastCompleted??{},executeNativeDevelopmentLifecycle,continuation:{plan:{capacityRenewal:version6}},root:'/temp',process:{execPath:'node',env:{RUNNER_TEMP:'/temp'}},boundary:{root:'/work'},requestFile:'/request',diagnostics:{capacityForecasts:[]},diagnosticSecrets:[],gatewayFailure:null,child:null,join:(...x)=>x.join('/'),rmSync:()=>{},sanitizeEvidence:x=>x,saveDiagnostics:()=>{},denied:x=>{throw Error('NATIVE_HOST_DENIED: '+x)},readFileSync:()=>{if(infrastructure)return '{"kind":"infrastructure"}';throw Error('missing');},commitCandidate:()=>('head-'+phases.length),safelyRunPhase:async(p,findings)=>{phases.push(p);if(p==='repair')assert.match(findings,/Trusted deterministic/);return {verdict:verdicts[decisions++]??'pass',findings:'independent findings'};},spawn:()=>{const pass=testResults[Math.min(ci++,testResults.length-1)];verifications.push(pass);return {stdout:{on:()=>{}},stderr:{on:()=>{}},once:(event,fn)=>{if(event==='close')queueMicrotask(()=>fn(pass?0:1));}}}};
 // Implementation/repair return no review decision.
 context.safelyRunPhase=async(p,findings,binding)=>{if(p==='repair')for(const s of ['repair','verification','final_review'])context.capacityCompletedStages.delete(s);await context.forecastCapacity(p);phases.push(p);if(p==='repair')assert.match(findings,/Trusted deterministic/);if(p==='review'||p==='final-review')return {reviewedHeadSha:binding?.candidateHead,verdict:verdicts[decisions++]??'pass',findings:'independent findings'};};
 let error;try{await vm.runInNewContext('(async()=>{'+text+'})()',context);}catch(e){error=e.message;}
 return {phases,verifications,error,completed:context.lastCompleted,durable,forecasts};
}
test('deterministic failure reaches the same bounded repair even when initial source review passes',async()=>{
 const r=await run({testResults:[false,true]});assert.deepEqual(r.phases,['implementation','review','repair','final-review']);assert.deepEqual(r.verifications,[false,true]);assert.equal(r.error,undefined);
});
test('a passed candidate still receives final independent review; no unnecessary repair',async()=>{
 const r=await run();assert.deepEqual(r.phases,['implementation','review','final-review']);assert.equal(r.error,undefined);assert.ok(r.durable.some(s=>s.adaptiveRepair?.nextAction==='complete'&&s.review?.verdict==='pass'));
});
test('failed repair and final re-review trigger another authorized correction',async()=>{
 const r=await run({testResults:[false,false,true]});assert.deepEqual(r.phases,['implementation','review','repair','final-review','repair','final-review']);assert.equal(r.error,undefined);
 const v=await run({verdicts:['pass','changes_requested','pass']});assert.deepEqual(v.phases,['implementation','review','final-review','repair','final-review']);assert.equal(v.error,undefined);
});
test('baseline infrastructure failure never consumes a model repair',async()=>{
 const r=await run({infrastructure:true,testResults:[false]});assert.deepEqual(r.phases,['implementation']);assert.match(r.error,/infrastructure/);
});
test('new authority is explicit and never reuses automatic process retry',()=>{
 assert.match(source,/let ownerApprovedSuccessor=Boolean\(ordinary&&approval\.previous_developer_approval_id\)\|\|continuation\?\.plan\?\.capacityRenewal===true/);
 assert.match(source,/continuation.plan.version===6\?625000:550000/);
});



test('paused final review preserves deterministic repair proof and skips completed phases',async()=>{
 let last={},head='a'.repeat(40),checks=0;
 await assert.rejects(executeNativeDevelopmentLifecycle({qualifiedLifecycle:true,
  runPhase:async (phase,_findings,binding)=>{if(phase==='final-review')throw Error('synthetic capacity pause');return {phase,reviewedHeadSha:binding?.candidateHead,verdict:'pass',findings:'independent source review'};},
  commitCandidate:()=>{if(checks)head='b'.repeat(40);return head;},verifyCandidate:async()=>({passed:checks++>0}),onCompleted:e=>{last={...last,...e};}}),/capacity pause/);
 const phases=[];
 const result=await executeNativeDevelopmentLifecycle({qualifiedLifecycle:true,recovery:{phase:'final-review',completedCheckpointSha:head,lastCompleted:last},
  runPhase:async (p,_findings,binding)=>{phases.push(p);return {reviewedHeadSha:binding?.candidateHead,verdict:'pass',findings:'independent final review'};},commitCandidate:()=>assert.fail('completed implementation replayed'),verifyCandidate:()=>assert.fail('completed verification replayed')});
 assert.deepEqual(phases,['final-review']);assert.equal(result.repairPerformed,true);
 assert.deepEqual(result.repairVerification,{before:{head:'a'.repeat(40),passed:false},after:{head:'b'.repeat(40),passed:true}});
 const closure=await executeNativeDevelopmentLifecycle({recovery:{phase:'do_completion',lastCompleted:{lifecycle:result}},runPhase:()=>assert.fail('completed engineering replayed')});
 assert.deepEqual(closure,result);
});

test('authenticated clean-baseline predecessor retains bounded phase observations without source restoration',async()=>{
 const start=source.indexOf('let recoveryPlan=null,priorCapacityObservations=[]'),end=source.indexOf('let latestCapacityForecast',start);
 assert.ok(start>=0&&end>start);
 const observations=Array.from({length:70},(_,i)=>({id:'settled-phase-'+i}));
 const context={priorRefs:[],task:{id:'original',external:{receipt:{outcome:'BLOCKED'}}},proof:{},wipContext:{baseSha:'a'.repeat(40),baselineSha:'a'.repeat(40)},process:{env:{GITHUB_REPOSITORY:'synthetic/repository'}},githubRecoveryReader:()=>({}),loadRecoveryDiagnostics:async input=>{assert.equal(input.emptyBaselineSha,'a'.repeat(40));return {record:null,diagnostics:{capacityObservations:observations}};},recoveryCompletedEvidence:()=>assert.fail('No source checkpoint exists'),validateRecoveryRecords:()=>assert.fail('No source checkpoint exists'),prepareRecovery:()=>assert.fail('No source checkpoint exists')};
 const run=()=>vm.runInNewContext('(async()=>{'+source.slice(start,end)+';return {recovery,capacityObservations};})()',context);
 const result=await run();assert.equal(result.recovery,null);assert.deepEqual(JSON.parse(JSON.stringify(result.capacityObservations)),observations.slice(-64));
 context.loadRecoveryDiagnostics=async()=>{throw Error('Untrusted predecessor artifact');};await assert.rejects(run(),/Untrusted predecessor artifact/);
});

test('ordinary first execution verifies before review and preserves failed-to-passed repair evidence',async()=>{
 const r=await run({ordinary:true,version6:false,testResults:[false,true]});
 assert.equal(r.error,undefined);assert.deepEqual(r.phases,['implementation','review','repair','final-review']);assert.deepEqual(r.verifications,[false,true]);
 assert.deepEqual(JSON.parse(JSON.stringify(r.completed.lifecycle.repairVerification)),{before:{head:'head-1',passed:false},after:{head:'head-3',passed:true}});
 const denied=await run({ordinary:true,version6:false,infrastructure:true,testResults:[false]});
 assert.deepEqual(denied.phases,['implementation']);assert.match(denied.error,/infrastructure/);
});

test('review without inspected candidate identity fails closed',async()=>{
 await assert.rejects(executeNativeDevelopmentLifecycle({runPhase:async()=>({verdict:'pass',findings:'unbound approval'}),commitCandidate:()=> 'a'.repeat(40),verifyCandidate:async()=>({passed:true})}),/CANDIDATE_MISMATCH/);
});
test('unchanged source cannot evade no-progress by rewording diagnostics',async()=>{
 let reviews=0,repairs=0;
 await assert.rejects(executeNativeDevelopmentLifecycle({candidateIdentity:()=> 'same-tree',commitCandidate:()=> 'a'.repeat(40),verifyCandidate:async()=>({passed:false,detail:'failure '+reviews}),runPhase:async(phase,_findings,binding)=>{
  if(phase==='repair'){repairs++;return;}if(phase==='implementation')return;
  return {reviewedHeadSha:binding.candidateHead,verdict:'changes_requested',findings:'Review wording '+(++reviews)};
 }}),/NO_PROGRESS/);assert.equal(repairs,1);
});
test('recovered final review followed by failed repaired verification cannot restore stale passing progress',async()=>{
 const head='head-0';
 const r=await run({recovery:{phase:'final-review',completedCheckpointSha:head,lastCompleted:{verification:{head,passed:true},review:{phase:'review',reviewedHeadSha:head,verdict:'pass',findings:'Initial review'},adaptiveRepair:{version:2,nextAction:'final-review',candidateHead:head,iteration:0,stagnant:0,seen:[]}}},testResults:[false,true],verdicts:['changes_requested','pass','pass']});
 assert.equal(r.error,undefined);assert.deepEqual(r.phases,['final-review','repair','final-review','repair','final-review']);
 const reviews=r.forecasts.filter(f=>f.phase==='final_review');assert.equal(reviews.length,3);
 assert.ok(reviews[0].completedStages.includes('verification'));
 assert.ok(!reviews[1].completedStages.includes('verification'),'Failed new candidate must not inherit restored passing verification');
 assert.ok(reviews[2].completedStages.includes('verification'));
 assert.ok(!r.forecasts.at(-1).notRequiredStages.includes('repair'),'Completed repairs cannot be relabeled not required');
});

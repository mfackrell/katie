import test from 'node:test';
import assert from 'node:assert/strict';
import {TASK4A_SUCCESSOR_ENVELOPE as E,validateTask4aSuccessorEnvelope,task4aSuccessorRequestCap,assertTask4aSuccessorRequest} from '../scripts/benchmark/task4a-successor-envelope.mjs';
import {assessLifecycleCapacity} from '../scripts/benchmark/lifecycle-capacity.mjs';
import {freshNativePhaseWork} from '../scripts/benchmark/native-phase-profile.mjs';
test('hard bootstrap arithmetic preserves historical accounting and both reserves',()=>{
 assert.equal(E.nativeCalls*E.requestTokens,E.nativeReservationTokens);
 assert.equal(22250+E.additionalNativeTokens,E.nativeReservationTokens);
 assert.equal(2075+E.additionalProjectTokens,E.nativeReservationTokens);
 assert.equal(289620+E.additionalNativeTokens,E.cumulativeTokens);
 assert.equal(229620+E.additionalNativeTokens,E.developmentTokens);
 assert.equal(186995-E.carriedProjectReservationTokens+E.additionalProjectTokens,E.continuationTokens);
 assert.equal(E.continuationTokens-E.assessmentReserveTokens-E.completionReserveTokens,E.nativeReservationTokens);
 assert.equal(20-4+E.additionalCalls,E.continuationCalls);
 assert.equal(20+E.additionalCalls,E.developmentCalls);
 assert.equal(8894169-E.carriedProjectReservationMicrousd,E.continuationMicrousd);
 assert.equal(E.requestTokens*14,E.nativeRequestBoundMicrousd);
 assert.equal(E.nativeCalls*E.nativeRequestBoundMicrousd,E.nativeEnvelopeBoundMicrousd);
 assert.ok(E.nativeEnvelopeBoundMicrousd+280798<E.ceilingMicrousd);
 assert.ok(E.nativeRequestBoundMicrousd<E.perCallMicrousd);
 // Project admission separately retains ceil(tokens * 14 * 1.65) per call.
 const projectPerCall=(BigInt(E.requestTokens)*14n*165n+99n)/100n;
 assert.equal(projectPerCall,532086n);
 assert.equal(projectPerCall*BigInt(E.nativeCalls),3192516n);
 assert.equal(projectPerCall,BigInt(E.projectRequestBoundMicrousd));
 assert.equal(projectPerCall*BigInt(E.nativeCalls),BigInt(E.projectEnvelopeBoundMicrousd));
 assert.ok(projectPerCall*BigInt(E.nativeCalls)<=BigInt(E.continuationMicrousd));
 assert.match(E.basis,/not_forecast/);
});
test('ordinary cap unchanged; authenticated marker can only tighten it',()=>{
 assert.equal(task4aSuccessorRequestCap({approval:{},defaultCap:120000}),120000);
 const approval={developer_authority:{task4aSuccessorEnvelope:{...E}}};
 assert.equal(task4aSuccessorRequestCap({approval,defaultCap:120000}),23034);
 assert.equal(task4aSuccessorRequestCap({approval,defaultCap:10000}),10000);
});
test('missing, foreign, changed, extra and malformed envelope fields rejected',()=>{
 for(const value of [null,[],{}, {...E,projectId:'foreign'},{...E,requestTokens:23035},{...E,extra:true}]){
  assert.throws(()=>validateTask4aSuccessorEnvelope(value),/DENIED/);
 }
 assert.throws(()=>task4aSuccessorRequestCap({approval:{developer_authority:{task4aSuccessorEnvelope:null}},defaultCap:120000}),/DENIED/);
 assert.ok(Object.isFrozen(E));
});
test('exact counted request bound passes; input opaque output overflow fails closed',()=>{
 assert.equal(assertTask4aSuccessorRequest({envelope:E,inputTokens:17914}),23034);
 assert.equal(assertTask4aSuccessorRequest({envelope:E,inputTokens:16914,opaqueTokens:1000}),23034);
 for(const change of [{inputTokens:17915},{inputTokens:17914,opaqueTokens:1},{outputTokens:4097},{inputTokens:-1},{inputTokens:NaN},{inputTokens:1.5},{opaqueTokens:Infinity},{outputTokens:0},{inputTokens:Number.MAX_SAFE_INTEGER,opaqueTokens:1}]){
  assert.throws(()=>assertTask4aSuccessorRequest({envelope:E,inputTokens:17914,...change}),/DENIED/);
 }
});
test('invalid ordinary caps rejected and smaller output cannot expand input allowance',()=>{
 for(const defaultCap of [0,-1,NaN,Infinity,1.5])assert.throws(()=>task4aSuccessorRequestCap({approval:{},defaultCap}),/DENIED/);
 assert.throws(()=>assertTask4aSuccessorRequest({envelope:E,inputTokens:17915,outputTokens:1}),/DENIED/);
});
test('bootstrap keeps real empirical forecast indeterminate and never erases known call shortages',()=>{
 const now=Date.parse('2026-11-08T12:00:00Z');
 const binding={taskId:E.taskId,projectId:E.projectId,baselineSha:'49c8a5f791e66c351436bb97839193b53d7a1cd1',scopeHash:'b'.repeat(64),contractHash:'c'.repeat(64)};
 const input={binding,observedAt:now,cohort:binding.scopeHash,
  progress:{source:'authenticated_recovery',binding,phase:'verification',checkpointSha:E.checkpointSha,completedStages:['implementation']},
  work:{...freshNativePhaseWork,repairIterations:1,additionalRepairIterations:0},observations:[],pricing:{},
  authorization:{live:true,executionAuthorized:true,deadline:now+E.durationSeconds*1000,
   tokens:{cumulativeLimit:E.cumulativeTokens,developmentLimit:E.developmentTokens,accountEncumbered:147370,developmentEncumbered:147370,completionReserveRemaining:60000,assessmentReserveRemaining:60000},
   calls:{developmentLimit:E.developmentCalls,developmentConsumed:12,completionReserveRemaining:4,assessmentLimit:4,assessmentConsumed:0},
   money:{complete:true,ceilingMicrousd:String(E.ceilingMicrousd),exposureMicrousd:'280798'}}};
 const before=structuredClone(input),result=assessLifecycleCapacity(input);
 assert.equal(result.status,'indeterminate');
 assert.equal(result.dimensions.nativeCalls.minimumRemaining,6);
 assert.equal(result.dimensions.nativeCalls.authorizedRemaining,6);
 assert.equal(result.dimensions.nativeTokens.authorizedRemaining,E.nativeReservationTokens);
 assert.equal(result.dimensions.nativeTokens.projectedRemaining,null);
 assert.equal(result.methodology.minimumComparableObservations,3);
 assert.equal(result.stages.find(s=>s.stage==='initial_review').metrics.inputTokens.samples,0);
 assert.deepEqual(input,before,'No manufactured observations or authority mutation');
 input.authorization.calls.developmentLimit=20;
 const old=assessLifecycleCapacity(input);
 assert.equal(old.status,'insufficient');
 assert.equal(old.dimensions.nativeCalls.authorizedRemaining,4);
 assert.ok(old.shortages.includes('nativeCalls'));
});

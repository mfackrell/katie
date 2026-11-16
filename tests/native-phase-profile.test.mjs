import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './lifecycle-capacity.test.mjs';
import {assessLifecycleCapacity} from '../scripts/benchmark/lifecycle-capacity.mjs';
import {freshNativePhaseWork} from '../scripts/benchmark/native-phase-profile.mjs';
test('fresh inspection profile requires tool/result cycles without changing generic planner defaults',()=>{
 const f=fixture();f.observations=[];f.progress={...f.progress,phase:'repair',completedStages:['implementation','initial_review']};
 assert.equal(assessLifecycleCapacity(f).dimensions.nativeCalls.minimumRemaining,2);
 f.work={...f.work,...freshNativePhaseWork};const r=assessLifecycleCapacity(f);
 assert.equal(r.dimensions.nativeCalls.minimumRemaining,4);
 assert.equal(r.dimensions.nativeCalls.projectedRemaining,null,'A minimum is not a measured completion estimate');
 assert.equal(r.dimensions.completionCalls.minimumRemaining,4);assert.equal(r.dimensions.assessmentCalls.minimumRemaining,1);
 f.work.nativePhaseProfile='unrecognized';assert.equal(assessLifecycleCapacity(f).dimensions.nativeCalls.minimumRemaining,2);
});
test('fresh profile preserves larger observed demand and completed engineering',()=>{
 const f=fixture();f.work={...f.work,...freshNativePhaseWork};f.progress={...f.progress,phase:'repair',completedStages:['implementation','initial_review']};
 const r=assessLifecycleCapacity(f);assert.equal(r.dimensions.nativeCalls.projectedRemaining,8);assert.equal(r.dimensions.nativeCalls.minimumRemaining,4);
 assert.equal(r.stages.find(s=>s.stage==='implementation').minimumCalls,0);
 f.progress={...f.progress,phase:'do_completion',completedStages:['implementation','initial_review','repair','verification','final_review']};
 assert.equal(assessLifecycleCapacity(f).dimensions.nativeCalls.minimumRemaining,0);
});

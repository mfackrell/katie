import test from 'node:test';
import assert from 'node:assert/strict';
import {assessLifecycleCapacity,modelCostMicrousd,STAGES} from '../scripts/benchmark/lifecycle-capacity.mjs';
const now=Date.parse('2026-10-31T18:00:00Z');
export function fixture(){
 const binding={taskId:'task-original',projectId:'project-original',baselineSha:'a'.repeat(40),scopeHash:'b'.repeat(64),contractHash:'c'.repeat(64)};
 const price={status:'verified',source:'verified_model_registry',serviceTier:'default',verifiedAt:now-1000,inputUsdPerMillion:'2.5',outputUsdPerMillion:'14'};
 return {binding,observedAt:now,cohort:binding.scopeHash,progress:{source:'trusted_host',binding,phase:'implementation',completedStages:[]},work:{repairIterations:1,additionalRepairIterations:0},
  observations:Object.entries(STAGES).flatMap(([stage,pool])=>[0,1,2].map(i=>({id:stage+i,stage,source:'verified_phase_receipts',cohort:binding.scopeHash,binding,completed:true,calls:pool==='deterministic'?0:stage==='do_completion'?4:2+i,inputTokens:1000+i*100,outputTokens:100+i*10,seconds:100+i*10}))),
  authorization:{source:'authoritative_test_snapshot',live:true,executionAuthorized:true,deadline:now+14400000,tokens:{cumulativeLimit:625000,accountEncumbered:287895,developmentLimit:448279,developmentEncumbered:171174,completionReserveRemaining:60000,assessmentReserveRemaining:60000},calls:{developmentLimit:32,developmentConsumed:17,completionReserveRemaining:4,assessmentLimit:10,assessmentConsumed:0},money:{complete:true,ceilingMicrousd:'10000000',exposureMicrousd:'5657365'}},
  pricing:{native:price,completion:price,assessment:price},otherApiCostMicrousd:Object.fromEntries(Object.keys(STAGES).map(k=>[k,'0']))};
}
const stage=(r,s)=>r.stages.find(x=>x.stage===s);
test('full lifecycle uses median plus observed contingency and independent resource dimensions',()=>{
 const f=fixture();f.authorization.calls.developmentLimit=100;
 const r=assessLifecycleCapacity(f);assert.equal(r.status,'sufficient');assert.equal(r.stages.length,8);
 assert.deepEqual(stage(r,'implementation').metrics.inputTokens,{expected:1100,contingency:100,projected:1200,samples:3,basis:'upper_median_plus_observed_maximum_difference'});
 assert.equal(r.dimensions.money.authorizedRemaining,'4342635');assert.equal(r.authorization.spendingPermission,'unchanged');
});
test('Take Eleven41139165988: eleven native calls exhausted, four closure calls protected, tokens and dollars available',()=>{
 const f=fixture();f.progress={...f.progress,source:'authenticated_recovery',phase:'repair',checkpointSha:'d'.repeat(40),completedStages:['implementation','initial_review']};
 f.authorization.calls={...f.authorization.calls,developmentLimit:15,developmentConsumed:11};
 const r=assessLifecycleCapacity(f);assert.equal(r.status,'insufficient');assert.ok(r.shortages.includes('nativeCalls'));assert.equal(r.dimensions.nativeCalls.authorizedRemaining,0);assert.equal(r.dimensions.completionCalls.authorizedRemaining,4);
 assert.ok(r.dimensions.nativeTokens.authorizedRemaining>0);assert.ok(BigInt(r.dimensions.money.authorizedRemaining)>0n);assert.equal(stage(r,'implementation').metrics.calls.projected,0);assert.equal(stage(r,'initial_review').status,'completed');
});
test('token surplus never hides call shortage, and call surplus never hides token shortage',()=>{
 const f=fixture();f.authorization.calls.developmentLimit=100;f.authorization.tokens.developmentEncumbered=388278;
 const r=assessLifecycleCapacity(f);assert.ok(r.shortages.includes('nativeTokens'));assert.equal(r.dimensions.nativeTokens.authorizedRemaining,1);assert.equal(r.dimensions.nativeCalls.status,'sufficient');
});
test('monetary exposure includes retained reservations and keeps exact backend precision',()=>{
 const f=fixture();f.authorization.calls.developmentLimit=100;f.authorization.money.exposureMicrousd='9999999';const r=assessLifecycleCapacity(f);
 assert.ok(r.shortages.includes('money'));assert.equal(r.dimensions.money.authorizedRemaining,'1');
 assert.equal(modelCostMicrousd(3,7,{...f.pricing.native,inputUsdPerMillion:'0.123456789012',outputUsdPerMillion:'0.987654321098'},now),'8');
});
test('both protected token reserves are excluded from native headroom',()=>{
 const r=assessLifecycleCapacity(fixture());assert.equal(r.dimensions.nativeTokens.authorizedRemaining,217105);assert.equal(r.protectedReserves.completionTokens,60000);assert.equal(r.protectedReserves.assessmentTokens,60000);
 const f=fixture();f.authorization.tokens.accountEncumbered=505000;assert.equal(assessLifecycleCapacity(f).dimensions.nativeTokens.authorizedRemaining,0);
});
test('authenticated incomplete repair preserves completed phases but requires fresh verification and final review',()=>{
 const f=fixture();f.progress={...f.progress,source:'authenticated_recovery',phase:'repair',completedStages:['implementation','initial_review'],checkpointSha:'d'.repeat(40)};
 const r=assessLifecycleCapacity(f);assert.equal(stage(r,'repair').status,'in_progress');assert.equal(stage(r,'verification').status,'remaining');assert.equal(stage(r,'final_review').status,'remaining');assert.equal(stage(r,'implementation').metrics.inputTokens.projected,0);
});
test('new confirmed repair iterations update demand without creating authority',()=>{
 const f=fixture(),before=assessLifecycleCapacity(f);f.work.additionalRepairIterations=2;const after=assessLifecycleCapacity(f);
 assert.equal(stage(after,'repair').metrics.calls.projected,stage(before,'repair').metrics.calls.projected*3);assert.deepEqual(after.authorization,before.authorization);assert.deepEqual(after.protectedReserves,before.protectedReserves);
});
test('short execution window is independently insufficient',()=>{
 const f=fixture();f.authorization.deadline=now+1000;const r=assessLifecycleCapacity(f);assert.ok(r.shortages.includes('time'));assert.equal(r.dimensions.time.authorizedRemaining,1);
});
test('missing, stale, unverified and unauthorized-tier prices remain unknown',()=>{
 for(const patch of [null,{status:'unverified'},{verifiedAt:now-86400001},{serviceTier:'priority'}]){
  const f=fixture();f.authorization.calls.developmentLimit=100;f.pricing.native=patch?{...f.pricing.native,...patch}:null;const r=assessLifecycleCapacity(f);assert.equal(r.dimensions.money.status,'indeterminate');assert.equal(r.dimensions.money.projectedRemaining,null);
 }
});
test('sparse/missing observations do not fabricate token or duration estimates',()=>{
 const f=fixture();f.observations=f.observations.filter(x=>x.id.endsWith('0'));const r=assessLifecycleCapacity(f);assert.equal(r.dimensions.totalTokens.projectedRemaining,null);assert.equal(r.dimensions.time.projectedRemaining,null);assert.equal(r.status,'indeterminate');
 f.authorization.calls.developmentLimit=15;f.authorization.calls.developmentConsumed=11;assert.ok(assessLifecycleCapacity(f).shortages.includes('nativeCalls'),'known mandatory calls still establish a shortage');
});
test('untrusted or conflicting progress never discounts completed work',()=>{
 for(const change of [{source:'model_claim'},{binding:{...fixture().binding,taskId:'another-task'}},{completedStages:['initial_review']}]){
  const f=fixture();f.authorization.calls.developmentLimit=100;f.progress={...f.progress,completedStages:['implementation','initial_review'],...change};const r=assessLifecycleCapacity(f);assert.ok(r.stages.every(s=>s.status!=='completed'));assert.equal(r.status,'indeterminate');
 }
});
test('expired or unknown authority is never usable permission',()=>{
 const f=fixture();f.authorization.live=false;const r=assessLifecycleCapacity(f);assert.ok(r.shortages.includes('executionAuthority'));assert.equal(r.dimensions.nativeCalls.currentlyUsable,0);
 f.authorization.live=null;f.authorization.executionAuthorized=null;assert.equal(assessLifecycleCapacity(f).dimensions.nativeCalls.currentlyUsable,null);
});
test('missing capacity is not zero; missing other API costs are not free',()=>{
 const f=fixture();delete f.authorization.tokens.completionReserveRemaining;delete f.otherApiCostMicrousd.browser_delivery;const r=assessLifecycleCapacity(f);assert.equal(r.dimensions.nativeTokens.authorizedRemaining,null);assert.equal(r.dimensions.money.projectedRemaining,null);
});
test('forecast is deterministic, read-only, and preserves input authority/history',()=>{
 const f=fixture(),before=structuredClone(f);const freeze=o=>{Object.freeze(o);for(const v of Object.values(o))if(v&&typeof v==='object')freeze(v);};freeze(f);
 assert.deepEqual(assessLifecycleCapacity(f),assessLifecycleCapacity(f));assert.deepEqual(f,before);
});

test('fractional backend monetary exposure retains precision and duplicate samples cannot manufacture confidence',()=>{
 const f=fixture();f.authorization.money.exposureMicrousd='5657365.123456789012';let r=assessLifecycleCapacity(f);assert.equal(r.dimensions.money.authorizedRemaining,'4342634.876543210988');
 f.observations=f.observations.map(x=>({...x,id:x.stage}));r=assessLifecycleCapacity(f);assert.equal(r.dimensions.totalTokens.projectedRemaining,null);
});
test('skipped repair is not required, while new findings after completed repair add only new iterations',()=>{
 const f=fixture();f.progress.notRequiredStages=['repair'];f.work.repairIterations=0;assert.equal(stage(assessLifecycleCapacity(f),'repair').status,'not_required');
 f.progress.completedStages=['implementation','initial_review','repair'];f.progress.notRequiredStages=[];f.work.additionalRepairIterations=1;const r=assessLifecycleCapacity(f);assert.equal(stage(r,'repair').remainingUnits,1);assert.equal(stage(r,'repair').metrics.calls.projected,4);
});

test('planned repairs include each required verification run in deadline demand',()=>{
 const f=fixture();f.authorization.calls.developmentLimit=100;f.authorization.deadline=now+1000000;
 let r=assessLifecycleCapacity(f);assert.equal(stage(r,'verification').remainingUnits,2);assert.equal(stage(r,'verification').metrics.seconds.projected,240);assert.equal(r.dimensions.time.projectedRemaining,1080);assert.ok(r.shortages.includes('time'));
 f.progress.completedStages=['implementation','verification'];r=assessLifecycleCapacity(f);assert.equal(stage(r,'verification').remainingUnits,1);assert.equal(stage(r,'verification').metrics.seconds.projected,120);
 f.progress.completedStages=['implementation','initial_review'];f.progress.phase='repair';r=assessLifecycleCapacity(f);assert.equal(stage(r,'verification').remainingUnits,1);
 f.work.additionalRepairIterations=2;r=assessLifecycleCapacity(f);assert.equal(stage(r,'verification').remainingUnits,3);
 f.work.additionalRepairIterations=0;f.progress.completedStages.push('repair','verification');r=assessLifecycleCapacity(f);assert.equal(stage(r,'verification').remainingUnits,0);
});

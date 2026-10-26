import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateLaunchReadiness} from '../scripts/benchmark/benchmark-715-readiness.mjs';
const manifest=JSON.parse(readFileSync(new URL('../config/benchmark-715-readiness.json',import.meta.url),'utf8'));
const good={
 branchStatus:'FUNCTIONS_DEPLOYED',benchmarkSchemaPresent:true,stagingSeparateFromProduction:true,
 contractHashVerified:true,acceptanceHashVerified:true,baselineSha:manifest.baselineSha,
 modelAndToolsMatched:true,verifiedModel:manifest.model,priceCeilingVerified:true,
 priceCeilingMicrosPerMillion:14_000_000,publishedInputUsdPerMillion:'1.75',
 publishedOutputUsdPerMillion:'14',
 arms:['native','thin','full'].map(arm=>({arm,trialRecorded:true,accountRecorded:true,
 ownerApprovalRecorded:true,deadlineVerified:true,hardUsdCapCents:1000,
 accountTokens:700_000,approvalTokens:700_000,revocationVerified:true})),
 ownerOnlyDispatchVerified:true,durableCheckpointVerified:true,
 privateBrowserVerifierReady:true,independentEvidenceVerifierReady:true,
 canonicalReceiptPathVerified:true
};
test('missing staging evidence must never be treated as ready',()=>{
 const r=validateLaunchReadiness(manifest,{});
 assert.equal(r.ready,false);assert.ok(r.blockers.includes('staging'));
 assert.equal(r.paidExecutionAuthorized,false);
});
test('complete independent prerequisite evidence establishes readiness but not spending permission',()=>{
 const r=validateLaunchReadiness(manifest,good);
 assert.equal(r.ready,true);assert.deepEqual(r.blockers,[]);
 assert.equal(r.paidExecutionAuthorized,false);
});
test('one missing arm approval, USD cap mismatch or broken parity blocks launch',()=>{
 for(const evidence of [
 {...good,arms:good.arms.slice(0,2)},
 {...good,arms:good.arms.map((a,i)=>i===1?{...a,hardUsdCapCents:2000}:a)},
 {...good,modelAndToolsMatched:false},
 {...good,branchStatus:'MIGRATIONS_FAILED'},
 {...good,verifiedModel:'unknown'}
 ])assert.equal(validateLaunchReadiness(manifest,evidence).ready,false);
});
test('cannot enlarge $30 owner approval by modifying launch manifest',()=>{
 const changed={...manifest,totalUsdCeilingCents:5000};
 assert.equal(validateLaunchReadiness(changed,good).ready,false);
});

test('a different baseline or original contract cannot masquerade as approved Take Eleven',()=>{
 for(const changed of [
 {...manifest,baselineSha:'f'.repeat(40)},
 {...manifest,contractIssue:999}
 ])assert.equal(validateLaunchReadiness(changed,{...good,baselineSha:changed.baselineSha}).ready,false);
});
test('a verified price flag alone does not authorize unbounded token accounts',()=>{
 for(const evidence of [
 {...good,priceCeilingMicrosPerMillion:undefined},
 {...good,publishedOutputUsdPerMillion:'15'},
 {...good,arms:good.arms.map((a,i)=>i===0?{...a,accountTokens:800_000}:a)},
 {...good,arms:good.arms.map((a,i)=>i===1?{...a,approvalTokens:800_000}:a)},
 {...good,arms:good.arms.map((a,i)=>i===2?{...a,approvalTokens:undefined}:a)}
 ]) {
  const result=validateLaunchReadiness(manifest,evidence);
  assert.equal(result.ready,false);
  assert.ok(result.blockers.includes('pricing'));
 }
});

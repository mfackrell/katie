import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateLaunchReadiness} from '../scripts/benchmark/benchmark-715-readiness.mjs';
const manifest=JSON.parse(readFileSync(new URL('../config/benchmark-715-readiness.json',import.meta.url),'utf8'));
const good={
 branchStatus:'FUNCTIONS_DEPLOYED',benchmarkSchemaPresent:true,stagingSeparateFromProduction:true,
 contractHashVerified:true,acceptanceHashVerified:true,baselineSha:manifest.baselineSha,
 modelAndToolsMatched:true,verifiedModel:manifest.model,priceCeilingVerified:true,
 arms:['native','thin','full'].map(arm=>({arm,trialRecorded:true,accountRecorded:true,
 ownerApprovalRecorded:true,deadlineVerified:true,hardUsdCapCents:1000,revocationVerified:true})),
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

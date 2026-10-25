import test from 'node:test';
import assert from 'node:assert/strict';
import {validateThreeArmProtocol,reconcileThreeArmTrial,buildReport} from '../scripts/benchmark/three-arm-protocol.mjs';
const hex=(c,n)=>c.repeat(n);
const shared={baselineSha:hex('a',40),contractSha256:hex('b',64),
 acceptanceSha256:hex('c',64),toolProfileSha256:hex('d',64),
 modelPolicySha256:hex('e',64),runtimeSha256:hex('f',64)};
const protocol={...shared,experimentId:'11111111-1111-4111-8111-111111111111',replicate:1,
 tokenCap:1000,trials:['native','thin','full'].map(arm=>({arm,...shared,candidateSha:hex('1',40)}))};
const digest=validateThreeArmProtocol(protocol).protocolDigest;
const record=arm=>({arm,protocolDigest:digest,candidateSha:hex('1',40),
 operations:[{id:arm+'-model-1',stage:'coding',status:'settled',reservedTokens:200,
 actualTokens:140,authoritativeReceipt:'synthetic-fixture-only'}],
 acceptanceChecks:[{...shared,candidateSha:hex('1',40),protected:true,passed:true,
 evidenceId:arm+'-browser-fixture'}]});
test('exactly three matching trial arms required',()=>{
 assert.equal(validateThreeArmProtocol(protocol).replicate,1);
 assert.throws(()=>validateThreeArmProtocol({...protocol,trials:protocol.trials.slice(0,2)}),/THREE_ARMS/);
 assert.throws(()=>validateThreeArmProtocol({...protocol,trials:protocol.trials.map((x,i)=>i===1?{...x,toolProfileSha256:hex('0',64)}:x)}),/INCOMPARABLE/);
});
test('canonical operation counted once; all three acceptance checks protected',()=>{
 const report=buildReport(protocol,['native','thin','full'].map(record));
 assert.equal(report.accepted,true);
 assert.equal(report.paidExecutionAuthorized,false);
 assert.equal(report.results.reduce((n,x)=>n+x.actualTokens,0),420);
});
test('unknown charges block accepted reports without making reservations disappear',()=>{
 const r=['native','thin','full'].map(record);r[1].operations.push({id:'unknown',stage:'recovery',status:'unresolved',reservedTokens:50});
 const result=buildReport(protocol,r);
 assert.equal(result.accepted,false);
 assert.equal(result.results[1].unresolvedHeldTokens,50);
});
test('missing, altered, duplicate or untrusted cost receipt fails closed',()=>{
 const r=['native','thin','full'].map(record);
 assert.throws(()=>reconcileThreeArmTrial(protocol,r.slice(0,2)),/MISSING_ARM/);
 r[0].operations.push({...r[0].operations[0]});
 assert.throws(()=>reconcileThreeArmTrial(protocol,r),/DUPLICATE_OPERATION/);
 r[0].operations.pop();delete r[0].operations[0].authoritativeReceipt;
 assert.throws(()=>reconcileThreeArmTrial(protocol,r),/UNVERIFIED_PROVIDER_RECEIPT/);
});
test('altered contract/candidate review cannot pass',()=>{
 const r=['native','thin','full'].map(record);
 r[2].acceptanceChecks[0].protected=false;
 assert.equal(buildReport(protocol,r).accepted,false);
 r[2].candidateSha=hex('2',40);
 assert.throws(()=>buildReport(protocol,r),/IDENTITY_MISMATCH/);
});

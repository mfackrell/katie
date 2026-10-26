import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {validateThreeArmProtocol,reconcileThreeArmTrial,buildReport,buildVerifiedReport} from '../scripts/benchmark/three-arm-protocol.mjs';
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
 assert.equal(report.accepted,false);
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

test('null candidate, empty operations, and forged evidence never pass',()=>{
 const records=['native','thin','full'].map(record);
 for(const r of records){r.candidateSha=null;r.operations=[];r.acceptanceChecks=[{
  contractSha256:protocol.contractSha256,acceptanceSha256:protocol.acceptanceSha256,
  candidateSha:null,protected:true,passed:true,evidenceId:'forged'}];}
 const forgedProtocol={...protocol,trials:protocol.trials.map(t=>({...t,candidateSha:null}))};
 const report=buildReport(forgedProtocol,records);
 assert.equal(report.accepted,false);
 assert.equal(report.comparisonValid,false);
});
test('only a trusted journal and correctly signed complete verifier matrix may pass',async()=>{
 const records=['native','thin','full'].map(record);
 const keys=generateKeyPairSync('ed25519');
 const checks=['deterministic','browser','independent-review'];
 const evidence=Object.fromEntries(records.map(r=>{
  const payload={arm:r.arm,candidateSha:r.candidateSha,protocolDigest:digest,
   acceptanceSha256:protocol.acceptanceSha256,verifierId:'independent-verifier',
   checks:checks.map(id=>({id,passed:true,candidateSha:r.candidateSha,
    evidenceId:r.arm+'-'+id,verifierId:'independent-verifier'}))};
  return [r.arm,{...payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),keys.privateKey).toString('base64')}];
 }));
 const deps={loadAuthority:async()=>({protocolDigest:digest,
  acceptanceSha256:protocol.acceptanceSha256,expectedCheckIds:checks}),
  loadEvidence:async(_exp,_rep,arm)=>evidence[arm],
  loadOperations:async(_exp,_rep,arm)=>records.find(r=>r.arm===arm).operations,
  verifierPublicKey:keys.publicKey};
 assert.equal((await buildVerifiedReport(protocol,records,deps)).accepted,true);
 assert.equal((await buildVerifiedReport(protocol,records)).accepted,false);
 evidence.native.checks[0].passed=false;
 assert.equal((await buildVerifiedReport(protocol,records,deps)).accepted,false);
 evidence.native.checks[0].passed=true;
 evidence.native.signature='forged';
 assert.equal((await buildVerifiedReport(protocol,records,deps)).accepted,false);
 evidence.native.signature=sign(null,Buffer.from(JSON.stringify((({signature,...v})=>v)(evidence.native))),keys.privateKey).toString('base64');
 const missing={...deps,loadOperations:async(_e,_r,arm)=>arm==='native'?[]:deps.loadOperations(_e,_r,arm)};
 assert.equal((await buildVerifiedReport(protocol,records,missing)).accepted,false);
});

test('failed over-cap trial remains visible without false comparison success',()=>{
 const r=['native','thin','full'].map(record);
 r[2].operations[0].actualTokens=1200;
 const report=buildReport(protocol,r);
 assert.equal(report.accepted,false);
 assert.equal(report.comparisonValid,false);
 assert.equal(report.results.length,3);
 assert.equal(report.results.find(x=>x.arm==='full').status,'overrun');
 assert.equal(report.results.find(x=>x.arm==='full').actualTokens,1200);
});

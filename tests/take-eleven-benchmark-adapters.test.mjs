import test from 'node:test';
import assert from 'node:assert/strict';
import {adapterPreflight,authorizeBenchmarkPair,TAKE_ELEVEN_ARMS} from '../scripts/benchmark/take-eleven-adapters.mjs';
test('both arms bind to existing distinct execution engines',()=>{
 assert.equal(TAKE_ELEVEN_ARMS.direct.workflow,'.github/workflows/autonomous-development.yml');
 assert.equal(TAKE_ELEVEN_ARMS.orchestrated.source,'lib/projects/worker.ts');
 assert.notEqual(TAKE_ELEVEN_ARMS.direct.engine,TAKE_ELEVEN_ARMS.orchestrated.engine);
});
test('missing provider budget enforcement blocks both paths',()=>{
 const caps={isolatedBranchCheckout:true,isolatedProject:true,providerUsageReceipt:true,immutableAcceptance:true,ownerApprovalVerifier:true};
 const result=authorizeBenchmarkPair({direct:caps,orchestrated:caps});
 assert.equal(result.ready,false);
 assert.ok(result.direct.missing.includes('serverSideTokenCap'));
 assert.ok(result.orchestrated.missing.includes('serverSideTokenCap'));
});
test('one ready arm cannot authorize a one-sided paid benchmark',()=>{
 const full={isolatedBranchCheckout:true,isolatedProject:true,serverSideTokenCap:true,providerUsageReceipt:true,immutableAcceptance:true,ownerApprovalVerifier:true};
 assert.equal(authorizeBenchmarkPair({direct:full,orchestrated:{}}).ready,false);
 assert.equal(authorizeBenchmarkPair({direct:full,orchestrated:full}).ready,true);
});
test('unknown engine fails closed',()=>assert.throws(()=>adapterPreflight('fake',{})));

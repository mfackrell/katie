import test from 'node:test';
import assert from 'node:assert/strict';
import {sealNativeProductionRuntime,openNativeProductionRuntime} from '../scripts/benchmark/native-runtime-capsule.mjs';
import {encodeNativeHandoff,readNativeHandoff} from '../scripts/benchmark/native-dispatch-contract.mjs';
const key='synthetic-native-signing-key-32-characters';
const now=Date.now();
const proof={taskId:'11111111-1111-4111-8111-111111111111',trialId:'22222222-2222-4222-8222-222222222222',approvalId:'33333333-3333-4333-8333-333333333333',projectId:'44444444-4444-4444-8444-444444444444',contractHash:'a'.repeat(64),benchmarkContractHash:'b'.repeat(64),baselineSha:'c'.repeat(40),expiresAt:now+600000};
const secret='synthetic-production-service-credential';
test('production runtime survives authenticated handoff while no plaintext credential enters transport',()=>{
 const productionRuntime=sealNativeProductionRuntime(secret,proof,key,now);
 const body=encodeNativeHandoff({...proof,productionRuntime},key);
 assert.ok(!body.includes(secret));assert.ok(!Buffer.from(body.split(':')[1].split('.')[0],'base64url').toString().includes(secret));
 const verified=readNativeHandoff(body,key,now);
 assert.deepEqual(openNativeProductionRuntime(verified.productionRuntime,verified,key,now),{url:'https://barclcqataqyvifoeyop.supabase.co',serviceRoleKey:secret});
 assert.notEqual(productionRuntime,sealNativeProductionRuntime(secret,proof,key,now));
});
test('capsule rejects wrong key, tampering, expiry and every changed authority field',()=>{
 const sealed=sealNativeProductionRuntime(secret,proof,key,now);
 for(const field of Object.keys(proof)){
  const changed={...proof,[field]:field==='expiresAt'?proof.expiresAt+1:proof[field]+'x'};
  assert.throws(()=>openNativeProductionRuntime(sealed,changed,key,now),/RUNTIME_INVALID/);
 }
 for(const [value,k,time] of [[sealed,key+'x',now],[sealed+'x',key,now],[sealed,key,proof.expiresAt],[sealed,key,now-1800001]])
  assert.throws(()=>openNativeProductionRuntime(value,proof,k,time),/RUNTIME_INVALID/);
 assert.throws(()=>readNativeHandoff(encodeNativeHandoff({...proof,productionRuntime:sealed},key),key+'x',now),/UNAUTHENTICATED/);
});
test('legacy staging handoff stays capsule-free and invalid runtime metadata is rejected',()=>{
 const legacy=readNativeHandoff(encodeNativeHandoff(proof,key),key,now);
 assert.equal(legacy.productionRuntime,undefined);
 assert.throws(()=>readNativeHandoff(encodeNativeHandoff({...proof,productionRuntime:'https://other.invalid'},key),key,now),/INVALID/);
});

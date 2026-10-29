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
test('continuation identity is signed and cryptographically bound to the production capsule',()=>{
 const continuationId='55555555-5555-4555-8555-555555555555',p={...proof,continuationId};
 const productionRuntime=sealNativeProductionRuntime(secret,p,key,now);
 const verified=readNativeHandoff(encodeNativeHandoff({...p,productionRuntime},key),key,now);
 assert.equal(verified.continuationId,continuationId);
 assert.equal(openNativeProductionRuntime(productionRuntime,verified,key,now).serviceRoleKey,secret);
 assert.throws(()=>openNativeProductionRuntime(productionRuntime,proof,key,now),/RUNTIME_INVALID/);
 assert.throws(()=>openNativeProductionRuntime(productionRuntime,{...p,continuationId:'66666666-6666-4666-8666-666666666666'},key,now),/RUNTIME_INVALID/);
 assert.throws(()=>encodeNativeHandoff({...proof,continuationId:'not-an-id'},key),/INVALID/);
});

test('startup recovery identity survives signed transport and cannot be substituted in its capsule',()=>{
 const startupRecoveryId='77777777-7777-4777-8777-777777777777';
 const p={...proof,continuationId:'55555555-5555-4555-8555-555555555555',startupRecoveryId};
 const productionRuntime=sealNativeProductionRuntime(secret,p,key,now);
 const verified=readNativeHandoff(encodeNativeHandoff({...p,productionRuntime},key),key,now);
 assert.equal(verified.startupRecoveryId,startupRecoveryId);
 assert.equal(openNativeProductionRuntime(productionRuntime,verified,key,now).serviceRoleKey,secret);
 for(const replacement of [undefined,'88888888-8888-4888-8888-888888888888'])
  assert.throws(()=>openNativeProductionRuntime(productionRuntime,{...p,startupRecoveryId:replacement},key,now),/RUNTIME_INVALID/);
 assert.throws(()=>encodeNativeHandoff({...p,startupRecoveryId:'not-an-id'},key),/INVALID/);
});


test('owner development renewal is signed and bound to the production capsule',()=>{
 const developmentRenewalId='88888888-8888-4888-8888-888888888888';
 const p={...proof,continuationId:'55555555-5555-4555-8555-555555555555',developmentRenewalId};
 const productionRuntime=sealNativeProductionRuntime(secret,p,key,now);
 const verified=readNativeHandoff(encodeNativeHandoff({...p,productionRuntime},key),key,now);
 assert.equal(verified.developmentRenewalId,developmentRenewalId);
 assert.equal(openNativeProductionRuntime(verified.productionRuntime,verified,key,now).serviceRoleKey,secret);
 assert.throws(()=>openNativeProductionRuntime(productionRuntime,{...verified,developmentRenewalId:'99999999-9999-4999-8999-999999999999'},key,now),/INVALID/);
});


test('pregrant recovery transport requires renewal and binds the exact recovery identity',()=>{
 const pregrantRecoveryId='99999999-9999-4999-8999-999999999999';
 const p={...proof,continuationId:'55555555-5555-4555-8555-555555555555',developmentRenewalId:'88888888-8888-4888-8888-888888888888',pregrantRecoveryId};
 const capsule=sealNativeProductionRuntime(secret,p,key,now);
 const verified=readNativeHandoff(encodeNativeHandoff({...p,productionRuntime:capsule},key),key,now);
 assert.equal(verified.pregrantRecoveryId,pregrantRecoveryId);
 assert.throws(()=>openNativeProductionRuntime(capsule,{...p,pregrantRecoveryId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},key,now));
 assert.throws(()=>encodeNativeHandoff({...p,developmentRenewalId:undefined},key));
 assert.throws(()=>encodeNativeHandoff({...p,startupRecoveryId:pregrantRecoveryId},key));
});

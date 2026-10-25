import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeNativeHandoff,readNativeHandoff} from '../scripts/benchmark/native-dispatch-contract.mjs';
const key='test-only-key-'+('x'.repeat(64));
const payload={taskId:'11111111-1111-4111-8111-111111111111',
 trialId:'22222222-2222-4222-8222-222222222222',
 approvalId:'33333333-3333-4333-8333-333333333333',
 projectId:'44444444-4444-4444-8444-444444444444',
 contractHash:'a'.repeat(64),baselineSha:'b'.repeat(40),
 expiresAt:Date.now()+60000};
test('owner-approved Developer handoff survives exact signed transport',()=>{
 const signed=encodeNativeHandoff(payload,key);
 assert.deepEqual(readNativeHandoff(signed,key),{version:1,...payload});
 assert.throws(()=>readNativeHandoff(signed,key+'wrong'),/UNAUTHENTICATED/);
 assert.throws(()=>readNativeHandoff(signed+signed,key),/DUPLICATED/);
});
test('expired, altered, or unsigned trial dispatch cannot execute',()=>{
 const signed=encodeNativeHandoff(payload,key);
 assert.throws(()=>readNativeHandoff(signed,key,payload.expiresAt+1),/INVALID/);
 assert.throws(()=>readNativeHandoff(signed.replace('katie-native-benchmark','katie-native-bench'),'key'),/MISSING_OR_DUPLICATED/);
 assert.throws(()=>encodeNativeHandoff({...payload,taskId:'forged'},key),/INVALID/);
});

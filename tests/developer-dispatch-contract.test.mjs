import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {encodeDeveloperHandoff,readDeveloperHandoff} from '../scripts/benchmark/developer-dispatch-contract.mjs';
import {readNativeHandoff} from '../scripts/benchmark/native-dispatch-contract.mjs';
const now=1700000000000,key='synthetic-only-owner-handoff-key-no-provider-access';
const payload=()=>({taskId:randomUUID(),projectId:randomUUID(),approvalId:randomUUID(),accountId:randomUUID(),scopeHash:'a'.repeat(64),contractHash:'b'.repeat(64),baselineSha:'c'.repeat(40),releaseSha:'d'.repeat(40),expiresAt:now+1000});
test('ordinary signed authority roundtrips without benchmark identity',()=>{
 const p=payload(),text=encodeDeveloperHandoff(p,key,now),read=readDeveloperHandoff(text,key,now);
 assert.deepEqual(read,{version:1,authorityKind:'ordinary-developer',...p});assert.ok(Object.isFrozen(read));
 assert.throws(()=>readNativeHandoff(text,key,now),/MISSING/);
});
test('ordinary handoffs reject stale, unsigned, duplicate and mixed authority',()=>{
 const text=encodeDeveloperHandoff(payload(),key,now);
 assert.throws(()=>readDeveloperHandoff(text,key,now+1000),/INVALID/);
 assert.throws(()=>readDeveloperHandoff(text,'another-synthetic-key-that-is-long-enough',now),/UNAUTHENTICATED/);
 assert.throws(()=>readDeveloperHandoff(text+text,key,now),/DUPLICATED/);
 assert.throws(()=>readDeveloperHandoff(text+'<!-- katie-native-benchmark:a.b -->',key,now),/MIXED/);
});
test('every identity, scope, release and resource authority reference is signed',()=>{
 const text=encodeDeveloperHandoff(payload(),key,now),match=text.match(/:([\w-]+)\.([\w-]+) -->/);
 for(const field of ['taskId','projectId','approvalId','accountId','scopeHash','contractHash','baselineSha','releaseSha','expiresAt']){
  const p=JSON.parse(Buffer.from(match[1],'base64url'));p[field]=field==='expiresAt'?now+2000:'f'.repeat(40);
  const altered=text.replace(match[1],Buffer.from(JSON.stringify(p)).toString('base64url'));
  assert.throws(()=>readDeveloperHandoff(altered,key,now),/UNAUTHENTICATED/,field);
 }
});
test('even correctly signed payloads cannot mix authority kinds or hidden fields',()=>{
 for(const extra of [{trialId:randomUUID()},{continuationId:randomUUID()},{authorityKind:'benchmark'},{budget:99999},{version:2}]){
  assert.throws(()=>encodeDeveloperHandoff({...payload(),...extra},key,now),/INVALID/);
 }
 const p={version:1,authorityKind:'ordinary-developer',...payload(),trialId:randomUUID()},content=Buffer.from(JSON.stringify(p)).toString('base64url');
 const sig=createHmac('sha256',key).update('katie:ordinary-developer:handoff:v1\0'+content).digest('base64url');
 assert.throws(()=>readDeveloperHandoff('<!-- katie-native-developer:'+content+'.'+sig+' -->',key,now),/INVALID/);
});

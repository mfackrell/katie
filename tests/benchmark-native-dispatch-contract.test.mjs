import test from 'node:test';
import assert from 'node:assert/strict';
import {packDevelopmentRequest,unpackDevelopmentRequest} from '../scripts/request-envelope.mjs';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
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

test('signed native Developer handoff survives existing compressed owner issue transport',()=>{
 const marker='<!-- katie-managed-task:'+payload.taskId+' -->';
 const project={projectId:payload.projectId,contractHash:payload.contractHash,baselineSha:payload.baselineSha};
 const body=marker+'\n\n'+encodeNativeHandoff(payload,key)+'\n'+
  '<!-- katie-project: '+Buffer.from(JSON.stringify(project)).toString('base64url')+' -->\n'+
  'Approved engineering objective. '.repeat(3500);
 const packed=packDevelopmentRequest(body,marker);
 assert.notEqual(packed,body);
 const restored=unpackDevelopmentRequest(packed);
 assert.equal(restored,body);
 const root=mkdtempSync(join(tmpdir(),'native-issue-handoff-'));
 try{
  const issue=join(root,'AGENT_REQUEST.md'),output=join(root,'native.json');
  writeFileSync(issue,restored);
  const run=spawnSync(process.execPath,['scripts/benchmark/native-dispatch-cli.mjs','verify',issue,output],
   {encoding:'utf8',env:{...process.env,KATIE_NATIVE_HANDOFF_HMAC_KEY:key}});
  assert.equal(run.status,0,run.stderr);
  const manifest=JSON.parse(readFileSync(output,'utf8'));
  assert.equal(manifest.native,true);
  assert.equal(manifest.taskId,payload.taskId);
 }finally{rmSync(root,{recursive:true,force:true})}
});

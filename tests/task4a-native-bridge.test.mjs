import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {encodeDeveloperHandoff,readDeveloperHandoff} from '../scripts/benchmark/developer-dispatch-contract.mjs';
import {forwardAuthorizedModelRequest} from '../scripts/benchmark/authenticated-native-gateway.mjs';

const id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const task='b1111111-1111-4111-8111-111111111111';
const authority='c2222222-2222-4222-8222-222222222222';
const key='Task4A nonbillable HMAC fixture, not a real key!';
const proof={
 authorityKind:'task4a-developer',task4aContinuationId:authority,
 taskId:task,projectId:id,approvalId:'d3333333-3333-4333-8333-333333333333',
 accountId:'e4444444-4444-4444-8444-444444444444',
 scopeHash:'a'.repeat(64),contractHash:'b'.repeat(64),
 baselineSha:'c'.repeat(40),releaseSha:'d'.repeat(40),
 expiresAt:Date.now()+180000
};
test('Task4A handoff is signed separately and bound to original project and continuation',()=>{
 const signed=encodeDeveloperHandoff(proof,key);
 assert.match(signed,/<!-- katie-native-task4a:/);
 const saved=readDeveloperHandoff(signed,key);
 assert.equal(saved.authorityKind,'task4a-developer');
 assert.equal(saved.task4aContinuationId,authority);
 assert.equal(saved.projectId,id);
 const {task4aContinuationId:unused,...ordinary}=proof;
 const old=encodeDeveloperHandoff({...ordinary,authorityKind:'ordinary-developer'},key);
 assert.match(old,/<!-- katie-native-developer:/);
 assert.equal(readDeveloperHandoff(old,key).authorityKind,'ordinary-developer');
 assert.throws(()=>readDeveloperHandoff(signed.replace('katie-native-task4a','katie-native-developer'),key));
 assert.throws(()=>readDeveloperHandoff(signed.replace(/\.[A-Za-z0-9_-]+ -->$/,'.AAAA -->'),key));
 assert.throws(()=>readDeveloperHandoff(signed,key+'different'));
 assert.throws(()=>readDeveloperHandoff(signed+' '+old,key),/DUPLICATED_OR_MIXED/);
 assert.throws(()=>encodeDeveloperHandoff({...proof,task4aContinuationId:'forged'},key));
 assert.throws(()=>encodeDeveloperHandoff({...proof,expiresAt:Date.now()-1},key));
});
test('trusted workflow recognizes Task4A signed host; no plain Codex fallback',()=>{
 const workflow=readFileSync('.github/workflows/autonomous-development.yml','utf8');
 const cli=readFileSync('scripts/benchmark/native-dispatch-cli.mjs','utf8');
 const host=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
 assert.match(workflow,/katie-native-\(benchmark\|developer\|task4a\)/);
 assert.match(cli,/developer\|task4a/);
 assert.match(cli,/task4a-developer/);
 assert.match(host,/task4a_native_reconcile_provider_usage/);
 assert.match(host,/task4a_native_live/);
 assert.match(host,/task4a,executionEpoch/);
 assert.match(workflow,/if: steps\.task\.outputs\.native != 'true'\n        uses: openai\/codex-action@v1/);
});
function synthetic({authorized=true,reservation=true,receipt=true,providerResponse=true}={}){
 const events=[];
 const db={rpc:async(name,args)=>{
  events.push(name);
  if(name==='task4a_native_live')return{data:authorized,error:null};
  if(name==='task4a_native_reserve')return{data:reservation?'operation-1':null,error:null};
  return{data:null,error:Error('unexpected '+name)};
 }};
 const upstream=async()=>{events.push('upstream');return providerResponse
  ?{providerRequestId:'response-1',actualTokens:32,usage:{input_tokens:12,output_tokens:20,total_tokens:32}}
  :{providerRequestId:null,actualTokens:null};};
 upstream.nonbillableFixture=true;
 const call=()=>forwardAuthorizedModelRequest({
  db,grantToken:'synthetic-grant-no-provider',trialId:null,developerProjectId:id,task4a:true,
  executionEpoch:1,model:'gpt-5.3-codex',requestBody:{model:'gpt-5.3-codex',input:[],max_output_tokens:20},
  upperTokens:120,upstream,providerNamespace:'openai-responses',
  recordReceipt:async({providerRequestId,usage})=>{
   events.push('receipt');
   if(!receipt||providerRequestId!=='response-1'||usage.total_tokens!==32)throw Error('receipt denied');
  }
 });
 return{events,call};
}
test('Task4A gateway proves authorization and reserve precede a synthetic provider call',async()=>{
 const s=synthetic();const outcome=await s.call();
 assert.equal(outcome.providerRequestId,'response-1');
 assert.deepEqual(s.events,['task4a_native_live','task4a_native_reserve','upstream','receipt']);
});
test('missing owner grant and refused per-call reservation never contact provider',async()=>{
 for(const options of [{authorized:false},{reservation:false}]){
  const s=synthetic(options);
  await assert.rejects(s.call(),/GATEWAY_EXECUTION_STOPPED|GATEWAY_ADMISSION_DENIED/);
  assert.equal(s.events.includes('upstream'),false);
 }
});
test('missing provider receipt cannot count as accepted execution',async()=>{
 for(const options of [{receipt:false},{providerResponse:false}]){
  const s=synthetic(options);
  await assert.rejects(s.call(),/GATEWAY_UPSTREAM_UNCERTAIN/);
  assert.deepEqual(s.events.slice(0,3),['task4a_native_live','task4a_native_reserve','upstream']);
 }
});
test('ordinary and benchmark modes retain their original RPCs',async()=>{
 for(const variant of [
  {trialId:null,developerProjectId:id,task4a:false,live:'developer_gateway_execution_live',reserve:'developer_native_reserve'},
  {trialId:authority,developerProjectId:null,task4a:false,live:'benchmark_gateway_execution_live',reserve:'benchmark_grant_reserve'}
 ]){
  const events=[],db={rpc:async name=>{events.push(name);return{data:name===variant.live?true:'call-id',error:null};}};
  const upstream=async()=>({providerRequestId:'provider',actualTokens:1,usage:{total_tokens:1}});
  upstream.nonbillableFixture=true;
  await forwardAuthorizedModelRequest({...variant,db,grantToken:'synthetic',
   executionEpoch:1,model:'gpt-5.3-codex',
   requestBody:{model:'gpt-5.3-codex',input:[],max_output_tokens:1},upperTokens:20,
   upstream,providerNamespace:'openai-responses',recordReceipt:async()=>{}});
  assert.deepEqual(events,[variant.live,variant.reserve]);
 }
});

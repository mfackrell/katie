import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,rmSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {encodeDeveloperHandoff,readDeveloperHandoff,classifyDeveloperDispatchAuthority} from '../scripts/benchmark/developer-dispatch-contract.mjs';
import {encodeNativeHandoff} from '../scripts/benchmark/native-dispatch-contract.mjs';
import {projectMarker,contractHash} from '../scripts/project-context.mjs';
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
test('Task4A can never classify an unbound grant as ordinary development',()=>{
 const original='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
 assert.throws(()=>classifyDeveloperDispatchAuthority(original,{version:'ordinary-developer-v1'}),/TASK4A_BOUND_OWNER_AUTHORITY_REQUIRED/);
 assert.throws(()=>classifyDeveloperDispatchAuthority(original,{task4aContinuationId:'bad'}),/TASK4A_BOUND_OWNER_AUTHORITY_REQUIRED/);
 assert.deepEqual(classifyDeveloperDispatchAuthority(original,{task4aContinuationId:authority}),
   {authorityKind:'task4a-developer',task4aContinuationId:authority});
 assert.deepEqual(classifyDeveloperDispatchAuthority(randomUUID(),{version:'ordinary-developer-v1'}),
   {authorityKind:'ordinary-developer'});
 assert.throws(()=>classifyDeveloperDispatchAuthority(randomUUID(),{task4aContinuationId:authority}),/FOREIGN_TASK4A_AUTHORITY_DENIED/);
 const code=readFileSync('lib/agents/development.ts','utf8');
 assert.match(code,/classifyDeveloperDispatchAuthority\(c\.projectId,a\.developer_authority\)/);
 assert.match(code,/task4a_native_authority_ready/);
 assert.match(code,/if\(verified\.error\|\|verified\.data!==true\)continue/);
});
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
  db,grantToken:'x'.repeat(40),trialId:null,developerProjectId:id,task4a:true,
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
  await forwardAuthorizedModelRequest({...variant,db,grantToken:'x'.repeat(40),
   executionEpoch:1,model:'gpt-5.3-codex',
   requestBody:{model:'gpt-5.3-codex',input:[],max_output_tokens:1},upperTokens:20,
   upstream,providerNamespace:'openai-responses',recordReceipt:async()=>{}});
  assert.deepEqual(events,[variant.live,variant.reserve]);
 }
});


test('trusted workflow fails closed for an original Task4A project without an authentic signed native grant',()=>{
 const workflow=readFileSync('.github/workflows/autonomous-development.yml','utf8');
 const parseAt=workflow.indexOf('node scripts/project-context.mjs prepare ');
 const gateAt=workflow.indexOf('node scripts/benchmark/task4a-native-gate.mjs ');
 const unmeteredAt=workflow.indexOf('        uses: openai/codex-action@v1');
 assert.ok(parseAt>=0&&gateAt>parseAt&&unmeteredAt>gateAt,
  'The executable original-project authority gate must run after trusted project parsing and before any unmetered action');
 const dir=mkdtempSync(join(tmpdir(),'task4a-native-guard-'));
 const requestFile=join(dir,'original-request.md'),manifestFile=join(dir,'verified-manifest.json'),
  contextFile=join(dir,'validated-project.json');
 const contract={path:'/pilot',scenarios:[{name:'state transition',steps:[
  {action:'click',selector:'#advance'},
  {action:'expectText',selector:'#state',value:'Ready'}
 ]}]};
 const project=id=>({
  version:1,projectId:id,baseSha:'a'.repeat(40),baselineSha:'b'.repeat(40),
  allowedPaths:['app/pilot/'],contractHash:contractHash(contract),contract,
  codingModel:'gpt-5.3-codex',reviewModel:'gpt-5.3-codex'
 });
 const run=(request)=>{
  rmSync(manifestFile,{force:true});rmSync(contextFile,{force:true});
  writeFileSync(requestFile,request);
  const env={...process.env,KATIE_NATIVE_HANDOFF_HMAC_KEY:key};
  const cli=spawnSync(process.execPath,['scripts/benchmark/native-dispatch-cli.mjs','verify',requestFile,manifestFile],
   {encoding:'utf8',env,timeout:10000});
  if(cli.status!==0)return {cli};
  const parser=spawnSync(process.execPath,['scripts/project-context.mjs','prepare',requestFile],
   {encoding:'utf8',env,timeout:10000});
  if(parser.status!==0)return {cli,parser};
  writeFileSync(contextFile,parser.stdout);
  const guard=spawnSync(process.execPath,['scripts/benchmark/task4a-native-gate.mjs',requestFile,contextFile,manifestFile],
   {encoding:'utf8',env,timeout:10000});
  return {cli,parser,guard,manifest:JSON.parse(readFileSync(manifestFile,'utf8'))};
 };
 const header=p=>'<!-- katie-managed-task:'+task+' -->\n\n'+projectMarker(p)+'\n\n';
 const original=project(id),originalHeader=header(original);
 const permission={...proof,contractHash:original.contractHash,baselineSha:original.baselineSha,expiresAt:Date.now()+300000};
 const signed=encodeDeveloperHandoff(permission,key);
 try{
  const approved=run(originalHeader+signed);
  assert.equal(approved.cli.status,0,approved.cli.stderr);
  assert.equal(approved.parser.status,0,approved.parser.stderr);
  assert.equal(approved.manifest.native,true);
  assert.equal(approved.guard.status,0,approved.guard.stderr);

  const stripped=run(originalHeader);
  assert.equal(stripped.cli.status,0);
  assert.equal(stripped.manifest.native,false);
  assert.notEqual(stripped.guard.status,0,'Stripped Task4A marker must never select the unmetered action');
  assert.match(stripped.guard.stderr,/TASK4A_NATIVE_AUTHORITY_REQUIRED/);

  const {task4aContinuationId:discarded,...ordinaryPermission}=permission;
  const wrongKind=run(originalHeader+encodeDeveloperHandoff({...ordinaryPermission,authorityKind:'ordinary-developer'},key));
  assert.equal(wrongKind.cli.status,0);
  assert.equal(wrongKind.manifest.native,true);
  assert.notEqual(wrongKind.guard.status,0);
  assert.match(wrongKind.guard.stderr,/TASK4A_NATIVE_AUTHORITY_REQUIRED/);

  const tampered=run(originalHeader+signed.replace(/\.[A-Za-z0-9_-]+ -->$/,'.AAAA -->'));
  assert.notEqual(tampered.cli.status,0,'Invalid HMAC must fail in native verifier');
  assert.match(tampered.cli.stderr,/UNAUTHENTICATED/);
  const mismatched=run(originalHeader+encodeDeveloperHandoff({...permission,projectId:randomUUID()},key));
  assert.notEqual(mismatched.cli.status,0,'An authentic grant for another project must not pass');

  // The second cryptographic check rejects a fabricated verified-manifest
  // file even if a hostile caller bypassed the native CLI in a local test.
  writeFileSync(requestFile,originalHeader);
  writeFileSync(contextFile,JSON.stringify(original));
  writeFileSync(manifestFile,JSON.stringify(approved.manifest));
  const forged=spawnSync(process.execPath,['scripts/benchmark/task4a-native-gate.mjs',requestFile,contextFile,manifestFile],
   {encoding:'utf8',env:{...process.env,KATIE_NATIVE_HANDOFF_HMAC_KEY:key},timeout:10000});
  assert.notEqual(forged.status,0,'A forged manifest is not an authenticated native grant');

  const other=project(randomUUID());
  const ordinaryOther=run(header(other)+encodeDeveloperHandoff({
   ...ordinaryPermission,authorityKind:'ordinary-developer',projectId:other.projectId,contractHash:other.contractHash,baselineSha:other.baselineSha
  },key));
  assert.equal(ordinaryOther.cli.status,0,ordinaryOther.cli.stderr);
  assert.equal(ordinaryOther.guard.status,0,ordinaryOther.guard.stderr);

  const benchmarkProject={...project(randomUUID()),benchmarkContractHash:'f'.repeat(64)};
  const benchmark=run(header(benchmarkProject)+encodeNativeHandoff({
   taskId:randomUUID(),trialId:randomUUID(),approvalId:randomUUID(),
   projectId:benchmarkProject.projectId,contractHash:benchmarkProject.contractHash,
   benchmarkContractHash:benchmarkProject.benchmarkContractHash,
   baselineSha:benchmarkProject.baselineSha,expiresAt:Date.now()+300000
  },key));
  assert.equal(benchmark.cli.status,0,benchmark.cli.stderr);
  assert.equal(benchmark.guard.status,0,benchmark.guard.stderr);

  const ordinaryPlain=run('Owner-authored ordinary coding issue with no managed project');
  assert.equal(ordinaryPlain.cli.status,0);
  assert.equal(ordinaryPlain.manifest.native,false);
  assert.equal(ordinaryPlain.guard.status,0,ordinaryPlain.guard.stderr);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {issueNonFullTrustedGrant} from '../scripts/benchmark/nonfull-trusted-grant.mjs';
import {createNonFullTrustedGateway} from '../scripts/benchmark/nonfull-trusted-gateway.mjs';
import {forwardAuthorizedModelRequest,tokenDigest} from '../scripts/benchmark/authenticated-native-gateway.mjs';
function fixtures(arm){
 const trial={id:arm+'-trial',arm,state:'qualified',owner_actor_id:'actor',
  experiment_id:'11111111-1111-4111-8111-111111111111',replicate:1,
  contract_sha256:'c'.repeat(64),baseline_sha:'b'.repeat(40),
  model_policy_sha256:'d'.repeat(64),tool_profile_sha256:'e'.repeat(64),
  runtime_sha256:'f'.repeat(64),acceptance_sha256:'a'.repeat(64)};
 const account={id:arm+'-account',arm,trial_id:trial.id,owner_actor_id:'actor',cap_tokens:20000};
 const approval={id:arm+'-approval',trial_id:trial.id,account_id:account.id,
  actor_id:'actor',chat_id:'chat',owner_id:'owner',repository:'mfackrell/katie',
  model:'synthetic',max_tokens:20000,deadline:'2099-01-01T00:00:00Z',
  task_id:null,project_id:null,mission_assignment_id:null};
 const identity={experimentId:trial.experiment_id,replicate:1,
  baselineSha:trial.baseline_sha,contractSha256:trial.contract_sha256,
  acceptanceSha256:trial.acceptance_sha256,toolProfileSha256:trial.tool_profile_sha256,
  modelPolicySha256:trial.model_policy_sha256,runtimeSha256:trial.runtime_sha256,tokenCap:20000};
 approval.protocol_digest=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
 return {arm,trial,account,approval,ownerId:'owner',repository:'mfackrell/katie'};
}
for(const arm of ['native','thin']){
 test(arm+' uses actual atomic grant, canonical reserve and receipt RPC names',async()=>{
  const operations=[];const providerCalls=[];
  const db={rpc:async(name,args)=>{
   operations.push({name,args});
   if(name==='benchmark_issue_nonfull_execution_grant')return{data:'grant-id',error:null};
   if(name==='benchmark_gateway_execution_live')return{data:true,error:null};
   if(name==='benchmark_grant_reserve')return{data:'charge-id',error:null};
   if(name==='benchmark_reconcile_receipt')return{data:'settled',error:null};
   throw Error('Unexpected RPC '+name);
  }};
  const grant=await issueNonFullTrustedGrant({...fixtures(arm),db,
   tokenFactory:()=>('trusted-token-'+('z'.repeat(50)))});
  assert.equal(grant.grantId,'grant-id');
  assert.equal(operations[0].name,'benchmark_issue_nonfull_execution_grant');
  assert.equal(operations[0].args.p_digest,tokenDigest(grant.grantToken));
  const result=await forwardAuthorizedModelRequest({
   db,grantToken:grant.grantToken,trialId:grant.trialId,executionEpoch:grant.executionEpoch,
   model:'synthetic',requestBody:{model:'synthetic'},upperTokens:10000,
   providerNamespace:'synthetic',fullMission:false,
   upstream:async()=>{providerCalls.push(1);return{providerRequestId:'provider-response',actualTokens:10,body:'{}'}},
   recordReceipt:grant.canonicalReceipt
  });
  assert.equal(result.actualTokens,10);
  assert.equal(providerCalls.length,1);
  assert.deepEqual(operations.map(x=>x.name),[
   'benchmark_issue_nonfull_execution_grant','benchmark_gateway_execution_live',
   'benchmark_grant_reserve','benchmark_reconcile_receipt'
  ]);
 });
 test(arm+' denies a rejected grant before any upstream call',async()=>{
  const ops=[];const db={rpc:async(name)=>{ops.push(name);return{data:null,error:{message:'denied'}}}};
  await assert.rejects(issueNonFullTrustedGrant({...fixtures(arm),db,
   tokenFactory:()=>('trusted-token-'+('z'.repeat(50)))}),/ATOMIC_GRANT_DENIED/);
  assert.deepEqual(ops,['benchmark_issue_nonfull_execution_grant']);
 });
}

test('real trusted HTTP gateway for Native denies unauthenticated requests and settles exactly once',async()=>{
 const calls=[];
 const db={rpc:async(name,args)=>{
  calls.push(name);
  if(name==='benchmark_issue_nonfull_execution_grant')return {data:'grant-1',error:null};
  if(name==='benchmark_gateway_execution_live')return {data:true,error:null};
  if(name==='benchmark_grant_reserve')return {data:'canonical-operation-1',error:null};
  if(name==='benchmark_reconcile_receipt')return {data:'settled',error:null};
  throw Error('unexpected database operation '+name);
 }};
 let upstreamCount=0;
 const {server}=await createNonFullTrustedGateway({...fixtures('native'),db,
  tokenFactory:()=>('trusted-token-'+('z'.repeat(50))),
  upperTokens:10000,clientToken:'trusted-local-client-secret',
  upstream:async()=>{upstreamCount++;return {providerRequestId:'synthetic-receipt-1',
   actualTokens:10,contentType:'application/json',body:JSON.stringify({id:'fixture'})}}
 });
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint='http://127.0.0.1:'+server.address().port+'/v1/responses';
  const body=JSON.stringify({model:'synthetic'});
  const bad=await fetch(endpoint,{method:'POST',headers:{authorization:'Bearer wrong'},body});
  assert.equal(bad.status,401);
  assert.equal(upstreamCount,0);
  const good=await fetch(endpoint,{method:'POST',headers:{
   authorization:'Bearer trusted-local-client-secret','content-type':'application/json'},body});
  assert.equal(good.status,200);
  assert.equal(upstreamCount,1);
  assert.equal(calls.filter(x=>x==='benchmark_grant_reserve').length,1);
  assert.equal(calls.filter(x=>x==='benchmark_reconcile_receipt').length,1);
 }finally{await new Promise(resolve=>server.close(resolve))}
});

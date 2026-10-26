import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runNonFullAuthorizedHost} from '../scripts/benchmark/nonfull-authorized-host.mjs';
const fixture=arm=>{
 const trial={id:'trial-'+arm,arm,state:'qualified',owner_actor_id:'actor',
  experiment_id:'11111111-1111-4111-8111-111111111111',replicate:1,
  baseline_sha:'b'.repeat(40),contract_sha256:'c'.repeat(64),
  acceptance_sha256:'a'.repeat(64),tool_profile_sha256:'d'.repeat(64),
  model_policy_sha256:'e'.repeat(64),runtime_sha256:'f'.repeat(64)};
 const account={id:'account-'+arm,arm,trial_id:trial.id,owner_actor_id:'actor',cap_tokens:1000};
 const approval={id:'approval-'+arm,trial_id:trial.id,account_id:account.id,
  actor_id:'actor',owner_id:'owner',chat_id:'chat',repository:'mfackrell/katie',
  model:'synthetic',deadline:'2099-01-01T00:00:00Z',max_tokens:1000,
  task_id:null,project_id:null,mission_assignment_id:null};
 approval.protocol_digest=createHash('sha256').update(JSON.stringify({
  experimentId:trial.experiment_id,replicate:trial.replicate,
  baselineSha:trial.baseline_sha,contractSha256:trial.contract_sha256,
  acceptanceSha256:trial.acceptance_sha256,toolProfileSha256:trial.tool_profile_sha256,
  modelPolicySha256:trial.model_policy_sha256,runtimeSha256:trial.runtime_sha256,
  tokenCap:account.cap_tokens
 })).digest('hex');
 return {arm,trial,account,approval,ownerId:'owner',repository:'mfackrell/katie'};
};
test('Native and Thin execute four isolated phases via same trusted DB-grant/receipt host', {timeout:180000},async t=>{
 const sandboxAvailable=spawnSync('bwrap',['--unshare-user','--ro-bind','/','/','--','/bin/true']).status===0
   && spawnSync('which',['socat']).status===0;
 if(!sandboxAvailable){
   if(process.env.KATIE_REQUIRE_NATIVE_BWRAP==='1')throw Error('REQUIRED_NATIVE_SANDBOX_UNAVAILABLE');
   // General CI validates fail-closed input admission; the dedicated hosted
   // qualification MUST run the complete contained SDK/PostgreSQL test.
   await assert.rejects(runNonFullAuthorizedHost({arm:'native',db:null,workspace:null}),
     /NONFULL_HOST_PAID_EXECUTION_DENIED/);
   return;
 }
 for(const arm of ['native','thin']){
  const root=mkdtempSync(join(tmpdir(),'nonfull-trusted-host-test-'));
  try{
   assert.equal(spawnSync('git',['init','-q',root]).status,0);
   mkdirSync(join(root,'node_modules'));
   let phaseCall=0;const calls=[];
   const db={rpc:async(name,args)=>{
    calls.push({name,args});
    if(name==='benchmark_issue_nonfull_execution_grant')return {data:'grant-'+arm,error:null};
    if(name==='benchmark_gateway_execution_live')return {data:true,error:null};
    if(name==='benchmark_grant_reserve')return {data:'operation-'+calls.length,error:null};
    if(name==='benchmark_reconcile_receipt')return {data:'settled',error:null};
    throw Error('UNEXPECTED_DB_RPC:'+name);
   }};
   const upstream=async body=>{
    phaseCall++;
    const text=phaseCall===2?'CHANGES_REQUESTED: fixture defect':phaseCall===4?
     'PASS: synthetic repair':'DONE';
    const item={id:'msg_'+phaseCall,type:'message',role:'assistant',status:'completed',
     content:[{type:'output_text',text,annotations:[]}]};
    const response={id:'response-'+arm+'-'+phaseCall,object:'response',
     created_at:1,model:body.model,status:'completed',output:[item],
     usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
    const events=[
     ['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],
     ['response.output_item.added',{type:'response.output_item.added',output_index:0,item}],
     ['response.output_item.done',{type:'response.output_item.done',output_index:0,item}],
     ['response.completed',{type:'response.completed',response}]
    ];
    return {providerRequestId:response.id,actualTokens:5,contentType:'text/event-stream',
     body:events.map(([kind,data])=>'event: '+kind+'\ndata: '+JSON.stringify(data)+'\n\n').join('')+'data: [DONE]\n\n'};
   };
   upstream.nonbillableFixture=true;
   const result=await runNonFullAuthorizedHost({...fixture(arm),db,workspace:root,upstream});
   assert.equal(result.arm,arm);
   assert.equal(result.phases.length,4);
   assert.equal(phaseCall,4);
   assert.equal(calls.filter(c=>c.name==='benchmark_issue_nonfull_execution_grant').length,1);
   assert.equal(calls.filter(c=>c.name==='benchmark_grant_reserve').length,4);
   assert.equal(calls.filter(c=>c.name==='benchmark_reconcile_receipt').length,4);
   assert.equal(calls.filter(c=>c.name==='benchmark_full_native_reserve').length,0);
  }finally{rmSync(root,{recursive:true,force:true})}
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {modules} from './helpers/load-project-modules.mjs';
import {encodeNativeHandoff,readNativeHandoff} from '../scripts/benchmark/native-dispatch-contract.mjs';
const zip=value=>{
 const name=Buffer.from('agent-result.json'),bytes=Buffer.from(JSON.stringify(value));
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(name.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(name.length,28);
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,10);end.writeUInt32LE(local.length+name.length+bytes.length,16);
 return Buffer.concat([local,name,bytes,central,name,end]);
};
function setup({badReceipt=false,claim=true,chained=false}={}){
 const taskId=randomUUID(),projectId=randomUUID(),trialId=randomUUID(),approvalId=randomUUID(),continuationId=randomUUID(),recoveryId=randomUUID();
 const key='synthetic-handoff-key-that-is-long-enough',release='f'.repeat(40),hash='b'.repeat(64);
 const a={id:approvalId,task_id:taskId,project_id:projectId,trial_id:trialId,continuation_id:continuationId,deadline:new Date(Date.now()+3600000).toISOString()};
 const receipt={version:1,repository:'mfackrell/katie',run_id:123,issue_number:829,outcome:'BLOCKED',pr_url:null,tested_head_sha:null,reviewed_head_sha:null,checks:{build:'failure',test:'',review:'',repair:'skipped',retest:'',final_review:''}};
 const task={id:taskId,request_id:'request',repository_id:randomUUID(),repository_full_name:'mfackrell/katie',status:'blocked',external:{receipt,issueNumber:829}};
 const c={projectId,contractHash:hash,baselineSha:'a'.repeat(40),contract:{scenarios:[]}};
 let pending=chained?{id:randomUUID(),prior_run:122,release_sha:'a'.repeat(40)}:null,sent=chained,body='<!-- katie-managed-task:'+taskId+' -->\n\n'+encodeNativeHandoff({taskId,projectId,trialId,approvalId,continuationId,...(chained?{startupRecoveryId:pending.id}:{}),contractHash:hash,benchmarkContractHash:hash,baselineSha:c.baselineSha,expiresAt:Date.now()+60000},key)+'\nOriginal immutable game requirements';
 const calls=[],writes=[];
 const db={from:table=>({select(){return this},or(){return this},is(){return this},limit(){return this},order(){return this},eq(){return this},returns:async()=>({data:[a]}),maybeSingle:async()=>({data:table==='benchmark_startup_recoveries'?pending:table==='benchmark_startup_recovery_dispatches'?(sent?{recovery_id:recoveryId}:null):table==='repo_sync_runs'?{repository_full_name:'mfackrell/katie'}:{contract_hash:hash,trial_id:trialId,benchmark_contract_hash:hash}})}),rpc:async(name,args)=>{calls.push({name,args});if(name==='benchmark_prepare_startup_recovery'){pending={id:recoveryId,prior_run:123,release_sha:release};sent=false;task.status='dispatching';return {data:pending}}if(name==='benchmark_claim_startup_recovery_dispatch'){sent=claim;return {data:claim}}throw Error('Unexpected RPC '+name)}};
 const run={id:123,status:'completed',conclusion:'failure',repository:{full_name:'mfackrell/katie'},head_repository:{full_name:'mfackrell/katie'},head_branch:'main',event:'issues',path:'.github/workflows/autonomous-development.yml',head_sha:'a'.repeat(40)};
 class Octokit{
  repos={getCommit:async()=>({data:{sha:release}})};
  actions={getWorkflowRun:async()=>({data:run}),listWorkflowRunArtifacts:async()=>({data:{artifacts:[{id:1,name:'agent-completion',expired:false,size_in_bytes:1000}]}}),downloadArtifact:async()=>({data:zip({...receipt,...(badReceipt?{issue_number:830}:{})})}),createWorkflowDispatch:async x=>{writes.push({kind:'dispatch',...x})}};
  issues={get:async()=>({data:{body,user:{login:'mfackrell'}}}),update:async x=>{body=x.body;writes.push({kind:'issue',...x})}};
 }
 const {recoverUnusedNativeStartup}=modules({'@octokit/rest':{Octokit},'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/agents/store':{readTask:async()=>task},'@/lib/projects/store':{getDevelopmentProjectContext:async()=>c,acceptanceBinding:()=>({projectId,contractHash:hash,scenarioNames:[]})}})('@/lib/agents/development');
 return {run:recoverUnusedNativeStartup,calls,writes,receipt,recoveryId,taskId,approvalId,key,release,body:()=>body};
}
async function env(fn){
 const values={VERCEL_GIT_COMMIT_SHA:'f'.repeat(40),KATIE_FULL_BENCHMARK_ENVIRONMENT:'production',KATIE_FULL_BENCHMARK_DISPATCH:'enabled',KATIE_NATIVE_BENCHMARK_DISPATCH:'enabled',KATIE_BENCHMARK_PAID_EXECUTION:'enabled',KATIE_NATIVE_HANDOFF_HMAC_KEY:'synthetic-handoff-key-that-is-long-enough',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',GITHUB_TOKEN:'synthetic-github-token'};
 const old=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));Object.assign(process.env,values);
 try{await fn()}finally{for(const [k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v}}
}
test('real server recovery authenticates terminal receipt and refreshes the same issue exactly once',()=>env(async()=>{
 const f=setup();assert.equal(await f.run(),true);assert.deepEqual(f.writes.map(x=>x.kind),['issue','dispatch']);
 assert.equal(f.writes[0].issue_number,829);assert.equal(f.writes[1].inputs.issue_number,'829');assert.equal(f.writes[1].ref,'main');
 const proof=readNativeHandoff(f.body(),f.key);assert.equal(proof.startupRecoveryId,f.recoveryId);assert.equal(proof.taskId,f.taskId);assert.equal(proof.approvalId,f.approvalId);
 assert.match(f.body(),/Original immutable game requirements/);assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].args.p_receipt)),f.receipt);
 assert.equal(await f.run(),false);assert.equal(f.writes.length,2);
}));
test('real server refuses mismatched GitHub completion evidence before preparing capability',()=>env(async()=>{
 const f=setup({badReceipt:true});await assert.rejects(f.run(),/Receipt association invalid/);assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
}));
test('atomic dispatch claim failure prevents issue changes and duplicate workflow dispatch',()=>env(async()=>{
 const f=setup({claim:false});assert.equal(await f.run(),false);assert.equal(f.writes.length,0);assert.equal(f.calls.length,2);
}));

test('a distinct terminal zero-call failure can append a new correction while prior dispatch is retained',()=>env(async()=>{
 const f=setup({chained:true});assert.equal(await f.run(),true);assert.equal(f.calls[0].name,'benchmark_prepare_startup_recovery');
 assert.equal(f.writes[0].issue_number,829);assert.equal(readNativeHandoff(f.body(),f.key).startupRecoveryId,f.recoveryId);
 assert.equal(await f.run(),false);assert.equal(f.writes.length,2);
}));

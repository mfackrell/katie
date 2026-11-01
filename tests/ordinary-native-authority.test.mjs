import test from 'node:test';
import assert from 'node:assert/strict';
import {readOrdinaryNativeAuthority,readOrdinaryLifecycleCapacity} from '../scripts/benchmark/ordinary-native-authority.mjs';
function fixture(){
 const binding={taskId:'task',projectId:'project',scopeHash:'a'.repeat(64),contractHash:'b'.repeat(64),baselineSha:'c'.repeat(40)};
 const proof={...binding,authorityKind:'ordinary-developer',accountId:'account',approvalId:'approval',releaseSha:'d'.repeat(40)};
 const approval={id:'approval',task_id:'task',project_id:'project',account_id:'account',owner_id:'owner',model:'gpt-5.3-codex',trial_id:null,continuation_id:null,deadline:new Date(Date.now()+3600000).toISOString(),developer_authority:{version:'ordinary-developer-v1'}};
 const project={id:'project',status:'running',phase:'development',approved_hash:binding.scopeHash};
 const account={id:'account',arm:'developer',trial_id:null,experiment_id:null,developer_project_id:'project'};
 const task={id:'task',external:{developerApprovalId:'approval',developerReleaseSha:proof.releaseSha}};
 const snapshot={authorityKind:'ordinary-developer',ownerId:'owner',accountId:'account',binding,model:approval.model,snapshot:{approval,grants:[]},position:{expiresAt:Date.now()+3600000,cumulativeTokens:180000,accountEncumberedTokens:55,developmentTokens:120000,developmentEncumberedTokens:55,completionTokens:60000,assessmentTokens:60000,developmentCalls:15,developmentConsumedCalls:11,completionCalls:4,assessmentCalls:4,assessmentConsumedCalls:0,ceilingMicrousd:'2000000'},exposureMicrousd:'1'};
 const db={rpc:async name=>{assert.equal(name,'benchmark_lifecycle_snapshot');return {data:snapshot,error:null};}};
 return {db,proof,approval,project,account,task,snapshot,releaseSha:proof.releaseSha,context:{baselineSha:binding.baselineSha,contractHash:binding.contractHash},phase:'repair'};
}
test('ordinary host authenticates explicit original authority without benchmark records',async()=>{
 const f=fixture();assert.equal(await readOrdinaryNativeAuthority(f),f.snapshot);
 for(const change of [f=>f.account.arm='full',f=>f.approval.trial_id='trial',f=>f.approval.consumed_at='now',f=>f.snapshot.ownerId='other',f=>f.task.external.developerReleaseSha='other',f=>f.snapshot.binding.scopeHash='other']){
  const bad=fixture();change(bad);await assert.rejects(readOrdinaryNativeAuthority(bad),/DENIED/);
 }
});
test('ordinary host forecasts eleven exhausted native calls without treating other capacity as a substitute',async()=>{
 const result=await readOrdinaryLifecycleCapacity(fixture());
 assert.equal(result.status,'insufficient');assert.ok(result.shortages.includes('nativeCalls'));
});
test('missing snapshot preserves already known revoked authority',async()=>{
 const f=fixture();f.approval.revoked_at=new Date().toISOString();f.db.rpc=async()=>({error:'missing',data:null});
 const result=await readOrdinaryLifecycleCapacity(f);assert.ok(result.uncertainties.includes('ordinary_authoritative_snapshot_unavailable'));
 assert.equal(result.authorization.live,false);assert.equal(result.authorization.executionAuthorized,false);assert.equal(result.status,'insufficient');
});

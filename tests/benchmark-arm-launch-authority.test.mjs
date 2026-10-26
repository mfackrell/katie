import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {verifyNonFullLaunch} from '../scripts/benchmark/arm-launch-authority.mjs';
const fixture=arm=>{
 const trial={id:arm+'-trial',arm,state:'qualified',owner_actor_id:'actor',
 contract_sha256:'c'.repeat(64),baseline_sha:'b'.repeat(40),
 model_policy_sha256:'d'.repeat(64),tool_profile_sha256:'e'.repeat(64),runtime_sha256:'f'.repeat(64)};
 trial.experiment_id='11111111-1111-4111-8111-111111111111';trial.replicate=1;
 trial.acceptance_sha256='a'.repeat(64);
 const account={id:arm+'-account',arm,trial_id:trial.id,owner_actor_id:'actor',cap_tokens:100};
 const approval={id:arm+'-approval',trial_id:trial.id,account_id:account.id,actor_id:'actor',
  owner_id:'owner',chat_id:'chat',repository:'mfackrell/katie',model:'synthetic',
  max_tokens:100,deadline:'2099-01-01T00:00:00Z',
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
for(const arm of ['native','thin']){
 test(arm+' requires a qualified exact owner, trial and spending account binding',()=>{
  const good=fixture(arm);
  assert.equal(verifyNonFullLaunch(good).arm,arm);
  for(const [object,field,value] of [
   ['trial','state','planned'],['trial','arm','full'],['account','arm','full'],
   ['account','trial_id','another'],['account','owner_actor_id','other'],
   ['approval','actor_id','other'],['approval','owner_id','other'],
   ['approval','repository','other/repo'],['approval','consumed_at','2026-01-01'],
   ['approval','revoked_at','2026-01-01'],['approval','task_id','forged-full-task'],
   ['approval','project_id','forged-full-project'],['approval','mission_assignment_id','forged-mission'],
   ['account','frozen_at','2026-01-01'],['approval','max_tokens',50],
   ['approval','protocol_digest','0'.repeat(64)],
   ['approval','deadline','2020-01-01T00:00:00Z']]){
   const bad=fixture(arm);bad[object][field]=value;
   assert.throws(()=>verifyNonFullLaunch(bad),/DENIED/);
  }
 });
}
test('non-full authorization can never authorize Full',()=>{
 assert.throws(()=>verifyNonFullLaunch({...fixture('native'),arm:'full'}),/NONFULL_ARM_REQUIRED/);
});

test('owner workflow cannot execute unreviewed branches or paid model keys',()=>{
 const workflow=readFileSync('.github/workflows/benchmark-nonfull-owner-launch.yml','utf8');
 assert.match(workflow,/github.actor == github.repository_owner/);
 assert.match(workflow,/ref: main/);
 assert.match(workflow,/KATIE_BENCHMARK_PAID_EXECUTION: disabled/);
 assert.match(workflow,/OPENAI_API_KEY: ''/);
 assert.match(workflow,/native-thin-preflight\.mjs/);
 assert.match(workflow,/native-four-phase-contained-host-probe\.mjs/);
 assert.match(workflow,/KATIE_TRIAL_MANIFEST/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyNonFullLaunch} from '../scripts/benchmark/arm-launch-authority.mjs';
const fixture=arm=>{
 const trial={id:arm+'-trial',arm,state:'qualified',owner_actor_id:'actor',
 contract_sha256:'c'.repeat(64),baseline_sha:'b'.repeat(40),
 model_policy_sha256:'d'.repeat(64),tool_profile_sha256:'e'.repeat(64),runtime_sha256:'f'.repeat(64)};
 const account={id:arm+'-account',arm,trial_id:trial.id,owner_actor_id:'actor',cap_tokens:100};
 const approval={id:arm+'-approval',trial_id:trial.id,account_id:account.id,actor_id:'actor',
  owner_id:'owner',repository:'mfackrell/katie',model:'synthetic',
  max_tokens:100,deadline:'2099-01-01T00:00:00Z',
  task_id:null,project_id:null,mission_assignment_id:null};
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
   ['approval','deadline','2020-01-01T00:00:00Z']]){
   const bad=fixture(arm);bad[object][field]=value;
   assert.throws(()=>verifyNonFullLaunch(bad),/DENIED/);
  }
 });
}
test('non-full authorization can never authorize Full',()=>{
 assert.throws(()=>verifyNonFullLaunch({...fixture('native'),arm:'full'}),/NONFULL_ARM_REQUIRED/);
});

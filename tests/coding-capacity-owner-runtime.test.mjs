import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';
const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe',ownerId='04ed6c05-a586-4a56-ba81-1b50e378746b',authorizationId='609a344e-98f2-48b0-82d0-82884b6a24c6';
const scopeHash='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6',sha='a'.repeat(40),stateHash='b'.repeat(64),deployment='dpl_CapacityTest',generation=41,cutoff='2026-11-26T19:45:00.000Z';
test('exhausted recovery requires exact owner, explicit mission and paid-call terms and current release; never dispatches on POST',async t=>{
 const env={VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,VERCEL_DEPLOYMENT_ID:deployment,KATIE_OWNER_AUTH_USER_ID:ownerId};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])),clock=Date.now;
 Object.assign(process.env,env);Date.now=()=>Date.parse('2026-11-24T18:00:00Z');
 t.after(()=>{Date.now=clock;for(const k in old){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}});
 let owner=false,canonical=true,stage='authorize',writes=0,epoch={active:true,generation,deploymentId:deployment};
 const offer=()=>({projectId,stage,releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,scopeHash,stateHash,cutoff,historicalMissions:96,priorMaxMissions:96,remainingRecordedTokens:600000,authorizationId:stage==='authorize'?null:authorizationId});
 const mock=modules({'@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},'@/lib/projects/coding-capacity-recovery':{codingCapacityOffer:async()=>offer()},'@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>canonical},'@/lib/missions/store':{rpc:async(n,a)=>{
  if(n==='project_org_retest_release_epoch')return epoch;
  assert.equal(n,'project_org_coding_capacity_authorize');writes++;
  assert.deepEqual(JSON.parse(JSON.stringify(a)),{p_owner:ownerId,p_project:projectId,p_release:sha,p_generation:generation,p_deployment:deployment,p_authorization:authorizationId,p_state_hash:stateHash,p_scope:scopeHash,p_cutoff:cutoff,p_additional:4,p_max:100,p_paid_limit:4,p_retry_limit:0,p_tokens:600000,p_remaining:600000});
  stage='authorized';return {...offer(),maxMissions:100};
 }},'@/lib/data/persistence-store':{getMessages:async()=>[]}});
 const route=mock('@/app/api/projects/organization/route');
 const payload={trialAction:'authorize_coding_capacity',projectId,authorizationId,releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,scopeHash,stateHash,cutoff,historicalMissions:96,additionalMissions:4,maxMissions:100,paidInferenceLimit:4,paidInferenceConsent:true,retryLimit:0,tokenAllowance:600000,remainingRecordedTokens:600000,additionalTokens:0,additionalSpendingAuthority:0};
 const post=body=>route.POST(new Request('https://katie.test/api/projects/organization',{method:'POST',headers:{Origin:'https://katie.test','Content-Type':'application/json'},body:JSON.stringify(body??payload)}));
 assert.equal((await post()).status,403);owner=true;
 assert.equal((await (await route.GET(new Request('https://katie.test/api/projects/organization?projectId='+projectId))).json()).codingCapacityRecovery.stage,'authorize');
 for(const change of [{projectId:ownerId},{releaseSha:'c'.repeat(40)},{releaseGeneration:42},{deploymentId:'dpl_Wrong'},{scopeHash:'c'.repeat(64)},{stateHash:'c'.repeat(64)},{cutoff:'2026-11-27T19:45:00.000Z'},{historicalMissions:95},{additionalMissions:0},{additionalMissions:9},{maxMissions:101},{paidInferenceLimit:5},{paidInferenceConsent:false},{retryLimit:1},{tokenAllowance:600001},{remainingRecordedTokens:599999},{additionalTokens:1},{additionalSpendingAuthority:1}])assert.notEqual((await post({...payload,...change})).status,200,JSON.stringify(change));
 epoch={...epoch,active:false};assert.equal((await post()).status,409);epoch={...epoch,active:true};canonical=false;assert.equal((await post()).status,409);canonical=true;
 assert.equal(writes,0);assert.equal((await post()).status,200);assert.equal(writes,1);assert.equal((await post()).status,409);assert.equal(writes,1);
});

test('Mission98 successor reuses authenticated owner route with exact three missions, new ceiling, source IDs and no replay',async t=>{
 const env={VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,VERCEL_DEPLOYMENT_ID:deployment,KATIE_OWNER_AUTH_USER_ID:ownerId};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])),clock=Date.now;
 Object.assign(process.env,env);Date.now=()=>Date.parse('2026-11-24T19:00:00Z');
 t.after(()=>{Date.now=clock;for(const k in old){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}});
 const priorAuthorizationId='99788be7-2c41-4145-b1a7-a96e6635a667',sourceMissionId='5bd4b72d-cd8b-4425-a6dd-16fdcfd346d7',sourceAssignmentId='3cf41309-6f35-4c68-8e75-7da55d5669c6';
 let owner=false,canonical=true,stage='authorize',writes=0,epoch={active:true,generation,deploymentId:deployment};
 const offer=()=>({projectId,stage,releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,scopeHash,stateHash,cutoff,
  historicalMissions:98,priorMaxMissions:100,remainingRecordedTokens:600000,priorAuthorizationId,sourceMissionId,sourceAssignmentId,additionalMissions:3,maxMissions:101,paidInferenceLimit:3,authorizationId:stage==='authorize'?null:authorizationId});
 const mock=modules({'@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},'@/lib/projects/coding-capacity-recovery':{codingCapacityOffer:async()=>offer()},'@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>canonical},'@/lib/missions/store':{rpc:async(n,a)=>{
  if(n==='project_org_retest_release_epoch')return epoch;
  assert.equal(n,'project_org_coding_capacity_resume_authorize');writes++;
  assert.deepEqual(JSON.parse(JSON.stringify(a)),{p_owner:ownerId,p_project:projectId,p_release:sha,p_generation:generation,p_deployment:deployment,p_authorization:authorizationId,p_state_hash:stateHash,p_scope:scopeHash,p_cutoff:cutoff,p_additional:3,p_max:101,p_paid_limit:3,p_retry_limit:0,p_tokens:600000,p_remaining:600000,p_prior_authorization:priorAuthorizationId,p_source_mission:sourceMissionId,p_source_assignment:sourceAssignmentId});
  stage='authorized';return {...offer(),status:'running'};
 }},'@/lib/data/persistence-store':{getMessages:async()=>[]}});
 const route=mock('@/app/api/projects/organization/route');
 const payload={trialAction:'authorize_coding_capacity',projectId,authorizationId,releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,scopeHash,stateHash,cutoff,historicalMissions:98,additionalMissions:3,maxMissions:101,paidInferenceLimit:3,paidInferenceConsent:true,retryLimit:0,tokenAllowance:600000,remainingRecordedTokens:600000,additionalTokens:0,additionalSpendingAuthority:0,priorAuthorizationId,sourceMissionId,sourceAssignmentId};
 const post=body=>route.POST(new Request('https://katie.test/api/projects/organization',{method:'POST',headers:{Origin:'https://katie.test','Content-Type':'application/json'},body:JSON.stringify(body??payload)}));
 assert.equal((await post()).status,403);owner=true;
 assert.equal((await (await route.GET(new Request('https://katie.test/api/projects/organization?projectId='+projectId))).json()).codingCapacityRecovery.historicalMissions,98);
 for(const change of [{historicalMissions:96,additionalMissions:5,maxMissions:101},{additionalMissions:2,maxMissions:100,paidInferenceLimit:2},{additionalMissions:4,maxMissions:102,paidInferenceLimit:4},{maxMissions:102},{paidInferenceLimit:4},{priorAuthorizationId:undefined},{sourceMissionId:authorizationId},{sourceAssignmentId:authorizationId},{releaseSha:'c'.repeat(40)},{releaseGeneration:generation+1},{deploymentId:'dpl_Wrong'},{stateHash:'c'.repeat(64)},{scopeHash:'c'.repeat(64)},{cutoff:'2026-11-27T19:45:00.000Z'},{paidInferenceConsent:false},{retryLimit:1},{tokenAllowance:600001},{additionalTokens:1},{additionalSpendingAuthority:1},{remainingRecordedTokens:599999}])
  assert.notEqual((await post({...payload,...change})).status,200,JSON.stringify(change));
 epoch={...epoch,active:false};assert.equal((await post()).status,409);epoch={...epoch,active:true};canonical=false;assert.equal((await post()).status,409);canonical=true;
 assert.equal(writes,0);assert.equal((await post()).status,200);assert.equal(writes,1);assert.equal((await post()).status,409);assert.equal(writes,1);
});

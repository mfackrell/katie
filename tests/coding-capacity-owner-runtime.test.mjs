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

test('Mission99 successor reuses authenticated owner route with exact three missions, new ceiling, source IDs and no replay',async t=>{
 const env={VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,VERCEL_DEPLOYMENT_ID:deployment,KATIE_OWNER_AUTH_USER_ID:ownerId};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])),clock=Date.now;
 Object.assign(process.env,env);Date.now=()=>Date.parse('2026-11-24T19:00:00Z');
 t.after(()=>{Date.now=clock;for(const k in old){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}});
 const priorAuthorizationId='dcbfc493-6311-44eb-af33-bcba213c3d64',sourceMissionId='43af2c7c-0b7c-48e6-a247-016e599f3349',sourceAssignmentId='fb7c3e64-64ba-4612-9bba-a4084c11aafe';
 let owner=false,canonical=true,stage='authorize',writes=0,epoch={active:true,generation,deploymentId:deployment};
 const offer=()=>({projectId,stage,releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,scopeHash,stateHash,cutoff,
  historicalMissions:99,priorMaxMissions:101,remainingRecordedTokens:600000,priorAuthorizationId,sourceMissionId,sourceAssignmentId,additionalMissions:3,maxMissions:102,paidInferenceLimit:3,authorizationId:stage==='authorize'?null:authorizationId});
 const mock=modules({'@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},'@/lib/projects/coding-capacity-recovery':{codingCapacityOffer:async()=>offer()},'@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>canonical},'@/lib/missions/store':{rpc:async(n,a)=>{
  if(n==='project_org_retest_release_epoch')return epoch;
  assert.equal(n,'project_org_coding_capacity_resume_authorize');writes++;
  assert.deepEqual(JSON.parse(JSON.stringify(a)),{p_owner:ownerId,p_project:projectId,p_release:sha,p_generation:generation,p_deployment:deployment,p_authorization:authorizationId,p_state_hash:stateHash,p_scope:scopeHash,p_cutoff:cutoff,p_additional:3,p_max:102,p_paid_limit:3,p_retry_limit:0,p_tokens:600000,p_remaining:600000,p_prior_authorization:priorAuthorizationId,p_source_mission:sourceMissionId,p_source_assignment:sourceAssignmentId});
  stage='authorized';return {...offer(),status:'running'};
 }},'@/lib/data/persistence-store':{getMessages:async()=>[]}});
 const route=mock('@/app/api/projects/organization/route');
 const payload={trialAction:'authorize_coding_capacity',projectId,authorizationId,releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,scopeHash,stateHash,cutoff,historicalMissions:99,additionalMissions:3,maxMissions:102,paidInferenceLimit:3,paidInferenceConsent:true,retryLimit:0,tokenAllowance:600000,remainingRecordedTokens:600000,additionalTokens:0,additionalSpendingAuthority:0,priorAuthorizationId,sourceMissionId,sourceAssignmentId};
 const post=body=>route.POST(new Request('https://katie.test/api/projects/organization',{method:'POST',headers:{Origin:'https://katie.test','Content-Type':'application/json'},body:JSON.stringify(body??payload)}));
 assert.equal((await post()).status,403);owner=true;
 assert.equal((await (await route.GET(new Request('https://katie.test/api/projects/organization?projectId='+projectId))).json()).codingCapacityRecovery.historicalMissions,99);
 for(const change of [{historicalMissions:96,additionalMissions:5,maxMissions:102},{additionalMissions:2,maxMissions:101,paidInferenceLimit:2},{additionalMissions:4,maxMissions:103,paidInferenceLimit:4},{maxMissions:103},{paidInferenceLimit:4},{priorAuthorizationId:undefined},{sourceMissionId:authorizationId},{sourceAssignmentId:authorizationId},{releaseSha:'c'.repeat(40)},{releaseGeneration:generation+1},{deploymentId:'dpl_Wrong'},{stateHash:'c'.repeat(64)},{scopeHash:'c'.repeat(64)},{cutoff:'2026-11-27T19:45:00.000Z'},{paidInferenceConsent:false},{retryLimit:1},{tokenAllowance:600001},{additionalTokens:1},{additionalSpendingAuthority:1},{remainingRecordedTokens:599999}])
  assert.notEqual((await post({...payload,...change})).status,200,JSON.stringify(change));
 epoch={...epoch,active:false};assert.equal((await post()).status,409);epoch={...epoch,active:true};canonical=false;assert.equal((await post()).status,409);canonical=true;
 assert.equal(writes,0);assert.equal((await post()).status,200);assert.equal(writes,1);assert.equal((await post()).status,409);assert.equal(writes,1);
});

test('Mission102 final package successor reuses authenticated owner route with exact one mission, new ceiling, source IDs and no replay',async t=>{
 const env={VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,VERCEL_DEPLOYMENT_ID:deployment,KATIE_OWNER_AUTH_USER_ID:ownerId};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])),clock=Date.now;
 Object.assign(process.env,env);Date.now=()=>Date.parse('2026-11-24T19:00:00Z');
 t.after(()=>{Date.now=clock;for(const k in old){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}});
 const priorAuthorizationId='0597487f-326d-4951-a727-612be9d772f1',sourceMissionId='3094d990-a16e-498b-bfb3-1a37245069c7',sourceAssignmentId='51274624-c601-4d66-826e-c635bb026e65';
 let owner=false,canonical=true,stage='authorize',writes=0,epoch={active:true,generation,deploymentId:deployment};
 const offer=()=>({projectId,stage,releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,scopeHash,stateHash,cutoff,
  historicalMissions:102,priorMaxMissions:102,remainingRecordedTokens:600000,priorAuthorizationId,sourceMissionId,sourceAssignmentId,additionalMissions:1,maxMissions:103,paidInferenceLimit:1,authorizationId:stage==='authorize'?null:authorizationId});
 const mock=modules({'@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},'@/lib/projects/coding-capacity-recovery':{codingCapacityOffer:async()=>offer()},'@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>canonical},'@/lib/missions/store':{rpc:async(n,a)=>{
  if(n==='project_org_retest_release_epoch')return epoch;
  assert.equal(n,'project_org_coding_capacity_resume_authorize');writes++;
  assert.deepEqual(JSON.parse(JSON.stringify(a)),{p_owner:ownerId,p_project:projectId,p_release:sha,p_generation:generation,p_deployment:deployment,p_authorization:authorizationId,p_state_hash:stateHash,p_scope:scopeHash,p_cutoff:cutoff,p_additional:1,p_max:103,p_paid_limit:1,p_retry_limit:0,p_tokens:600000,p_remaining:600000,p_prior_authorization:priorAuthorizationId,p_source_mission:sourceMissionId,p_source_assignment:sourceAssignmentId});
  stage='authorized';return {...offer(),status:'running'};
 }},'@/lib/data/persistence-store':{getMessages:async()=>[]}});
 const route=mock('@/app/api/projects/organization/route');
 const payload={trialAction:'authorize_coding_capacity',projectId,authorizationId,releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,scopeHash,stateHash,cutoff,historicalMissions:102,additionalMissions:1,maxMissions:103,paidInferenceLimit:1,paidInferenceConsent:true,retryLimit:0,tokenAllowance:600000,remainingRecordedTokens:600000,additionalTokens:0,additionalSpendingAuthority:0,priorAuthorizationId,sourceMissionId,sourceAssignmentId};
 const post=body=>route.POST(new Request('https://katie.test/api/projects/organization',{method:'POST',headers:{Origin:'https://katie.test','Content-Type':'application/json'},body:JSON.stringify(body??payload)}));
 assert.equal((await post()).status,403);owner=true;
 assert.equal((await (await route.GET(new Request('https://katie.test/api/projects/organization?projectId='+projectId))).json()).codingCapacityRecovery.historicalMissions,102);
 for(const change of [{historicalMissions:99,additionalMissions:4,maxMissions:103},{additionalMissions:0,maxMissions:102,paidInferenceLimit:0},{additionalMissions:2,maxMissions:104,paidInferenceLimit:2},{maxMissions:104},{paidInferenceLimit:2},{priorAuthorizationId:undefined},{sourceMissionId:authorizationId},{sourceAssignmentId:authorizationId},{releaseSha:'c'.repeat(40)},{releaseGeneration:generation+1},{deploymentId:'dpl_Wrong'},{stateHash:'c'.repeat(64)},{scopeHash:'c'.repeat(64)},{cutoff:'2026-11-27T19:45:00.000Z'},{paidInferenceConsent:false},{retryLimit:1},{tokenAllowance:600001},{additionalTokens:1},{additionalSpendingAuthority:1},{remainingRecordedTokens:599999}])
  assert.notEqual((await post({...payload,...change})).status,200,JSON.stringify(change));
 epoch={...epoch,active:false};assert.equal((await post()).status,409);epoch={...epoch,active:true};canonical=false;assert.equal((await post()).status,409);canonical=true;
 assert.equal(writes,0);assert.equal((await post()).status,200);assert.equal(writes,1);assert.equal((await post()).status,409);assert.equal(writes,1);
});

test('Mission103 SMART capacity successor reuses authenticated owner route with exact one mission, new ceiling, source IDs and no replay',async t=>{
 const env={VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,VERCEL_DEPLOYMENT_ID:deployment,KATIE_OWNER_AUTH_USER_ID:ownerId};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])),clock=Date.now;
 Object.assign(process.env,env);Date.now=()=>Date.parse('2026-11-24T19:00:00Z');
 t.after(()=>{Date.now=clock;for(const k in old){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}});
 const priorAuthorizationId='f83c4eb4-48c0-4cc8-b9b6-a1862f7b8f93',sourceMissionId='f4ef8dd1-7802-409c-9787-88a3dd246861',sourceAssignmentId='9cfe36d9-f666-4019-8694-73db24577cac';
 let owner=false,canonical=true,stage='authorize',writes=0,epoch={active:true,generation,deploymentId:deployment};
 const offer=()=>({projectId,stage,releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,scopeHash,stateHash,cutoff,
  historicalMissions:103,priorMaxMissions:103,remainingRecordedTokens:600000,priorAuthorizationId,sourceMissionId,sourceAssignmentId,additionalMissions:1,maxMissions:104,paidInferenceLimit:1,authorizationId:stage==='authorize'?null:authorizationId});
 const mock=modules({'@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},'@/lib/projects/coding-capacity-recovery':{codingCapacityOffer:async()=>offer()},'@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>canonical},'@/lib/missions/store':{rpc:async(n,a)=>{
  if(n==='project_org_retest_release_epoch')return epoch;
  assert.equal(n,'project_org_coding_capacity_resume_authorize');writes++;
  assert.deepEqual(JSON.parse(JSON.stringify(a)),{p_owner:ownerId,p_project:projectId,p_release:sha,p_generation:generation,p_deployment:deployment,p_authorization:authorizationId,p_state_hash:stateHash,p_scope:scopeHash,p_cutoff:cutoff,p_additional:1,p_max:104,p_paid_limit:1,p_retry_limit:0,p_tokens:600000,p_remaining:600000,p_prior_authorization:priorAuthorizationId,p_source_mission:sourceMissionId,p_source_assignment:sourceAssignmentId});
  stage='authorized';return {...offer(),status:'running'};
 }},'@/lib/data/persistence-store':{getMessages:async()=>[]}});
 const route=mock('@/app/api/projects/organization/route');
 const payload={trialAction:'authorize_coding_capacity',projectId,authorizationId,releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,scopeHash,stateHash,cutoff,historicalMissions:103,additionalMissions:1,maxMissions:104,paidInferenceLimit:1,paidInferenceConsent:true,retryLimit:0,tokenAllowance:600000,remainingRecordedTokens:600000,additionalTokens:0,additionalSpendingAuthority:0,priorAuthorizationId,sourceMissionId,sourceAssignmentId};
 const post=body=>route.POST(new Request('https://katie.test/api/projects/organization',{method:'POST',headers:{Origin:'https://katie.test','Content-Type':'application/json'},body:JSON.stringify(body??payload)}));
 assert.equal((await post()).status,403);owner=true;
 assert.equal((await (await route.GET(new Request('https://katie.test/api/projects/organization?projectId='+projectId))).json()).codingCapacityRecovery.historicalMissions,103);
 for(const change of [{historicalMissions:102,additionalMissions:2,maxMissions:104},{additionalMissions:0,maxMissions:103,paidInferenceLimit:0},{additionalMissions:2,maxMissions:105,paidInferenceLimit:2},{maxMissions:105},{paidInferenceLimit:2},{priorAuthorizationId:undefined},{sourceMissionId:authorizationId},{sourceAssignmentId:authorizationId},{releaseSha:'c'.repeat(40)},{releaseGeneration:generation+1},{deploymentId:'dpl_Wrong'},{stateHash:'c'.repeat(64)},{scopeHash:'c'.repeat(64)},{cutoff:'2026-11-27T19:45:00.000Z'},{paidInferenceConsent:false},{retryLimit:1},{tokenAllowance:600001},{additionalTokens:1},{additionalSpendingAuthority:1},{remainingRecordedTokens:599999}])
  assert.notEqual((await post({...payload,...change})).status,200,JSON.stringify(change));
 epoch={...epoch,active:false};assert.equal((await post()).status,409);epoch={...epoch,active:true};canonical=false;assert.equal((await post()).status,409);canonical=true;
 assert.equal(writes,0);assert.equal((await post()).status,200);assert.equal(writes,1);assert.equal((await post()).status,409);assert.equal(writes,1);
});

test('Mission104 existing-package consent binds the exact owner, release, package, terms and single-use receipt',async t=>{
 const env={VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,VERCEL_DEPLOYMENT_ID:deployment,KATIE_OWNER_AUTH_USER_ID:ownerId};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])),clock=Date.now;
 Object.assign(process.env,env);Date.now=()=>Date.parse('2026-11-24T20:00:00Z');
 t.after(()=>{Date.now=clock;for(const k in old){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}});
 const packageId='f88d4d10-dfe4-479e-a2cf-41b3e8209e47';
 let owner=false,canonical=true,writes=0,epoch={active:true,generation,deploymentId:deployment},terms;
 const offer=()=>({stage:'authorize',projectId,packageId,priorAuthorizationId:ownerId,releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,scopeHash,cutoff,stateHash,contractFingerprint:'c'.repeat(64),managerId:ownerId,coderId:authorizationId,writerId:authorizationId,reviewerId:projectId,paths:[],developmentPaths:[],terms});
 const mock=modules({'@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async request=>owner&&(request.method==='GET'||request.headers.get('origin')===new URL(request.url).origin)},'@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>canonical},'@/lib/missions/store':{rpc:async(n,a)=>{
  if(n==='project_org_package_execution_offer'){assert.equal(a.p_owner,ownerId);if(writes)throw Error('Receipt already exists');return offer();}
  if(n==='project_org_retest_release_epoch')return epoch;
  assert.equal(n,'project_org_package_execution_authorize');
  assert.deepEqual(JSON.parse(JSON.stringify(a)),{p_owner:ownerId,p_project:projectId,p_package:packageId,p_release:sha,p_generation:generation,p_deployment:deployment,p_authorization:authorizationId,p_state_hash:stateHash,p_terms:terms,p_consent:true});
  writes++;return {...offer(),stage:'authorized',authorizationId};
 }},'@/lib/data/persistence-store':{getMessages:async()=>[]}});
 terms=JSON.parse(JSON.stringify(mock('@/lib/projects/package-execution-authorization').PACKAGE_TERMS));
 const route=mock('@/app/api/projects/organization/route');
 const payload={trialAction:'authorize_existing_package_execution',projectId,packageId,authorizationId,releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,stateHash,terms,paidInferenceConsent:true};
 const post=(body=payload,origin='https://katie.test')=>route.POST(new Request('https://katie.test/api/projects/organization',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}));
 const get=()=>route.GET(new Request('https://katie.test/api/projects/organization?projectId='+projectId+'&packageId='+packageId));
 assert.equal((await get()).status,403);assert.equal((await post()).status,403);owner=true;
 assert.equal((await (await get()).json()).packageExecutionRecovery.packageId,packageId);
 for(const change of [{packageId:ownerId},{projectId:ownerId},{stateHash:'0'.repeat(64)},{releaseSha:'0'.repeat(40)},{releaseGeneration:generation+1},{deploymentId:'dpl_Other'},{paidInferenceConsent:false},{terms:{...terms,maxMissions:113}},{terms:{...terms,paidInferenceLimit:48}},{terms:{...terms,automaticRetries:1}},{terms:{...terms,dollarCeilingMicrousd:1}},{terms:{...terms,extra:true}}])assert.notEqual((await post({...payload,...change})).status,200,JSON.stringify(change));
 assert.notEqual((await post(payload,'https://other.test')).status,200);
 epoch={...epoch,active:false};assert.equal((await post()).status,409);epoch={...epoch,active:true};canonical=false;assert.equal((await post()).status,409);canonical=true;
 assert.equal(writes,0);const signed=await post();assert.equal(signed.status,200,await signed.text());assert.equal(writes,1);assert.equal((await post()).status,409);assert.equal(writes,1);
});

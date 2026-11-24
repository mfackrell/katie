import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const missionId='4034ba4d-aedb-4e5a-a363-9301af65ae42';
const assignmentId='6df08811-aa98-4c96-90dd-1835854f6cf2';
const ownerId='04ed6c05-a586-4a56-ba81-1b50e378746b';
const scopeHash='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
const sha='a'.repeat(40),deployment='dpl_ContextRetest',generation=35;
const cutoff='2026-11-26T19:45:00.000Z',stateHash='b'.repeat(64),contextHash='c'.repeat(64);
const authorizationId='609a344e-98f2-48b0-82d0-82884b6a24c6';

test('current-context owner approval is first-party, source-bound, one-shot and never paid on POST',async t=>{
 const keys=['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','VERCEL_DEPLOYMENT_ID','KATIE_OWNER_AUTH_USER_ID'];
 const before=Object.fromEntries(keys.map(k=>[k,process.env[k]])),clock=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,
  VERCEL_DEPLOYMENT_ID:deployment,KATIE_OWNER_AUTH_USER_ID:ownerId});
 Date.now=()=>Date.parse('2026-11-24T15:40:00Z');
 t.after(()=>{Date.now=clock;for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}});
 let owner=false,origin=true,canonical=true,stage='authorize',writes=0;
 let epoch={active:true,generation,deploymentId:deployment};
 const offer=()=>({projectId,stage,releaseSha:sha,releaseGeneration:generation,
  deploymentId:deployment,scopeHash,cutoff,missionId,assignmentId,stateHash,contextHash,
  contextChars:43725,authorizationId:stage==='authorize'?null:authorizationId,
  historicalMissions:95,maxMissions:96,tokenAllowance:600000,nodeCount:13,
  originalAttempts:1,originalCalls:0,additionalAttempts:1});
 const mock=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner&&origin},
  '@/lib/projects/management-failure-retest':{managementFailureRetestOffer:async()=>offer()},
  '@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>canonical},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_org_retest_release_epoch')return epoch;
   if(name==='project_org_management_failure_retest_authorize'){
    writes++;
    assert.deepEqual(JSON.parse(JSON.stringify(args)),{
     p_owner:ownerId,p_project:projectId,p_release:sha,
     p_generation:generation,p_deployment:deployment,p_mission:missionId,
     p_assignment:assignmentId,p_authorization:authorizationId,
     p_state_hash:stateHash,p_context_hash:contextHash,p_context_chars:43725});
    stage='authorized';return {...offer(),stage:'authorized',existing:false,
     authorizedAt:new Date(Date.now()).toISOString()};
   }
   throw Error('Unexpected database operation: '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]},
 });
 const route=mock('@/app/api/projects/organization/route');
 const payload={trialAction:'authorize_management_failure_retest',projectId,releaseSha:sha,
  releaseGeneration:generation,deploymentId:deployment,scopeHash,stateHash,contextHash,
  contextChars:43725,missionId,assignmentId,authorizationId,cutoff,
  historicalMissions:95,originalAttempts:1,additionalAttempts:1};
 const post=(body=payload)=>route.POST(new Request('https://katie.test/api/projects/organization',{
  method:'POST',headers:{Origin:'https://katie.test','Content-Type':'application/json'},
  body:JSON.stringify(body)
 }));
 assert.equal((await post()).status,403,'Owner cookie/session is mandatory');
 owner=true;origin=false;assert.equal((await post()).status,403,'Same-origin request only');origin=true;
 assert.equal((await (await route.GET(new Request('https://katie.test/api/projects/organization?projectId='+projectId))).json()).managementFailureRetest.stage,'authorize');
 for(const mutation of [
  {projectId:'c'.repeat(36)},{releaseSha:'f'.repeat(40)},{releaseGeneration:generation+1},
  {deploymentId:'dpl_Wrong'},{scopeHash:'d'.repeat(64)},
  {stateHash:'e'.repeat(64)},{contextHash:'f'.repeat(64)},
  {contextChars:48001},{contextChars:12},{missionId:projectId},
  {assignmentId:projectId},{cutoff:'2026-11-28T19:45:00.000Z'},
  {historicalMissions:91},{originalAttempts:0},{additionalAttempts:2}
 ])assert.notEqual((await post({...payload,...mutation})).status,200,'Changed authorization terms must reject');
 epoch={...epoch,active:false};assert.equal((await post()).status,409);
 epoch={...epoch,active:true};canonical=false;assert.equal((await post()).status,409);canonical=true;
 assert.equal(writes,0,'No inference or approved retries before owner consent');
 const accepted=await post();assert.equal(accepted.status,200);
 const receipt=await accepted.json();assert.equal(receipt.authorizationId,authorizationId);
 assert.equal(writes,1);
 assert.equal((await post()).status,409,'Repeat approval must fail closed');
 assert.equal(writes,1);
});

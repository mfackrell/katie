import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const missionId='18819669-d4cf-4010-a455-19f5bcbf93cb';
const assignmentId='bd8de51d-0195-4c5f-9c88-9dc39e228636';
const requestId='58d5926a-7160-42c1-9a04-540351e777dc';
const ownerId='04ed6c05-a586-4a56-ba81-1b50e378746b';
const scopeHash='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
const sha='a'.repeat(40),deployment='dpl_Mission84Release',generation=31;
const cutoff='2026-11-26T19:45:00.000Z';
const authorizedAt='2026-11-23T20:10:00.000Z';
const stateHash='b'.repeat(64);
const authorizationId='51ad7576-9e4b-4926-833c-07fb9fca55d1';

test('Mission84 owner retry is genuine first-party one-shot, denies replay and wrong release; no inference on authorization',async t=>{
 const keys=['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','VERCEL_DEPLOYMENT_ID','KATIE_OWNER_AUTH_USER_ID'];
 const prev=Object.fromEntries(keys.map(k=>[k,process.env[k]])),oldNow=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,
  VERCEL_DEPLOYMENT_ID:deployment,KATIE_OWNER_AUTH_USER_ID:ownerId});
 Date.now=()=>Date.parse('2026-11-23T20:10:00Z');
 t.after(()=>{Date.now=oldNow;for(const k of keys){if(prev[k]===undefined)delete process.env[k];else process.env[k]=prev[k];}});
 let authenticated=false,origin=true,canonical=true,writes=0,stage='authorize';
 let epoch={active:true,generation,deploymentId:deployment};
 const offer=()=>({projectId,stage,releaseSha:sha,releaseGeneration:generation,
  deploymentId:deployment,scopeHash,cutoff,stateHash,
  authorizationId:stage==='authorize'?null:authorizationId,
  missionId,assignmentId,originalRequestId:requestId,
  originalAttempts:1,originalCalls:0,newPaidAttempts:1,
  historicalMissions:84,maxMissions:96,tokenAllowance:600000,nodeCount:13});
 const mock=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>authenticated&&origin},
  '@/lib/projects/mission84-provider-retry':{
   M84_PROVIDER_MISSION:missionId,M84_PROVIDER_ASSIGNMENT:assignmentId,
   mission84ProviderRetryOffer:async()=>offer()
  },
  '@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>canonical},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_org_retest_release_epoch')return epoch;
   if(name==='project_org_m84_provider_retry_authorize'){
    writes++;
    assert.deepEqual(JSON.parse(JSON.stringify(args)),{
     p_owner:ownerId,p_project:projectId,p_release:sha,p_generation:generation,
     p_deployment:deployment,p_mission:missionId,p_assignment:assignmentId,
     p_authorization:authorizationId,p_state_hash:stateHash
    });
    stage='authorized';
    return {...offer(),existing:false,authorizedAt};
   }
   throw Error('Unexpected owner write '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]}
 });
 const route=mock('@/app/api/projects/organization/route');
 const payload={trialAction:'authorize_m84_provider_retry',projectId,
  releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,
  scopeHash,stateHash,missionId,assignmentId,originalRequestId:requestId,
  authorizationId,cutoff,originalAttempts:1,newPaidAttempts:1};
 const post=(body=payload)=>route.POST(new Request('https://katie.test/api/projects/organization',{
  method:'POST',headers:{Origin:'https://katie.test','Content-Type':'application/json'},
  body:JSON.stringify(body)
 }));
 assert.equal((await post()).status,403);
 authenticated=true;origin=false;assert.equal((await post()).status,403);origin=true;
 assert.equal((await (await route.GET(new Request('https://katie.test/api/projects/organization?projectId='+projectId))).json()).mission84ProviderRetry.stage,'authorize');
 for(const mutation of [
  {releaseSha:'c'.repeat(40)},{releaseGeneration:generation+1},
  {deploymentId:'dpl_Elsewhere'},{scopeHash:'d'.repeat(64)},
  {stateHash:'e'.repeat(64)},{missionId:projectId},{assignmentId:projectId},
  {originalRequestId:projectId},{originalAttempts:0},{newPaidAttempts:2},
  {cutoff:'2026-11-27T19:45:00.000Z'}
 ]) assert.notEqual((await post({...payload,...mutation})).status,200);
 epoch={...epoch,active:false};assert.equal((await post()).status,409);
 epoch={...epoch,active:true};canonical=false;assert.equal((await post()).status,409);canonical=true;
 assert.equal(writes,0,'No unauthorized execution or paid attempts');
 const approved=await post();assert.equal(approved.status,200);
 assert.equal((await approved.json()).authorizationId,authorizationId);
 assert.equal(writes,1);
 assert.equal((await post()).status,409,'A second owner click may not mint another retry');
 assert.equal(writes,1);
});

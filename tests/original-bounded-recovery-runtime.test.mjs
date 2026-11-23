import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const missionId='18819669-d4cf-4010-a455-19f5bcbf93cb';
const assignmentId='bd8de51d-0195-4c5f-9c88-9dc39e228636';
const ownerId='04ed6c05-a586-4a56-ba81-1b50e378746b';
const scopeHash='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
const sha='a'.repeat(40),deployment='dpl_BoundedRecoveryNative',generation=33;
const now=Date.parse('2026-11-23T18:00:00Z');
const cutoff=new Date(now+24*3600000).toISOString();
const priorCutoff='2026-11-22T14:00:00.000Z';
const stateHash='b'.repeat(64);
const authorizationId='de1af0ea-22b4-4e0c-9ddb-dccbfad51591';

test('original 84-mission recovery requires signed user, chosen window, exact SHA and one immutable receipt',async t=>{
 const keys=['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','VERCEL_DEPLOYMENT_ID','KATIE_OWNER_AUTH_USER_ID'];
 const prev=Object.fromEntries(keys.map(k=>[k,process.env[k]])),oldNow=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,
  VERCEL_DEPLOYMENT_ID:deployment,KATIE_OWNER_AUTH_USER_ID:ownerId});
 Date.now=()=>now;
 t.after(()=>{Date.now=oldNow;for(const k of keys){if(prev[k]===undefined)delete process.env[k];else process.env[k]=prev[k];}});
 let authenticated=false,origin=true,canonical=true,writes=0,stage='authorize';
 let epoch={active:true,generation,deploymentId:deployment};
 const offer=()=>({projectId,stage,releaseSha:sha,releaseGeneration:generation,
  deploymentId:deployment,scopeHash,priorCutoff,
  cutoff:stage==='authorize'?null:cutoff,stateHash,
  authorizationId:stage==='authorize'?null:authorizationId,
  authorizedAt:stage==='authorize'?undefined:new Date(now).toISOString(),
  historicalMissions:84,maxMissions:96,tokenAllowance:600000,
  usedTokens:0,remainingTokens:600000,remainingMissions:12,
  additionalPaidRetries:0,activeMissionId:missionId,
  assignmentId,nodeCount:13,maxWindowHours:72});
 const mock=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>authenticated&&origin},
  '@/lib/projects/original-bounded-recovery':{
   ORIGINAL_RECOVERY_MISSION:missionId,ORIGINAL_RECOVERY_ASSIGNMENT:assignmentId,
   originalBoundedRecoveryOffer:async()=>offer()
  },
  '@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>canonical},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_org_retest_release_epoch')return epoch;
   if(name==='project_org_bounded_recovery_authorize'){
    writes++;
    assert.deepEqual(JSON.parse(JSON.stringify(args)),{
     p_owner:ownerId,p_project:projectId,p_release:sha,
     p_generation:generation,p_deployment:deployment,
     p_authorization:authorizationId,p_cutoff:cutoff,p_state_hash:stateHash,
     p_mission:missionId,p_assignment:assignmentId,
     p_max_missions:96,p_token_allowance:600000,p_additional_retries:0});
    stage='authorized';
    return {...offer(),stage:'recovered',existing:false,
     authorizedAt:new Date(now).toISOString()};
   }
   throw Error('Unexpected write '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]}
 });
 const route=mock('@/app/api/projects/organization/route');
 const payload={trialAction:'authorize_original_bounded_recovery',projectId,
  releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,
  scopeHash,stateHash,activeMissionId:missionId,assignmentId,
  priorCutoff,cutoff,authorizationId,historicalMissions:84,
  maxMissions:96,tokenAllowance:600000,additionalPaidRetries:0};
 const post=(body=payload)=>route.POST(new Request('https://katie.test/api/projects/organization',{
  method:'POST',headers:{Origin:'https://katie.test','Content-Type':'application/json'},
  body:JSON.stringify(body)
 }));
 assert.equal((await post()).status,403);
 authenticated=true;
 origin=false;assert.equal((await post()).status,403);origin=true;
 assert.equal((await (await route.GET(new Request('https://katie.test/api/projects/organization?projectId='+projectId))).json()).originalBoundedRecovery.stage,'authorize');
 for(const mutation of [
  {releaseSha:'b'.repeat(40)},{releaseGeneration:generation+1},
  {deploymentId:'dpl_Wrong'},{scopeHash:'c'.repeat(64)},
  {stateHash:'f'.repeat(64)},{activeMissionId:projectId},
  {historicalMissions:83},{maxMissions:97},
  {tokenAllowance:600001},{additionalPaidRetries:1},
  {cutoff:priorCutoff},{cutoff:new Date(now+96*3600000).toISOString()}
 ]){
  assert.notEqual((await post({...payload,...mutation})).status,200);
 }
 epoch={...epoch,active:false};assert.equal((await post()).status,409);
 epoch={...epoch,active:true};
 canonical=false;assert.equal((await post()).status,409);canonical=true;
 assert.equal(writes,0);
 const result=await post();assert.equal(result.status,200);
 assert.equal((await result.json()).authorizationId,authorizationId);
 assert.equal(writes,1);
 assert.equal((await post()).status,409,'Owner approval never replays');
 assert.equal(writes,1);
});

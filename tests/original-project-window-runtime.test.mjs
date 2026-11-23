import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const project='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const mission='18819669-d4cf-4010-a455-19f5bcbf93cb';
const assignment='bd8de51d-0195-4c5f-9c88-9dc39e228636';
const owner='04ed6c05-a586-4a56-ba81-1b50e378746b';
const scope='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
const sha='a'.repeat(40),deployment='dpl_OriginalRecovery',generation=28;
const stateHash='b'.repeat(64),cutoff='2026-11-24T12:00:00.000Z';
const clock=Date.parse('2026-11-23T14:00:00Z');

test('original project window: no approval without exact signed owner and explicit bounded deadline/resources',async t=>{
 const vars=['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','VERCEL_DEPLOYMENT_ID','KATIE_OWNER_AUTH_USER_ID'];
 const old=Object.fromEntries(vars.map(k=>[k,process.env[k]])),oldClock=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,
  VERCEL_DEPLOYMENT_ID:deployment,KATIE_OWNER_AUTH_USER_ID:owner});
 Date.now=()=>clock;
 t.after(()=>{Date.now=oldClock;for(const k of vars)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];});
 let authenticated=false,origin=true,canonical=true,writeCount=0,stage='authorize';
 let epoch={active:true,generation,deploymentId:deployment};
 const authorizationId='d4351465-05ea-4bc0-ae86-577c523449fa';
 const offer=()=>({
  projectId:project,stage,releaseSha:sha,releaseGeneration:generation,
  deploymentId:deployment,missionId:mission,assignmentId:assignment,
  priorCutoff:'2026-11-22T14:00:00Z',
  priorWindowId:'2b04302e-8815-4c61-89aa-e35b9baffa82',scopeHash:scope,
  historicalMissions:84,maxMissions:96,missionCeilingMin:84,missionCeilingMax:96,
  tokenAllowance:600000,initialAttemptsPerAssignment:1,
  priorFailureRetryAllowance:0,nodeCount:13,currentAttempts:0,
  authorizationId:stage==='authorize'?null:authorizationId,stateHash,
  ...(stage==='authorize'?{}:{cutoff,authorizedAt:new Date(clock).toISOString(),missionCeiling:96})
 });
 const mock=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>authenticated&&origin},
  '@/lib/projects/original-execution-recovery':{
   ORIGINAL_RECOVERY_MISSION:mission,ORIGINAL_RECOVERY_ASSIGNMENT:assignment,
   originalExecutionRecoveryOffer:async()=>offer()
  },
  '@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>canonical},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_org_retest_release_epoch')return epoch;
   if(name==='project_org_original_window_authorize'){
    writeCount++;assert.deepEqual(JSON.parse(JSON.stringify(args)),{
     p_owner:owner,p_project:project,p_release:sha,p_generation:generation,
     p_deployment:deployment,p_authorization:authorizationId,p_cutoff:cutoff,
     p_mission_ceiling:96,p_token_ceiling:600000,p_initial_attempts:1,
     p_prior_retry_allowance:0,p_state_hash:stateHash
    });
    stage='recovered';
    return {...offer(),stage,existing:false,authorizedAt:new Date(clock).toISOString()};
   }
   throw Error('Unexpected privileged action: '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]}
 });
 const {GET,POST}=mock('@/app/api/projects/organization/route');
 const read=()=>GET(new Request('https://katie.test/api/projects/organization?projectId='+project));
 const body={projectId:project,trialAction:'authorize_original_project_recovery',
  releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,
  missionId:mission,assignmentId:assignment,authorizationId,
  cutoff,missionCeiling:96,tokenCeiling:600000,initialAttemptsPerAssignment:1,
  priorFailureRetryAllowance:0,stateHash};
 const post=(value=body)=>POST(new Request('https://katie.test/api/projects/organization',{
  method:'POST',headers:{Origin:'https://katie.test','Content-Type':'application/json'},
  body:JSON.stringify(value)}));
 assert.equal((await read()).status,403);assert.equal((await post()).status,403);
 authenticated=true;origin=false;assert.equal((await post()).status,403);
 origin=true;assert.equal((await (await read()).json()).originalExecutionRecovery.stage,'authorize');
 assert.equal((await post({...body,missionId:project})).status,400);
 assert.equal((await post({...body,tokenCeiling:700000})).status,400);
 assert.equal((await post({...body,priorFailureRetryAllowance:1})).status,400);
 assert.equal((await post({...body,missionCeiling:97})).status,400);
 assert.equal((await post({...body,cutoff:'2026-11-23T14:05:00Z'})).status,409);
 assert.equal((await post({...body,stateHash:'f'.repeat(64)})).status,409);
 assert.equal((await post({...body,releaseGeneration:generation-1})).status,409);
 epoch={...epoch,active:false};assert.equal((await post()).status,409);
 epoch={...epoch,active:true};
 canonical=false;assert.equal((await post()).status,409);canonical=true;
 assert.equal(writeCount,0);
 const accepted=await post();assert.equal(accepted.status,200);
 const receipt=await accepted.json();
 assert.equal(receipt.authorizationId,authorizationId);assert.equal(receipt.existing,false);
 assert.equal(receipt.missionCeiling,96);assert.equal(writeCount,1);
 assert.equal((await post()).status,409,'One signed owner approval is not reusable');
 assert.equal(writeCount,1);
});

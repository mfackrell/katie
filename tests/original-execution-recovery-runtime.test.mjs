import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const missionId='18819669-d4cf-4010-a455-19f5bcbf93cb';
const assignmentId='bd8de51d-0195-4c5f-9c88-9dc39e228636';
const ownerId='04ed6c05-a586-4a56-ba81-1b50e378746b';
const scope='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
const sha='a'.repeat(40),deployment='dpl_RecoveryExact',generation=29;
const priorCutoff='2026-11-22T14:00:00.000Z';
const now=Date.parse('2026-11-23T14:00:00Z'),cutoff='2026-11-24T14:00:00.000Z';
const stateHash='b'.repeat(64);

test('original 84 mission owner control requires signed session, explicit new cutoff, exact release and bounded claims',async t=>{
 const vars=['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','VERCEL_DEPLOYMENT_ID','KATIE_OWNER_AUTH_USER_ID'];
 const old=Object.fromEntries(vars.map(k=>[k,process.env[k]])),realNow=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,VERCEL_DEPLOYMENT_ID:deployment,KATIE_OWNER_AUTH_USER_ID:ownerId});
 Date.now=()=>now;
 t.after(()=>{Date.now=realNow;for(const k of vars){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}});
 let authenticated=false,origin=true,canonical=true,stage='authorize',writes=0,approved=null;
 let epoch={active:true,generation,deploymentId:deployment};
 const offer=()=>({projectId,stage,missionId,assignmentId,releaseSha:sha,
  releaseGeneration:generation,deploymentId:deployment,scopeHash:scope,
  priorCutoff,cutoff:approved?cutoff:null,authorizationId:approved,
  authorizedAt:approved?new Date(now).toISOString():undefined,
  stateHash:stage==='authorize'?stateHash:undefined,historicalMissions:84,
  maxMissions:96,tokenAllowance:600000,nodeCount:13,currentAttempts:0,
  remainingMissions:stage==='authorize'?12:undefined,maxWindowHours:stage==='authorize'?72:undefined,
  maxClaimsAllowed:stage==='authorize'?26:undefined,
  authorizedTotalMissions:approved?87:undefined,approvedClaims:approved?4:undefined,
  approvedRetries:approved?0:undefined});
 const mock=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>authenticated&&origin},
  '@/lib/projects/original-execution-recovery':{
   ORIGINAL_RECOVERY_MISSION:missionId,ORIGINAL_RECOVERY_ASSIGNMENT:assignmentId,
   originalExecutionRecoveryOffer:async()=>offer()
  },
  '@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>canonical},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_org_retest_release_epoch')return epoch;
   if(name==='project_org_original_execution_recover'){
    writes++;
    assert.deepEqual(JSON.parse(JSON.stringify(args)),{
     p_owner:ownerId,p_project:projectId,p_release:sha,p_generation:generation,
     p_deployment:deployment,p_authorization:'aa50e20e-91be-470f-92b0-459613d58424',
     p_state_hash:stateHash,p_new_cutoff:cutoff,p_new_missions:3,
     p_new_claims:4,p_retry_limit:0});
    approved=args.p_authorization;stage='recovered';
    return {...offer(),existing:false};
   }
   throw Error('Unexpected owner write '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]},
 });
 const {GET,POST}=mock('@/app/api/projects/organization/route');
 const auth='aa50e20e-91be-470f-92b0-459613d58424';
 const body={projectId,trialAction:'authorize_original_execution_recovery',missionId,assignmentId,
  releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,
  authorizationId:auth,stateHash,priorCutoff,cutoff,newMissions:3,maxClaims:4,retryLimit:0};
 const post=(data=body)=>POST(new Request('https://katie.test/api/projects/organization',{
  method:'POST',headers:{Origin:'https://katie.test','Content-Type':'application/json'},body:JSON.stringify(data)}));
 const read=()=>GET(new Request('https://katie.test/api/projects/organization?projectId='+projectId));
 assert.equal((await read()).status,403);
 assert.equal((await post()).status,403);
 authenticated=true;origin=false;assert.equal((await post()).status,403);origin=true;
 assert.equal((await (await read()).json()).originalExecutionRecovery.stage,'authorize');
 for(const invalid of [
  {...body,ownerId:'forged'}, {...body,missionId:projectId},
  {...body,cutoff:priorCutoff},{...body,cutoff:'2026-11-28T14:00:00.000Z'},
  {...body,newMissions:13},{...body,maxClaims:27},{...body,maxClaims:9},
  {...body,retryLimit:2}
 ])assert.notEqual((await post(invalid)).status,200,'No invalid or unselected owner terms can commit');
 assert.equal(writes,0);
 assert.equal((await post({...body,releaseGeneration:generation+1})).status,409);
 assert.equal((await post({...body,stateHash:'e'.repeat(64)})).status,409);
 assert.equal((await post({...body,deploymentId:'dpl_Wrong'})).status,409);
 epoch={active:false,generation,deploymentId:deployment};
 assert.equal((await post()).status,409);epoch={active:true,generation,deploymentId:deployment};
 canonical=false;assert.equal((await post()).status,409);canonical=true;
 assert.equal(writes,0);
 const ok=await post();assert.equal(ok.status,200);
 const receipt=await ok.json();
 assert.equal(receipt.authorizationId,auth);assert.equal(receipt.stage,'recovered');
 assert.equal(receipt.authorizedTotalMissions,87);assert.equal(receipt.approvedClaims,4);
 assert.equal(writes,1);
 assert.equal((await post()).status,409,'Original owner approval cannot be replayed');
 assert.equal(writes,1);
});

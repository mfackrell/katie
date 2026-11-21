import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const missionId='b7c2e557-83e1-41cb-b174-bdb0d77d12e5';
const assignmentId='85e229aa-e571-43ef-9d4a-5cb64f4efcd1';
const sha='a'.repeat(40),deployment='dpl_NativeOwnerRetry',generation=13;
const ownerId='04ed6c05-a586-4a56-ba81-1b50e378746b';
const stateHash='b'.repeat(64),scopeHash='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
const cutoff='2026-11-22T14:00:00.000Z';
const now=Date.parse('2026-11-21T15:00:00.000Z');

test('owner retry POST requires exact authenticated owner, epoch, alias, existing cutoff, replay resistance',async t=>{
 const keys=['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','VERCEL_DEPLOYMENT_ID','KATIE_OWNER_AUTH_USER_ID'];
 const old=Object.fromEntries(keys.map(k=>[k,process.env[k]])),oldNow=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,
  VERCEL_DEPLOYMENT_ID:deployment,KATIE_OWNER_AUTH_USER_ID:ownerId});
 Date.now=()=>now;
 t.after(()=>{Date.now=oldNow;for(const k of keys){
  if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];
 }});
 let owner=false,live=true,epoch={active:true,generation,deploymentId:deployment},writes=0,stage='approve_retry';
 const authorizationId='a083ef03-80b0-44ac-9e24-6e66b223f017';
 const offer=()=>({projectId,stage,releaseSha:sha,releaseGeneration:generation,
  deploymentId:deployment,missionId,assignmentId,scopeHash,cutoff,
  authorizationId:null,originalAttempts:1,originalCalls:1,historicalMissions:79,
  maxMissions:96,tokenAllowance:600000,nodeCount:13,stateHash});
 const mock=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},
  '@/lib/projects/mission79-retry':{mission79RetryOffer:async()=>offer()},
  '@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>live},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_org_retest_release_epoch')return epoch;
   if(name==='project_org_mission79_retry_authorize'){
    writes++;
    assert.deepEqual(JSON.parse(JSON.stringify(args)),{
     p_owner:ownerId,p_project:projectId,p_release:sha,
     p_mission:missionId,p_assignment:assignmentId,
     p_authorization:authorizationId,p_cutoff:cutoff,p_state_hash:stateHash,
     p_generation:generation,p_deployment:deployment
    });
    stage='authorized';
    return {...offer(),stage,authorizationId,authorizedAt:new Date(now).toISOString(),existing:false};
   }
   throw Error('Unexpected SQL RPC '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]}
 });
 const {GET,POST}=mock('@/app/api/projects/organization/route');
 const read=()=>GET(new Request('https://katie.test/api/projects/organization?projectId='+projectId));
 const payload={trialAction:'authorize_mission79_failed_retry',projectId,missionId,
  assignmentId,releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,
  authorizationId,cutoff,stateHash};
 const post=(body=payload,opts={})=>POST(new Request('https://katie.test/api/projects/organization',{
  method:'POST',headers:{Origin:opts.origin??'https://katie.test','Content-Type':'application/json'},
  body:JSON.stringify(body)
 }));
 assert.equal((await read()).status,403);
 assert.equal((await post()).status,403);owner=true;
 assert.equal((await (await read()).json()).mission79Retry.stage,'approve_retry');
 assert.equal((await post({...payload,missionId:projectId})).status,400);
 assert.equal((await post({...payload,ownerId:'forged'})).status,400);
 assert.equal((await post({...payload,releaseGeneration:generation-1})).status,409);
 assert.equal((await post({...payload,deploymentId:'dpl_Other'})).status,409);
 assert.equal((await post({...payload,cutoff:'2026-11-22T13:59:00.000Z'})).status,409);
 assert.equal((await post({...payload,stateHash:'f'.repeat(64)})).status,409);
 epoch={...epoch,active:false};assert.equal((await post()).status,409);
 epoch={active:true,generation,deploymentId:deployment};
 live=false;assert.equal((await post()).status,409);live=true;
 assert.equal(writes,0);
 const response=await post();
 assert.equal(response.status,200);
 const result=await response.json();
 assert.equal(result.authorizationId,authorizationId);
 assert.equal(result.originalAttempts,1);
 assert.equal(result.originalCalls,1);
 assert.equal(result.existing,false);
 assert.equal(writes,1,'Owner created one receipt, no inference');
 assert.equal((await (await read()).json()).mission79Retry.stage,'authorized');
 assert.equal((await post()).status,409,'Replay rejected before SQL writer');
 assert.equal(writes,1);
});

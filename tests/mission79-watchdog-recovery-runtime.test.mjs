import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';
const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const missionId='b7c2e557-83e1-41cb-b174-bdb0d77d12e5';
const assignmentId='85e229aa-e571-43ef-9d4a-5cb64f4efcd1';
const ownerId='04ed6c05-a586-4a56-ba81-1b50e378746b';
const priorAuthorizationId='e3dc041f-6a33-4568-a844-51f5189cefcc';
const sha='a'.repeat(40),deployment='dpl_WatchdogRepairCurrent',generation=18;
const scopeHash='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
const cutoff='2026-11-22T14:00:00.000Z',stateHash='b'.repeat(64);
const now=Date.parse('2026-11-21T17:20:00.000Z');

test('watchdog recovery requires authenticated owner, exact current release, unchanged first receipt, and one signed action',async t=>{
 const keys=['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','VERCEL_DEPLOYMENT_ID','KATIE_OWNER_AUTH_USER_ID'];
 const original=Object.fromEntries(keys.map(k=>[k,process.env[k]])),originalNow=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,
  VERCEL_DEPLOYMENT_ID:deployment,KATIE_OWNER_AUTH_USER_ID:ownerId});
 Date.now=()=>now;
 t.after(()=>{Date.now=originalNow;for(const k of keys){
  if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k];
 }});
 let owner=false,live=true,writes=0,stage='recover_watchdog';
 let epoch={active:true,generation,deploymentId:deployment};
 const authorizationId='d4351465-05ea-4bc0-ae86-577c523449fa';
 const offer=()=>({projectId,stage,releaseSha:sha,releaseGeneration:generation,
  deploymentId:deployment,missionId,assignmentId,scopeHash,cutoff,
  authorizationId:null,priorAuthorizationId,originalAttempts:1,originalCalls:1,
  historicalMissions:79,maxMissions:96,tokenAllowance:600000,nodeCount:13,stateHash});
 const mock=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},
  '@/lib/projects/mission79-retry':{mission79RetryOffer:async()=>offer()},
  '@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>live},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_org_retest_release_epoch')return epoch;
   if(name==='project_org_mission79_watchdog_recover'){
    writes++;
    assert.deepEqual(JSON.parse(JSON.stringify(args)),{
     p_owner:ownerId,p_project:projectId,p_release:sha,
     p_mission:missionId,p_assignment:assignmentId,
     p_authorization:authorizationId,p_prior_authorization:priorAuthorizationId,
     p_cutoff:cutoff,p_state_hash:stateHash,p_generation:generation,p_deployment:deployment
    });
    stage='recovered';
    return {...offer(),stage,authorizationId,authorizedAt:new Date(now).toISOString(),existing:false};
   }
   throw Error('Unexpected RPC '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]}
 });
 const {GET,POST}=mock('@/app/api/projects/organization/route');
 const read=()=>GET(new Request('https://katie.test/api/projects/organization?projectId='+projectId));
 const body={trialAction:'authorize_mission79_watchdog_recovery',projectId,missionId,
  assignmentId,releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,
  authorizationId,priorAuthorizationId,cutoff,stateHash};
 const post=(p=body)=>POST(new Request('https://katie.test/api/projects/organization',{
  method:'POST',headers:{Origin:'https://katie.test','Content-Type':'application/json'},
  body:JSON.stringify(p)
 }));
 assert.equal((await read()).status,403);
 assert.equal((await post()).status,403);
 owner=true;
 assert.equal((await (await read()).json()).mission79Retry.stage,'recover_watchdog');
 assert.equal((await post({...body,missionId:projectId})).status,400);
 assert.equal((await post({...body,ownerId:'forged'})).status,400);
 assert.equal((await post({...body,priorAuthorizationId:authorizationId})).status,409);
 assert.equal((await post({...body,releaseGeneration:generation-1})).status,409);
 assert.equal((await post({...body,deploymentId:'dpl_Other'})).status,409);
 assert.equal((await post({...body,stateHash:'f'.repeat(64)})).status,409);
 assert.equal((await post({...body,cutoff:'2026-11-22T13:50:00.000Z'})).status,409);
 epoch={active:false,generation,deploymentId:deployment};
 assert.equal((await post()).status,409);
 epoch={active:true,generation,deploymentId:deployment};
 live=false;assert.equal((await post()).status,409);live=true;
 assert.equal(writes,0);
 const r=await post();assert.equal(r.status,200);
 const receipt=await r.json();assert.equal(receipt.stage,'recovered');
 assert.equal(receipt.authorizationId,authorizationId);
 assert.equal(receipt.priorAuthorizationId,priorAuthorizationId);
 assert.equal(writes,1);
 assert.equal((await post()).status,409,'Signed same-user approval cannot replay');
 assert.equal(writes,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const missionId='ce8dcc30-e316-49e7-934d-6add6c14a697';
const assignmentId='3d118a6c-d121-4d65-8c6e-ed5620660b82';
const ownerId='04ed6c05-a586-4a56-ba81-1b50e378746b';
const scopeHash='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
const sha='c'.repeat(40),deployment='dpl_CurrentMission80',generation=23;
const cutoff='2026-11-22T14:00:00.000Z',stateHash='b'.repeat(64);
const now=Date.parse('2026-11-21T19:00:00Z');

test('Mission80 one-time owner recovery requires authentic session, exact release and unchanged blocked-state hash',async t=>{
 const vars=['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','VERCEL_DEPLOYMENT_ID','KATIE_OWNER_AUTH_USER_ID'];
 const initial=Object.fromEntries(vars.map(k=>[k,process.env[k]])),oldNow=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,
  VERCEL_DEPLOYMENT_ID:deployment,KATIE_OWNER_AUTH_USER_ID:ownerId});
 Date.now=()=>now;
 t.after(()=>{Date.now=oldNow;for(const k of vars){
  if(initial[k]===undefined)delete process.env[k];else process.env[k]=initial[k];
 }});
 let authenticated=false,origin=true,live=true,writes=0,stage='recover_watchdog',signed=null;
 let epoch={active:true,generation,deploymentId:deployment};
 const authorizationId='d4351465-05ea-4bc0-ae86-577c523449fa';
 const offer=()=>({projectId,stage,releaseSha:sha,releaseGeneration:generation,
  deploymentId:deployment,missionId,assignmentId,scopeHash,cutoff,
  authorizationId:signed,authorizedAt:signed?new Date(now).toISOString():undefined,
  historicalMissions:80,maxMissions:96,tokenAllowance:600000,nodeCount:13,
  currentAttempts:0,stateHash});
 const mock=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>authenticated&&origin},
  '@/lib/projects/mission80-watchdog':{
   MISSION80_ID:missionId,MISSION80_ASSIGNMENT:assignmentId,mission80WatchdogOffer:async()=>offer()
  },
  '@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>live},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_org_retest_release_epoch')return epoch;
   if(name==='project_org_mission80_watchdog_recover'){
    writes++;
    assert.deepEqual(JSON.parse(JSON.stringify(args)),{
     p_owner:ownerId,p_project:projectId,p_release:sha,
     p_mission:missionId,p_assignment:assignmentId,p_authorization:authorizationId,
     p_cutoff:cutoff,p_state_hash:stateHash,p_generation:generation,p_deployment:deployment
    });
    stage='recovered';signed=authorizationId;
    return {...offer(),existing:false,authorizedAt:new Date(now).toISOString()};
   }
   throw Error('Unexpected write '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]}
 });
 const {GET,POST}=mock('@/app/api/projects/organization/route');
 const read=()=>GET(new Request('https://katie.test/api/projects/organization?projectId='+projectId));
 const body={trialAction:'authorize_mission80_watchdog_recovery',projectId,missionId,
  assignmentId,releaseSha:sha,releaseGeneration:generation,deploymentId:deployment,
  authorizationId,cutoff,stateHash};
 const post=(payload=body)=>POST(new Request('https://katie.test/api/projects/organization',{
  method:'POST',headers:{Origin:'https://katie.test','Content-Type':'application/json'},
  body:JSON.stringify(payload)
 }));
 assert.equal((await read()).status,403);
 assert.equal((await post()).status,403);
 authenticated=true;
 origin=false;assert.equal((await post()).status,403);origin=true;
 assert.equal((await (await read()).json()).mission80Recovery.stage,'recover_watchdog');
 assert.equal((await post({...body,missionId:projectId})).status,400);
 assert.equal((await post({...body,ownerId:'forged'})).status,400);
 assert.equal((await post({...body,releaseGeneration:generation-1})).status,409);
 assert.equal((await post({...body,deploymentId:'dpl_Wrong'})).status,409);
 assert.equal((await post({...body,stateHash:'f'.repeat(64)})).status,409);
 assert.equal((await post({...body,cutoff:'2026-11-22T13:00:00.000Z'})).status,409);
 epoch={active:false,generation,deploymentId:deployment};
 assert.equal((await post()).status,409);
 epoch={active:true,generation,deploymentId:deployment};
 live=false;assert.equal((await post()).status,409);live=true;
 assert.equal(writes,0,'No API owner authorization can be inferred from offer or wrong release');
 const ok=await post();assert.equal(ok.status,200);
 const receipt=await ok.json();
 assert.equal(receipt.stage,'recovered');assert.equal(receipt.existing,false);
 assert.equal(receipt.authorizationId,authorizationId);assert.equal(writes,1);
 assert.equal((await post()).status,409,'Original owner POST cannot replay the new recovery');
 assert.equal(writes,1);
});

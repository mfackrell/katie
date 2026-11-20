import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const missionId='b7c2e557-83e1-41cb-b174-bdb0d77d12e5';
const assignmentId='85e229aa-e571-43ef-9d4a-5cb64f4efcd1';
const sourceId='911d15bd-be5f-416e-bbac-fbe86ca6fa90';
const windowId='7d216bbe-596e-457e-b84d-e07ad1e80365';
const sha='a'.repeat(40),stateHash='b'.repeat(64),deploymentId='dpl_Original79Verified',generation=3;
const cutoff='2026-11-20T17:00:00.000Z',authorizationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('release identity explicitly isolates each failed comparison without falling back to browser identity',()=>{
 const {mission79ReleaseIdentityFailure:check,mission79ReleaseIdentityMessage:message}
  =modules()('@/lib/projects/mission79-release-identity');
 const valid={active:true,generation,deploymentId};
 const selected={releaseGeneration:generation,deploymentId};
 assert.equal(check(valid,selected,deploymentId),null);
 const cases=[
  [null,selected,deploymentId,'inactive_release_gate'],
  [{...valid,active:false},selected,deploymentId,'inactive_release_gate'],
  [{...valid,generation:0},selected,deploymentId,'invalid_database_release_epoch'],
  [{...valid,deploymentId:null},selected,deploymentId,'invalid_database_release_epoch'],
  [valid,selected,undefined,'runtime_deployment_id_missing'],
  [valid,selected,'a'.repeat(40),'runtime_deployment_id_invalid'],
  [valid,selected,'dpl_OtherVerifiedRuntime','runtime_deployment_id_mismatch'],
  [valid,{...selected,releaseGeneration:2},deploymentId,'stale_release_generation'],
  [valid,{...selected,deploymentId:'dpl_OtherOwnerOffer'},deploymentId,'stale_owner_deployment_offer']
 ];
 for(const [epoch,payload,runtime,expected] of cases){
  const failure=check(epoch,payload,runtime);
  assert.equal(failure,expected);
  const error=message(failure);
  assert.equal(typeof error,'string');assert.ok(error.length>20);
  assert.doesNotMatch(error,/Bearer|apikey|service_role/i);
 }
});

test('owner POST refuses absent or mismatched Vercel deployment ID and stale generation, but accepts exact Vercel identity once',async t=>{
 const keys=['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','VERCEL_DEPLOYMENT_ID','KATIE_OWNER_AUTH_USER_ID'];
 const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 const oldNow=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,
  VERCEL_DEPLOYMENT_ID:deploymentId,KATIE_OWNER_AUTH_USER_ID:ownerId});
 Date.now=()=>Date.parse('2026-11-20T16:00:00Z');
 t.after(()=>{Date.now=oldNow;for(const k of keys){
  if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];
 }});
 let owner=true,stage='authorize',epoch={active:true,generation,deploymentId},writes=0,aliasChecks=0;
 const base={projectId,releaseSha:sha,releaseGeneration:generation,deploymentId,
  sourceMissionId:sourceId,missionId,assignmentId,priorWindowId:windowId,
  scopeHash:'4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6',
  priorCutoff:'2026-11-18T14:00:00Z',cutoff:null,authorizationId:null,
  historicalMissions:79,maxMissions:96,tokenAllowance:600000,nodeCount:13,
  stateHash,status:'blocked',missionStatus:'blocked'};
 const load=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},
  '@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>{aliasChecks++;return true;}},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_org_retest_release_epoch')return epoch;
   if(name==='project_org_retest_future_window_offer')return {...base,stage};
   if(name==='project_org_authorize_retest_future_window'){
    writes++;assert.equal(args.p_epoch,generation);
    assert.equal(args.p_deployment,deploymentId);
    stage='authorized';
    return {...base,stage,authorizationId,cutoff,authorizedAt:'2026-11-20T16:00:01Z',existing:false};
   }
   throw Error('Unexpected database mutation '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]},
 });
 const {POST}=load('@/app/api/projects/organization/route');
 const payload={trialAction:'authorize_mission79_future_window',projectId,
  releaseSha:sha,releaseGeneration:generation,deploymentId,
  missionId,assignmentId,authorizationId,cutoff,stateHash};
 const request=()=>new Request('https://owner.example.test/api/projects/organization',{
  method:'POST',headers:{Origin:'https://owner.example.test','Content-Type':'application/json'},
  body:JSON.stringify(payload)});
 owner=false;assert.equal((await POST(request())).status,403);
 assert.equal(writes,0);owner=true;
 delete process.env.VERCEL_DEPLOYMENT_ID;
 let result=await POST(request());assert.equal(result.status,409);
 assert.equal((await result.json()).code,'runtime_deployment_id_missing');
 assert.equal(writes,0);assert.equal(aliasChecks,0);
 process.env.VERCEL_DEPLOYMENT_ID='dpl_OtherRuntime';
 result=await POST(request());assert.equal(result.status,409);
 assert.equal((await result.json()).code,'runtime_deployment_id_mismatch');
 assert.equal(writes,0);
 process.env.VERCEL_DEPLOYMENT_ID=deploymentId;
 epoch={active:true,generation:4,deploymentId};
 result=await POST(request());assert.equal(result.status,409);
 assert.equal((await result.json()).code,'stale_release_generation');
 assert.equal(writes,0);
 epoch={active:true,generation,deploymentId:'dpl_OtherDatabaseRelease'};
 result=await POST(request());assert.equal(result.status,409);
 assert.equal((await result.json()).code,'runtime_deployment_id_mismatch');
 assert.equal(writes,0);
 epoch={active:true,generation,deploymentId};
 result=await POST(request());assert.equal(result.status,200);
 assert.equal((await result.json()).authorizationId,authorizationId);
 assert.equal(writes,1);assert.equal(aliasChecks,1);
 result=await POST(request());assert.equal(result.status,409);
 assert.equal(writes,1,'No second receipt or duplicate execution window');
});

test('protected canonical version verification uses only authenticated owner cookie or existing server-side automation credential',async t=>{
 const keys=['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','VERCEL_DEPLOYMENT_ID','VERCEL_AUTOMATION_BYPASS_SECRET','CRON_SECRET'];
 const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,
  VERCEL_DEPLOYMENT_ID:deploymentId,CRON_SECRET:'fixture-cron-secret-for-authority-79'});
 delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
 t.after(()=>{for(const k of keys){
  if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];
 }});
 const {verifyMission79ActiveProductionSha}=modules()('@/lib/projects/mission79-active-release');
 let calls=0, seen=null, version=sha, id=deploymentId;
 const securedFetch=async(url,options)=>{
  calls++;seen=options.headers;
  assert.equal(new URL(url).origin,'https://katie-mu.vercel.app');
  assert.equal(new URL(url).pathname,'/api/version');
  assert.equal(options.redirect,'error');
  const credential=seen.Cookie==='__vercel_jwt=synthetic-owner-cookie'
   ||seen['x-vercel-protection-bypass']==='synthetic-server-only-bypass';
  return new Response(JSON.stringify({version,deploymentId:id}),
   {status:credential?200:401,headers:{'Content-Type':'application/json'}});
 };
 assert.equal(await verifyMission79ActiveProductionSha(sha,securedFetch),false);
 assert.equal(calls,1,'No unauthenticated server-to-server read passes SSO protection');
 assert.equal(await verifyMission79ActiveProductionSha(sha,securedFetch,
  '__vercel_jwt=synthetic-owner-cookie'),true);
 assert.equal(seen.Cookie,'__vercel_jwt=synthetic-owner-cookie');
 assert.equal(seen['x-vercel-protection-bypass'],undefined);
 process.env.VERCEL_AUTOMATION_BYPASS_SECRET='synthetic-server-only-bypass';
 assert.equal(await verifyMission79ActiveProductionSha(sha,securedFetch),true,
  'Legitimate Vercel automation credential allows unattended worker verification');
 assert.equal(seen['x-vercel-protection-bypass'],'synthetic-server-only-bypass');
 assert.equal(seen.Cookie,undefined,'Never forward an owner cookie when the server credential is available');
 id='dpl_SupersededDeployment';
 assert.equal(await verifyMission79ActiveProductionSha(sha,securedFetch),false,
  'Even authenticated protected version response must match the exact deployment');
 delete process.env.VERCEL_DEPLOYMENT_ID;
 const previousCalls=calls;
 assert.equal(await verifyMission79ActiveProductionSha(sha,securedFetch),false,
  'No credential or public response can replace missing trusted Vercel runtime identity');
 assert.equal(calls,previousCalls,'Missing runtime ID fails closed before protected fetch');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const missionId='b7c2e557-83e1-41cb-b174-bdb0d77d12e5';
const assignmentId='85e229aa-e571-43ef-9d4a-5cb64f4efcd1';
const current='a'.repeat(40),previous='b'.repeat(40);
const actorId='11111111-1111-4111-8111-111111111111';
const chatId='22222222-2222-4222-8222-222222222222';

function env(t){
 const keys=['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','VERCEL_DEPLOYMENT_ID'];
 const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:current,VERCEL_DEPLOYMENT_ID:'dpl_CurrentFixture79'});
 t.after(()=>{for(const k of keys){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}});
}

test('owner project status displays a release mismatch, not stale legacy approval buttons',async t=>{
 env(t);
 let owner=true,epochActive=false,legacyCalls=0,mutationCalls=0;
 const {GET}=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},
  '@/lib/projects/mission79-future-window':{mission79FutureWindowOffer:async()=>{throw Error('Original release generation mismatch');}},
  '@/lib/projects/blocked-management-retest':{blockedManagementRetestOffer:async()=>{legacyCalls++;throw Error('No legacy state');}},
  '@/lib/projects/management-activation':{APPROVED_TTT_CUTOFF:'2026-11-16T18:00:00Z',ORIGINAL_TTT_PROJECT:projectId,managementActivationOffer:async()=>{legacyCalls++;throw Error('No legacy state');}},
  '@/lib/projects/blocked-owner-recovery':{blockedOwnerRecoveryOffer:async()=>{legacyCalls++;throw Error('No legacy state');}},
  '@/lib/data/persistence-store':{getChatById:async()=>({actorId}),getMessages:async()=>[]},
  '@/lib/projects/store':{projectForChat:async()=>({id:projectId,organization_version:1,phase:'development',status:'blocked',deadline:'2026-11-18T14:00:00Z'}),
   projectRpc:async(name,args)=>{
    if(name==='project_provider_mode')return true;
    if(name==='project_org_retest_release_epoch'){assert.equal(args.p_release,current);return {generation:1,active:epochActive,deploymentId:'dpl_ApprovedOld'};}
    mutationCalls++;throw Error('Unexpected project mutation');
   }},
  '@/lib/executive/delivery':{hasPendingExecutiveDelivery:async()=>false},
 })('@/app/api/projects/route');
 const request=()=>{
  const r=new Request('https://synthetic.test/api/projects?actorId='+actorId+'&chatId='+chatId);
  r.nextUrl=new URL(r.url);return r;
 };
 const response=await GET(request());assert.equal(response.status,200);
 const data=await response.json();
 assert.match(data.directorRecovery.managementActivationError,/current production deployment does not match/i);
 assert.match(data.directorRecovery.managementActivationError,/No owner approval was recorded/);
 assert.equal(data.directorRecovery.managementRetest,undefined);
 assert.equal(data.directorRecovery.managementActivation,undefined);
 assert.equal(legacyCalls,0,'Do not fall back to unrelated owner controls when drift is known');
 assert.equal(mutationCalls,0);
 owner=false;assert.equal((await (await GET(request())).json()).directorRecovery,null);
 assert.equal(mutationCalls,0);
});

test('original owner endpoint rejects drift with precise 409 before a durable authorization RPC',async t=>{
 env(t);
 let owner=true,rpcWrites=0,legacyReads=0,offerCalls=0,epochReads=0;
 // Only these exact read-only offer RPCs belong to the original GET cascade.
 // All other RPCs except the epoch lookup remain forbidden and counted as writes.
 const readOnlyOffers=[
  'project_org_coding_capacity_offer',
  'project_org_followup_context_retest_offer',
  'project_org_context_retest_offer',
  'project_org_m84_provider_retry_offer',
  'project_org_bounded_recovery_offer',
  'project_org_mission82_watchdog_offer',
  'project_org_mission80_watchdog_offer',
 ];
 const offerReads=[];
 const {GET,POST}=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},
  // The independent failed-attempt offer is a read-only preflight on current
  // main. It must not be counted as a durable owner-authorization RPC.
  '@/lib/projects/mission79-retry':{mission79RetryOffer:async()=>{throw Error('No authorized failed-attempt retry offer');}},
  '@/lib/projects/mission79-future-window':{MISSION79_ID:missionId,MISSION79_ASSIGNMENT:assignmentId,
   mission79FutureWindowOffer:async()=>{offerCalls++;throw Error('Observed epoch does not match current alias');}},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_org_retest_release_epoch'){
    epochReads++;
    assert.equal(args.p_project,projectId);
    assert.equal(args.p_release,current);
    return {generation:1,active:false,deploymentId:'dpl_ApprovedOld'};
   }
   if(readOnlyOffers.includes(name)){
    offerReads.push([name,args.p_project,args.p_release]);
    throw Error('No current recovery offer: '+name);
   }
   rpcWrites++;throw Error('Unexpected authorization write: '+name);
  }},
  '@/lib/projects/blocked-management-retest':{blockedManagementRetestOffer:async()=>{legacyReads++;throw Error('No recovery');}},
  '@/lib/projects/management-activation':{ORIGINAL_TTT_PROJECT:projectId,APPROVED_TTT_CUTOFF:'2026-11-16T18:00:00Z',managementActivationOffer:async()=>{legacyReads++;throw Error('No recovery');}},
  '@/lib/projects/blocked-owner-recovery':{blockedOwnerRecoveryOffer:async()=>{legacyReads++;throw Error('No recovery');}},
 })('@/app/api/projects/organization/route');
 const read=()=>new Request('https://synthetic.test/api/projects/organization?projectId='+projectId);
 const post=body=>new Request('https://synthetic.test/api/projects/organization',{method:'POST',
  headers:{'Content-Type':'application/json',Origin:'https://synthetic.test'},body:JSON.stringify(body)});
 const approval={trialAction:'authorize_mission79_future_window',projectId,releaseSha:current,
  missionId,assignmentId,releaseGeneration:1,deploymentId:'dpl_ApprovedOld',
  authorizationId:'33333333-3333-4333-8333-333333333333',
  cutoff:new Date(Date.now()+3600000).toISOString(),stateHash:'f'.repeat(64)};
 const readResponse=await GET(read());assert.equal(readResponse.status,409);
 assert.match((await readResponse.json()).error,/Recovery state unavailable/);
 assert.equal(legacyReads,3,'Legacy read-only GET recovery behavior remains intact');
 assert.deepEqual(offerReads,readOnlyOffers.map(name=>[name,projectId,current]),'GET checks only the exact current offer cascade');
 assert.equal(epochReads,0);
 assert.equal(rpcWrites,0,'GET must not attempt any authorization mutation');
 const submit=await POST(post(approval));assert.equal(submit.status,409);
 assert.equal((await submit.json()).code,'mission79_release_mismatch');
 assert.equal(offerCalls,1,'Only GET checks its offer; POST refuses before invoking it');
 assert.equal(epochReads,1,'POST must check the epoch exactly once before refusing');
 assert.deepEqual(offerReads,readOnlyOffers.map(name=>[name,projectId,current]),'POST must not probe alternative offers on mismatch');
 assert.equal(rpcWrites,0,'No immutable owner receipt can be created on wrong epoch');
 owner=false;
 assert.equal((await GET(read())).status,403);
 assert.equal((await POST(post(approval))).status,403);
 assert.equal(epochReads,1,'Unauthenticated requests cannot reach the epoch RPC');
 assert.deepEqual(offerReads,readOnlyOffers.map(name=>[name,projectId,current]),'Unauthenticated requests cannot read recovery offers');
 assert.equal(rpcWrites,0);
});

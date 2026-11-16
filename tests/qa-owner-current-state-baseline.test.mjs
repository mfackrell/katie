import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const project='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const scope='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
const oldCutoff='2026-11-16T18:00:00Z';
const legacyRelease='6a93ea83d59531bdcdde88eb2088b432367172a5';
const activeRelease='3a55f4cb20cbaed8e3f48626dc46299bbca10841';
const ownerId='11111111-1111-4111-8111-111111111111';
const authorizationId='a08d3cac-6e3f-4c14-a75a-5f524987a676';
const historicalOffer={
  projectId:project,stage:'resumed',releaseSha:legacyRelease,scopeHash:scope,
  sourceMissionId:'62cd8da3-1bcc-41ae-9470-574c6b05e420',authorizationId,
  windowId:authorizationId,cutoff:oldCutoff,stateHash:'a'.repeat(64),
  status:'blocked',historicalMissions:76,maxMissions:96,tokenAllowance:600000,nodeCount:13,
};

test('released baseline cannot silently renew a blocked/expired project with consumed owner receipts',async t=>{
  const originalDateNow=Date.now;
  const saved=Object.fromEntries(['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','KATIE_OWNER_AUTH_USER_ID'].map(k=>[k,process.env[k]]));
  t.after(()=>{Date.now=originalDateNow;for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  Date.now=()=>Date.parse('2026-11-16T20:15:00Z');
  Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:activeRelease,KATIE_OWNER_AUTH_USER_ID:ownerId});
  let authenticated=true;
  const calls=[];
  const {GET,POST}=modules({
    '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>authenticated},
    '@/lib/missions/store':{rpc:async(name,args)=>{
      calls.push({name,args});
      if(name==='project_org_management_activation_offer')return historicalOffer;
      assert.fail('No baseline write RPC may be invoked in this characterization: '+name);
    }},
    '@/lib/data/persistence-store':{getMessages:async()=>assert.fail('No published messages allowed')},
  })('@/app/api/projects/organization/route');
  const get=()=>GET(new Request('https://synthetic.invalid/api/projects/organization?projectId='+project));
  const post=body=>POST(new Request('https://synthetic.invalid/api/projects/organization',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
  }));
  // The consumed receipt belongs to a historic release. The current release
  // cannot reuse it as new authorization. Only read-only preflight is reached.
  const preflight=await get();
  assert.equal(preflight.status,409);
  assert.deepEqual(calls.map(c=>c.name),['project_org_management_activation_offer']);

  authenticated=false;
  assert.equal((await get()).status,403);
  assert.equal((await post({trialAction:'authorize_new_window'})).status,403);
  assert.equal(calls.length,1,'unauthenticated requests must not invoke authority');
  authenticated=true;

  const oldResume={projectId:project,trialAction:'resume_management',releaseSha:activeRelease,
    authorizationId,stateHash:'a'.repeat(64),cutoff:oldCutoff};
  assert.equal((await post(oldResume)).status,409,
    'replayed expired resume receipt never triggers management');
  const oldRenew={projectId:project,trialAction:'renew_paused_window',releaseSha:activeRelease,
    expectedReleaseSha:'c1d9a5f1ac10396c3015a7d5ae5f22254502e5de',
    scopeHash:scope,sourceMissionId:historicalOffer.sourceMissionId,
    priorWindowId:'a837004e-75d3-497d-b05a-482886ed5a5f',
    priorCutoff:'2026-11-15T18:00:00Z',cutoff:oldCutoff,
    authorizationId,stateHash:'a'.repeat(64)};
  assert.equal((await post(oldRenew)).status,409,
    'expired one-shot renewal cannot renew the same project again');
  assert.equal((await post({projectId:project,releaseSha:activeRelease,
    trialAction:'authorize_current_state',cutoff:'2026-11-17T18:00:00Z',
    authorizationId,stateHash:'a'.repeat(64)})).status,400,
    'released baseline has no approved current-state transition command');
  assert.equal(calls.length,1,'old and unsupported requests create zero state changes');
  console.log('QA_OWNER_CURRENT_STATE_BASELINE_GAP_PASS: blocked/expired/consumed receipt not renewed or resumed; only read-only offer; 96/600000/13 preserved in synthetic record');
});

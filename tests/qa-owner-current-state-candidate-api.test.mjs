import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const project='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const oldWindow='a08d3cac-6e3f-4c14-a75a-5f524987a676';
const originalCutoff='2026-11-16T18:00:00Z';
const oldRelease='6a93ea83d59531bdcdde88eb2088b432367172a5';
const activeRelease='a'.repeat(40);
const owner='11111111-1111-4111-8111-111111111111';
const scope='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
const source='62cd8da3-1bcc-41ae-9470-574c6b05e420';
const authorizationId='22222222-2222-4222-8222-222222222222';
const cutoff='2026-11-16T22:30:00Z';

test('independent first-party owner authorization and separate management resume remain two actions',async t=>{
  const now=Date.now;
  const saved=Object.fromEntries(['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','KATIE_OWNER_AUTH_USER_ID'].map(k=>[k,process.env[k]]));
  t.after(()=>{Date.now=now;for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  Date.now=()=>Date.parse('2026-11-16T21:30:00Z');
  Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:activeRelease,KATIE_OWNER_AUTH_USER_ID:owner});
  let verified=true,stage='authorize',hash='a'.repeat(64),receiptCutoff=null,authId=null;
  const calls=[];
  const offer=()=>({
    projectId:project,stage,releaseSha:activeRelease,expectedReleaseSha:oldRelease,scopeHash:scope,
    sourceMissionId:source,priorWindowId:oldWindow,
    windowId:authId??oldWindow,priorCutoff:originalCutoff,cutoff:receiptCutoff,
    authorizationId:authId,stateHash:hash,status:stage==='resumed'?'running':'blocked',
    historicalMissions:76,maxMissions:96,tokenAllowance:600000,nodeCount:13,maxHours:24,
    authorizedAt:authId?'2026-11-16T21:31:00Z':null,
  });
  const rpc=async(name,args)=>{
    calls.push({name,args:JSON.parse(JSON.stringify(args))});
    if(name==='project_org_management_activation_offer')throw Error('consumed historical receipt cannot recover');
    if(name==='project_org_blocked_owner_offer')return offer();
    if(name==='project_org_authorize_blocked_owner_window'){
      assert.equal(stage,'authorize','authorization may happen only once');
      assert.equal(args.p_owner,owner);assert.equal(args.p_project,project);
      assert.equal(args.p_release,activeRelease);assert.equal(args.p_authorization,authorizationId);
      assert.equal(args.p_state_hash,hash);assert.equal(args.p_prior_window,oldWindow);
      assert.equal(Date.parse(args.p_cutoff),Date.parse(cutoff));
      authId=authorizationId;receiptCutoff=cutoff;stage='resume';hash='b'.repeat(64);
      return {projectId:project,stage:'resume',authorizationId,releaseSha:activeRelease,
        cutoff,status:'blocked',historicalMissions:76,existing:false};
    }
    if(name==='project_org_resume_blocked_owner_confirmed'){
      assert.equal(stage,'resume','management may resume only once');
      assert.equal(args.p_owner,owner);assert.equal(args.p_project,project);
      assert.equal(args.p_release,activeRelease);assert.equal(args.p_authorization,authId);
      assert.equal(args.p_state_hash,hash);assert.equal(Date.parse(args.p_cutoff),Date.parse(cutoff));
      stage='resumed';hash='c'.repeat(64);
      return {projectId:project,stage:'resumed',authorizationId,releaseSha:activeRelease,
        cutoff,status:'running',existing:false};
    }
    assert.fail('Unexpected inference, worker, authorization or fallback writer: '+name);
  };
  const {GET,POST}=modules({
    '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>verified},
    '@/lib/missions/store':{rpc},
    '@/lib/data/persistence-store':{getMessages:async()=>assert.fail('No messages published')},
  })('@/app/api/projects/organization/route');
  const get=()=>GET(new Request('https://synthetic.invalid/api/projects/organization?projectId='+project));
  const post=body=>POST(new Request('https://synthetic.invalid/api/projects/organization',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
  }));
  const writers=()=>calls.filter(c=>c.name.startsWith('project_org_authorize_')||c.name.startsWith('project_org_resume_'));
  assert.equal((await get()).status,200);
  assert.equal(stage,'authorize');assert.equal(writers().length,0,'a status read cannot create a window');

  const authorize={projectId:project,trialAction:'authorize_blocked_window',
    releaseSha:activeRelease,priorWindowId:oldWindow,priorCutoff:originalCutoff,
    authorizationId,cutoff,stateHash:hash};
  verified=false;assert.equal((await get()).status,403);assert.equal((await post(authorize)).status,403);
  verified=true;
  assert.equal((await post({...authorize,projectId:owner})).status,400);
  assert.equal((await post({...authorize,releaseSha:'f'.repeat(40)})).status,409);
  assert.equal((await post({...authorize,stateHash:'f'.repeat(64)})).status,409);
  assert.equal((await post({...authorize,cutoff:'2026-11-16T21:32:00Z'})).status,409);
  assert.equal((await post({...authorize,cutoff:'2026-11-18T21:30:00Z'})).status,409);
  assert.equal(writers().length,0,'all invalid initial authorizations fail before any writer');

  const first=await post(authorize);assert.equal(first.status,200,await first.text());
  assert.equal(stage,'resume');assert.equal(writers().length,1,'first owner click must not resume or dispatch');
  assert.equal(writers()[0].name,'project_org_authorize_blocked_owner_window');
  assert.equal((await get()).status,200);
  assert.equal(stage,'resume');
  assert.equal(writers().length,1,'refresh must not resume');
  assert.equal((await post(authorize)).status,409,'authorization replay does not write again');

  const resume={projectId:project,trialAction:'resume_blocked_management',
    releaseSha:activeRelease,authorizationId,cutoff,stateHash:hash};
  assert.equal((await post({...resume,stateHash:'f'.repeat(64)})).status,409);
  assert.equal((await post({...resume,cutoff:'2026-11-16T23:30:00Z'})).status,409);
  assert.equal((await post({...resume,releaseSha:'f'.repeat(40)})).status,409);
  assert.equal(writers().length,1,'invalid resume cannot add a transition');

  const second=await post(resume);assert.equal(second.status,200,await second.text());
  assert.equal(stage,'resumed');assert.equal(writers().length,2);
  assert.equal(writers()[1].name,'project_org_resume_blocked_owner_confirmed');
  assert.equal((await get()).status,200);assert.equal(writers().length,2);
  assert.equal((await post(resume)).status,409,'replay is evidence only, no second resume writer');
  assert.equal(writers().length,2);
  assert.ok(calls.every(c=>!/(?:claim|provider|dispatch|schedule|infer|spend)/.test(c.name)),
    'no paid provider, mission claim, scheduling or worker dispatch through owner clicks');
  console.log('QA_BLOCKED_OWNER_TWO_STAGE_API_PASS: read-only offer; invalid owner/state/release/cutoff rejected; one window then separate resume; no implicit claims');
});

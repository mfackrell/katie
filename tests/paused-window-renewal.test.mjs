import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

test('paused renewal: authenticated original owner, exact project/cutoff and active production release only',async t=>{
 const savedNow=Date.now;Date.now=()=>Date.parse('2026-11-16T13:00:00Z');t.after(()=>{Date.now=savedNow;});
 const saved={...process.env};t.after(()=>{for(const k of ['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','KATIE_OWNER_AUTH_USER_ID']){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}});
 const release='d'.repeat(40),owner='11111111-1111-4111-8111-111111111111';
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:release,KATIE_OWNER_AUTH_USER_ID:owner});
 let authenticated=true,calls=[],fail=false;
 const readOffer={projectId:'fe9d2658-41e3-44c1-ae8e-a0cba98371fe',stage:'renew',releaseSha:release,scopeHash:'4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6',sourceMissionId:'62cd8da3-1bcc-41ae-9470-574c6b05e420',maxMissions:96,tokenAllowance:600000,nodeCount:13,historicalMissions:73,stateHash:'a'.repeat(64),cutoff:'2026-11-16T18:00:00Z'};
 const {POST}=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>authenticated},
  '@/lib/missions/store':{rpc:async(name,args)=>{if(name==='project_org_management_activation_offer')return readOffer;calls.push({name,args});if(fail)throw Error('stale evidence');return {status:'paused'};}},
  '@/lib/data/persistence-store':{getMessages:async()=>{throw Error('must not publish');}},
 })('@/app/api/projects/organization/route');
 const request={projectId:'fe9d2658-41e3-44c1-ae8e-a0cba98371fe',trialAction:'renew_paused_window',releaseSha:release,
  expectedReleaseSha:'c1d9a5f1ac10396c3015a7d5ae5f22254502e5de',scopeHash:'4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6',
  sourceMissionId:'62cd8da3-1bcc-41ae-9470-574c6b05e420',priorWindowId:'a837004e-75d3-497d-b05a-482886ed5a5f',
  priorCutoff:'2026-11-15T18:00:00Z',cutoff:'2026-11-16T18:00:00Z',authorizationId:'22222222-2222-4222-8222-222222222222',stateHash:'a'.repeat(64)};
 const post=body=>POST(new Request('https://synthetic.test/api/projects/organization',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
 authenticated=false;assert.equal((await post(request)).status,403);authenticated=true;
 for(const patch of [{projectId:owner},{cutoff:'2026-11-17T18:00:00Z'},{cutoff:'2026-11-16T17:00:00Z'},{priorCutoff:'2026-11-14T18:00:00Z'},
  {sourceMissionId:owner},{priorWindowId:owner},{scopeHash:'f'.repeat(64)},{expectedReleaseSha:release},{maxMissions:97},{tokenAllowance:600001},{p_owner:owner}]){
  assert.equal((await post({...request,...patch})).status,400,JSON.stringify(patch));
 }
 for(const env of ['preview','development','']){process.env.VERCEL_ENV=env;assert.equal((await post(request)).status,409);}
 process.env.VERCEL_ENV='production';assert.equal((await post({...request,releaseSha:'e'.repeat(40)})).status,409);
 assert.equal(calls.length,0,'all invalid requests stop before SQL');
 const response=await post(request);assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'paused'});
 assert.equal(calls.length,1);assert.equal(calls[0].name,'project_org_renew_paused_window');
 assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)),{p_owner:owner,p_project:request.projectId,p_release:release,p_expected_release:request.expectedReleaseSha,
  p_scope_hash:request.scopeHash,p_source_mission:request.sourceMissionId,p_prior_window:request.priorWindowId,p_prior_cutoff:request.priorCutoff,
  p_cutoff:request.cutoff,p_authorization:request.authorizationId,p_state_hash:request.stateHash});
 fail=true;assert.equal((await post(request)).status,409);
});

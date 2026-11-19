import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from 'playwright-core';
import bundledChromium from '@sparticuz/chromium';
import {modules} from './helpers/load-project-modules.mjs';

const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const sourceId='911d15bd-be5f-416e-bbac-fbe86ca6fa90';
const missionId='b7c2e557-83e1-41cb-b174-bdb0d77d12e5';
const assignmentId='85e229aa-e571-43ef-9d4a-5cb64f4efcd1';
const priorWindow='7d216bbe-596e-457e-b84d-e07ad1e80365';
const scopeHash='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
const priorCutoff='2026-11-18T14:00:00Z';
const releaseSha='a'.repeat(40),stateHash='b'.repeat(64),ownerId='04ed6c05-a586-4a56-ba81-1b50e378746b';
const deploymentId='dpl_NativeFixture79',releaseGeneration=1;
const approvalId='a083ef03-80b0-44ac-9e24-6e66b223f017',futureCutoff='2026-11-18T20:00:00.000Z';

test('expired original mission79 requires separately authenticated, owner-selected cutoff and durable receipt',async t=>{
 const env={VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA,VERCEL_DEPLOYMENT_ID:process.env.VERCEL_DEPLOYMENT_ID,
  KATIE_OWNER_AUTH_USER_ID:process.env.KATIE_OWNER_AUTH_USER_ID},before=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:releaseSha,VERCEL_DEPLOYMENT_ID:deploymentId,KATIE_OWNER_AUTH_USER_ID:ownerId});
 Date.now=()=>Date.parse('2026-11-18T16:00:00Z');
 t.after(()=>{Date.now=before;for(const [key,value] of Object.entries(env)){
  if(value==null)delete process.env[key];else process.env[key]=value;
 }});
 let owner=false,stage='authorize',aliasLive=true;const writes=[];
 const base={projectId,releaseSha,releaseGeneration,deploymentId,status:'blocked',missionStatus:'blocked',
  sourceMissionId:sourceId,missionId,assignmentId,priorWindowId:priorWindow,
  scopeHash,priorCutoff,cutoff:null,authorizationId:null,
  historicalMissions:79,maxMissions:96,tokenAllowance:600000,nodeCount:13,
  stateHash,stage};
 const saved={...base,stage:'authorized',authorizationId:approvalId,cutoff:futureCutoff,authorizedAt:'2026-11-18T16:00:00Z'};
 const mock=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},
  '@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>aliasLive},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_org_retest_future_window_offer')return stage==='authorize'?base:saved;
   if(name==='project_org_retest_release_epoch')return {generation:1,active:true,deploymentId};
   if(name==='project_org_authorize_retest_future_window'){
    writes.push(args);stage='authorized';
    return {...saved,existing:false};
   }
   throw Error('Unexpected first-party owner writer: '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]},
 });
 const {GET,POST}=mock('@/app/api/projects/organization/route');
 const read=()=>GET(new Request('https://synthetic.test/api/projects/organization?projectId='+projectId));
 const request=body=>new Request('https://synthetic.test/api/projects/organization',{
  method:'POST',headers:{'content-type':'application/json','origin':'https://synthetic.test'},body:JSON.stringify(body)
 });
 const correct={trialAction:'authorize_mission79_future_window',projectId,releaseSha,releaseGeneration,deploymentId,
  missionId,assignmentId,authorizationId:approvalId,cutoff:futureCutoff,stateHash};
 assert.equal((await read()).status,403);
 assert.equal((await POST(request(correct))).status,403);
 assert.equal(writes.length,0);
 owner=true;
 assert.equal((await (await read()).json()).mission79FutureWindow.stage,'authorize');
 assert.equal((await POST(request({...correct,ownerId:'forged'}))).status,400);
 assert.equal((await POST(request({...correct,missionId:sourceId}))).status,400);
 assert.equal((await POST(request({...correct,assignmentId:missionId}))).status,400);
 assert.equal((await POST(request({...correct,releaseSha:'c'.repeat(40)}))).status,409);
 assert.equal((await POST(request({...correct,stateHash:'d'.repeat(64)}))).status,409);
 assert.equal((await POST(request({...correct,cutoff:'2026-11-18T14:00:00.000Z'}))).status,409);
 assert.equal((await POST(request({...correct,cutoff:'2026-11-20T20:00:00.000Z'}))).status,409);
 process.env.VERCEL_ENV='preview';
 assert.equal((await POST(request(correct))).status,409,'Production-release check rejects preview even if test auth stub is true');
 process.env.VERCEL_ENV='production';
 aliasLive=false;assert.equal((await POST(request(correct))).status,409,'Superseded production alias fails closed');
 assert.equal(writes.length,0);aliasLive=true;
 assert.equal((await POST(request(correct))).status,200);
 assert.equal(writes.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(writes[0])),{
  p_owner:ownerId,p_project:projectId,p_release:releaseSha,
  p_mission:missionId,p_assignment:assignmentId,
  p_authorization:approvalId,p_cutoff:futureCutoff,p_state_hash:stateHash,
  p_epoch:1,p_deployment:deploymentId,
 });
 assert.equal((await (await read()).json()).mission79FutureWindow.stage,'authorized');
 assert.equal((await POST(request(correct))).status,409,'Recorded approval cannot authorize twice');
 assert.equal(writes.length,1);
});
test('first-party owner panel has no default deadline and never binds release or dispatches workers',()=>{
 const component=readFileSync('components/mission79-future-window-control.tsx','utf8');
 assert.ok(component.includes('useState("")'),"No implicit deadline value may be preselected");
 assert.match(component,/type="datetime-local"/);
 assert.match(component,/authorizationId=crypto.randomUUID\(\)/);
 assert.match(component,/authorize_mission79_future_window/);
 assert.doesNotMatch(component,/project_org_bind_retest_claim_release|claim_mission_work|project_org_decide/);
});

test('actual owner bearer, wrong identity and cross-origin boundary remain enforced',async t=>{
 const savedEnv={VERCEL_ENV:process.env.VERCEL_ENV,NEXT_PUBLIC_SUPABASE_URL:process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY:process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,KATIE_OWNER_AUTH_USER_ID:process.env.KATIE_OWNER_AUTH_USER_ID};
 const oldFetch=globalThis.fetch;
 process.env.VERCEL_ENV='production';
 process.env.NEXT_PUBLIC_SUPABASE_URL='https://auth.example.test';
 process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='test-public-anon';
 process.env.KATIE_OWNER_AUTH_USER_ID=ownerId;
 let identity=ownerId,requests=0;
 globalThis.fetch=async(url,opts)=>{
  requests++;
  assert.equal(url,'https://auth.example.test/auth/v1/user');
  assert.ok(opts?.headers?.Authorization?.startsWith('Bearer '));
  return new Response(JSON.stringify({id:identity}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 t.after(()=>{globalThis.fetch=oldFetch;for(const [key,v] of Object.entries(savedEnv)){
  if(v===undefined)delete process.env[key];else process.env[key]=v;
 }});
 const {verifiedProjectOwnerSession}=modules()('@/lib/projects/owner-authorization');
 const make=(origin,bearer)=>new Request('https://katie.example.test/api/projects/organization',{
  method:'POST',headers:{origin,Authorization:bearer??''}
 });
 assert.equal(await verifiedProjectOwnerSession(make('https://attacker.example.test','Bearer owner-token')),false);
 assert.equal(requests,0,'CSRF rejection must occur before external auth lookup');
 assert.equal(await verifiedProjectOwnerSession(make('https://katie.example.test','')),false);
 assert.equal(await verifiedProjectOwnerSession(make('https://katie.example.test','Bearer invalid!token')),false);
 assert.equal(requests,0,'Malformed tokens must not reach identity provider');
 identity='22222222-2222-4222-8222-222222222222';
 assert.equal(await verifiedProjectOwnerSession(make('https://katie.example.test','Bearer other-token')),false);
 assert.equal(requests,1);
 identity=ownerId;
 assert.equal(await verifiedProjectOwnerSession(make('https://katie.example.test','Bearer original-owner-token')),true);
 assert.equal(requests,2);
 process.env.VERCEL_ENV='preview';
 assert.equal(await verifiedProjectOwnerSession(make('https://katie.example.test','Bearer original-owner-token')),false);
 assert.equal(requests,2);
});

test('exact production release binding is a separate owner action after recorded future window',async t=>{
 const env={VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA,VERCEL_DEPLOYMENT_ID:process.env.VERCEL_DEPLOYMENT_ID,
  KATIE_OWNER_AUTH_USER_ID:process.env.KATIE_OWNER_AUTH_USER_ID},oldNow=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:releaseSha,VERCEL_DEPLOYMENT_ID:deploymentId,KATIE_OWNER_AUTH_USER_ID:ownerId});
 Date.now=()=>Date.parse('2026-11-18T16:00:00Z');
 t.after(()=>{Date.now=oldNow;for(const [k,v] of Object.entries(env)){
  if(v==null)delete process.env[k];else process.env[k]=v;
 }});
 let owner=true,aliasLive=true;const calls=[],bindHash='f'.repeat(64);
 const record={projectId,releaseSha,status:'blocked',missionStatus:'blocked',
  sourceMissionId:sourceId,missionId,assignmentId,priorWindowId:priorWindow,
  scopeHash,priorCutoff,cutoff:futureCutoff,authorizationId:approvalId,
  historicalMissions:79,maxMissions:96,tokenAllowance:600000,nodeCount:13,
  stateHash,stage:'authorized',authorizedAt:'2026-11-18T15:00:00Z'};
 const mod=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},
  '@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>aliasLive},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   calls.push({name,args});
   if(name==='project_org_retest_future_window_offer')return record;
   if(name==='project_org_retest_release_epoch')return {generation:1,active:true,deploymentId};
   if(name==='project_org_retest_claim_release_offer')
    return {stage:'bind',projectId,releaseSha,missionId,assignmentId,cutoff:futureCutoff,stateHash:bindHash};
   if(name==='project_org_bind_retest_claim_release')return {
    stage:'bound',projectId,releaseSha,missionId,assignmentId,scopeHash,cutoff:futureCutoff,
    historicalMissions:79,maxMissions:96,tokenAllowance:600000,boundAt:'2026-11-18T16:00:01Z',existing:false};
   throw Error('Unexpected RPC '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]},
 });
 const {POST}=mod('@/app/api/projects/organization/route');
 const request=data=>new Request('https://katie.example.test/api/projects/organization',
  {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 const payload={trialAction:'bind_mission79_release',projectId,releaseSha,releaseGeneration,deploymentId,missionId,assignmentId,stateHash:bindHash};
 owner=false;assert.equal((await POST(request(payload))).status,403);owner=true;
 assert.equal((await POST(request({...payload,releaseSha:'c'.repeat(40)}))).status,409);
 assert.equal((await POST(request({...payload,stateHash:'0'.repeat(64)}))).status,409);
 process.env.VERCEL_ENV='preview';
 assert.equal((await POST(request(payload))).status,409);
 process.env.VERCEL_ENV='production';
 aliasLive=false;assert.equal((await POST(request(payload))).status,409,'Superseded production alias cannot bind');
 aliasLive=true;
 const result=await POST(request(payload));assert.equal(result.status,200);
 const binds=calls.filter(x=>x.name==='project_org_bind_retest_claim_release');
 assert.equal(binds.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(binds[0].args)),
  {p_owner:ownerId,p_project:projectId,p_release:releaseSha,
   p_mission:missionId,p_assignment:assignmentId,p_state_hash:bindHash,
   p_epoch:1,p_deployment:deploymentId});
});

test('canonical alias verification rejects superseded deployment, redirect and spoofed version',async t=>{
 const env={VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA,VERCEL_DEPLOYMENT_ID:process.env.VERCEL_DEPLOYMENT_ID};
 process.env.VERCEL_ENV='production';process.env.VERCEL_GIT_COMMIT_SHA=releaseSha;
 process.env.VERCEL_DEPLOYMENT_ID=deploymentId;
 t.after(()=>{for(const [k,v] of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 const {verifyMission79ActiveProductionSha}=modules()('@/lib/projects/mission79-active-release');
 let checked=0;
 const fake=async(url,options)=>{
  checked++;
  assert.equal(new URL(url).origin,'https://katie-mu.vercel.app');
  assert.equal(new URL(url).pathname,'/api/version');
  assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');
  return new Response(JSON.stringify({version:releaseSha,deploymentId}),{status:200});
 };
 assert.equal(await verifyMission79ActiveProductionSha(releaseSha,fake),true);
 assert.equal(checked,1);
 assert.equal(await verifyMission79ActiveProductionSha(releaseSha,async()=>new Response(JSON.stringify({
  version:releaseSha,deploymentId:'dpl_OtherDeployment',
 }),{status:200})),false,'Same SHA with wrong deployment is stale');
 assert.equal(await verifyMission79ActiveProductionSha('b'.repeat(40),fake),false);
 assert.equal(checked,1,'Stale self-reported runtime SHA cannot even query the alias');
 assert.equal(await verifyMission79ActiveProductionSha(releaseSha,async()=>new Response(JSON.stringify({version:'c'.repeat(40)}),{status:200})),false);
 assert.equal(await verifyMission79ActiveProductionSha(releaseSha,async()=>new Response('<html>login</html>',{status:401})),false);
 assert.equal(await verifyMission79ActiveProductionSha(releaseSha,async()=>{throw Error('unavailable');}),false);
});

test('real first-party owner auth and independently resolved production alias gate the actual window writer',async t=>{
 const env={VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA,VERCEL_DEPLOYMENT_ID:process.env.VERCEL_DEPLOYMENT_ID,
  KATIE_OWNER_AUTH_USER_ID:process.env.KATIE_OWNER_AUTH_USER_ID,
  NEXT_PUBLIC_SUPABASE_URL:process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY:process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY};
 const oldFetch=globalThis.fetch,oldNow=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:releaseSha,VERCEL_DEPLOYMENT_ID:deploymentId,
  KATIE_OWNER_AUTH_USER_ID:ownerId,NEXT_PUBLIC_SUPABASE_URL:'https://auth.example.test',
  NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-public-anon'});
 Date.now=()=>Date.parse('2026-11-18T16:00:00Z');
 t.after(()=>{globalThis.fetch=oldFetch;Date.now=oldNow;for(const [k,v] of Object.entries(env)){
  if(v===undefined)delete process.env[k];else process.env[k]=v;
 }});
 let identity=ownerId,currentAlias=releaseSha,authCalls=0,aliasCalls=0,writeCalls=0;
 globalThis.fetch=async(url,opts)=>{
  const host=String(url);
  if(host==='https://auth.example.test/auth/v1/user'){
   authCalls++;assert.match(opts.headers.Authorization,/^Bearer /);
   return new Response(JSON.stringify({id:identity}),{status:200});
  }
  if(host.startsWith('https://katie-mu.vercel.app/api/version?mission79_verify=')){
   aliasCalls++;assert.equal(opts.cache,'no-store');
   return new Response(JSON.stringify({version:currentAlias,deploymentId}),{status:200});
  }
  throw Error('Unexpected external request '+host);
 };
 const offer={projectId,stage:'authorize',releaseGeneration,deploymentId,status:'blocked',missionStatus:'blocked',
  sourceMissionId:sourceId,missionId,assignmentId,priorWindowId:priorWindow,
  authorizationId:null,releaseSha,scopeHash,priorCutoff,cutoff:null,
  historicalMissions:79,maxMissions:96,tokenAllowance:600000,nodeCount:13,stateHash};
 const load=modules({
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_org_retest_future_window_offer')return offer;
   if(name==='project_org_retest_release_epoch')return {generation:1,active:true,deploymentId};
   if(name==='project_org_authorize_retest_future_window'){
    writeCalls++;return {...offer,stage:'authorized',authorizationId:approvalId,
     cutoff:futureCutoff,authorizedAt:'2026-11-18T16:00:00Z',existing:false};
   }
   throw Error('Unexpected SQL call '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]},
 });
 const {POST}=load('@/app/api/projects/organization/route');
 const payload={trialAction:'authorize_mission79_future_window',projectId,releaseSha,releaseGeneration,deploymentId,
  missionId,assignmentId,authorizationId:approvalId,cutoff:futureCutoff,stateHash};
 const req=()=>new Request('https://katie.example.test/api/projects/organization',{
  method:'POST',headers:{Origin:'https://katie.example.test','Content-Type':'application/json',
   Authorization:'Bearer exact-test-owner'},body:JSON.stringify(payload)});
 identity='22222222-2222-4222-8222-222222222222';
 assert.equal((await POST(req())).status,403);assert.equal(writeCalls,0);assert.equal(aliasCalls,0);
 identity=ownerId;currentAlias='f'.repeat(40);
 assert.equal((await POST(req())).status,409);assert.equal(writeCalls,0);
 currentAlias=releaseSha;
 assert.equal((await POST(req())).status,200);assert.equal(writeCalls,1);
 assert.equal(aliasCalls,2);assert.equal(authCalls,3);
});

test('real bearer and canonical alias jointly gate mission79 release binding',async t=>{
 const env={VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA,VERCEL_DEPLOYMENT_ID:process.env.VERCEL_DEPLOYMENT_ID,
  KATIE_OWNER_AUTH_USER_ID:process.env.KATIE_OWNER_AUTH_USER_ID,
  NEXT_PUBLIC_SUPABASE_URL:process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY:process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY};
 const oldFetch=globalThis.fetch,oldNow=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:releaseSha,VERCEL_DEPLOYMENT_ID:deploymentId,
  KATIE_OWNER_AUTH_USER_ID:ownerId,NEXT_PUBLIC_SUPABASE_URL:'https://auth.example.test',
  NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-public-anon'});
 Date.now=()=>Date.parse('2026-11-18T16:00:00Z');
 t.after(()=>{globalThis.fetch=oldFetch;Date.now=oldNow;for(const [k,v] of Object.entries(env)){
  if(v===undefined)delete process.env[k];else process.env[k]=v;
 }});
 let identity=ownerId,currentAlias=releaseSha,aliasChecks=0,bindCalls=0;
 const bindHash='f'.repeat(64);
 globalThis.fetch=async(url,opts)=>{
  const dest=String(url);
  if(dest==='https://auth.example.test/auth/v1/user'){
   assert.match(opts.headers.Authorization,/^Bearer /);
   return new Response(JSON.stringify({id:identity}),{status:200});
  }
  if(dest.startsWith('https://katie-mu.vercel.app/api/version?mission79_verify=')){
   aliasChecks++;assert.equal(opts.cache,'no-store');
   return new Response(JSON.stringify({version:currentAlias,deploymentId}),{status:200});
  }
  throw Error('Unexpected auth/release identity fetch '+dest);
 };
 const saved={projectId,stage:'authorized',releaseGeneration,deploymentId,status:'blocked',missionStatus:'blocked',
  sourceMissionId:sourceId,missionId,assignmentId,priorWindowId:priorWindow,
  authorizationId:approvalId,releaseSha,scopeHash,priorCutoff,cutoff:futureCutoff,
  historicalMissions:79,maxMissions:96,tokenAllowance:600000,nodeCount:13,
  stateHash,authorizedAt:'2026-11-18T15:00:00Z'};
 const module=modules({
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_org_retest_future_window_offer')return saved;
   if(name==='project_org_retest_release_epoch')return {generation:1,active:true,deploymentId};
   if(name==='project_org_retest_claim_release_offer')
    return {stage:'bind',projectId,releaseSha,missionId,assignmentId,cutoff:futureCutoff,stateHash:bindHash};
   if(name==='project_org_bind_retest_claim_release'){
    bindCalls++;
    assert.deepEqual(JSON.parse(JSON.stringify(args)),{
     p_owner:ownerId,p_project:projectId,p_release:releaseSha,
     p_mission:missionId,p_assignment:assignmentId,p_state_hash:bindHash,
     p_epoch:1,p_deployment:deploymentId});
    return {stage:'bound',projectId,releaseSha,missionId,assignmentId,
     scopeHash,cutoff:futureCutoff,historicalMissions:79,maxMissions:96,
     tokenAllowance:600000,boundAt:'2026-11-18T16:00:01Z',existing:false};
   }
   throw Error('Unexpected binder RPC '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]},
 });
 const {POST}=module('@/app/api/projects/organization/route');
 const input={trialAction:'bind_mission79_release',projectId,releaseSha,releaseGeneration,deploymentId,missionId,assignmentId,stateHash:bindHash};
 const req=(origin='https://katie.example.test')=>new Request('https://katie.example.test/api/projects/organization',{
  method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer original-owner-test'},
  body:JSON.stringify(input)});
 assert.equal((await POST(req('https://attacker.example.test'))).status,403);
 assert.equal(aliasChecks,0);assert.equal(bindCalls,0);
 identity='22222222-2222-4222-8222-222222222222';
 assert.equal((await POST(req())).status,403);
 assert.equal(aliasChecks,0);assert.equal(bindCalls,0);
 identity=ownerId;currentAlias='c'.repeat(40);
 assert.equal((await POST(req())).status,409);
 assert.equal(bindCalls,0);
 currentAlias=releaseSha;
 assert.equal((await POST(req())).status,200);
 assert.equal(bindCalls,1);
 assert.equal(aliasChecks,2);
});


test('superseded canonical alias cannot enter normal mission79 worker claim',async t=>{
 const deploymentId='dpl_NativeFixture79';
 const original={VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA,VERCEL_DEPLOYMENT_ID:process.env.VERCEL_DEPLOYMENT_ID};
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:releaseSha,VERCEL_DEPLOYMENT_ID:deploymentId});
 t.after(()=>{for(const [key,value] of Object.entries(original)){
  if(value===undefined)delete process.env[key];else process.env[key]=value;
 }});
 const calls=[];let aliasLive=false,epochLive=true,epochUnavailable=false,verifications=0,epochGeneration=1,gateDeployment=deploymentId;
 const load=modules({
  '@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async sha=>{
   verifications++;assert.equal(sha,releaseSha);return aliasLive;
  }},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   calls.push(name);
   if(name==='project_org_retest_release_epoch'){
    assert.equal(args.p_project,projectId);assert.equal(args.p_release,releaseSha);
     if(epochUnavailable)throw Error('database epoch lookup unavailable');
     return {generation:epochGeneration,active:epochLive,deploymentId:gateDeployment};
   }
   if(name==='claim_mission_work_release_epoch'){
    assert.equal(args.p_release,releaseSha);
    assert.equal(args.p_deployment,deploymentId);
    assert.equal(args.p_epoch,epochUnavailable||(epochLive&&(!aliasLive||gateDeployment!==deploymentId))?0:epochGeneration,
     'Epoch-zero claim must deny only mission79 when its release proof fails');
    return null;
   }
   return null;
  }},
 });
 const {runMissionBatch}=load('@/lib/missions/worker');
 const forbidden=async()=>{throw Error('Stale alias must not execute an LLM');};
 const savedSha=process.env.VERCEL_GIT_COMMIT_SHA;
 delete process.env.VERCEL_GIT_COMMIT_SHA;
 const missing=await runMissionBatch(forbidden);
 assert.equal(missing.claimed,0);
 assert.equal(missing.releaseFence,'missing_production_release');
 assert.equal(calls.filter(x=>x==='claim_mission_work').length,0,
  'Missing production SHA must never fall back to unrestricted worker claiming');
 process.env.VERCEL_GIT_COMMIT_SHA=savedSha;
 const stopped=await runMissionBatch(forbidden);
 assert.equal(stopped.claimed,0);assert.equal(stopped.releaseFence,'canonical_alias_changed');
 assert.equal(calls.filter(x=>x==='claim_mission_work_release_epoch').length,1,
  'A stale alias must invoke only an epoch-zero SQL claim, retaining ordinary work');
 aliasLive=true;
 const normal=await runMissionBatch(forbidden);
 assert.equal(normal.claimed,0);
 assert.equal(calls.filter(x=>x==='claim_mission_work_release_epoch').length,2,
  'A canonical READY deployment may reach only the normal epoch-bound SQL claim RPC');
 assert.equal(verifications,2);
 // A different deployment registered under the same SHA cannot claim.
 gateDeployment='dpl_AnotherDeploymentSameSha';
 const mismatchedDeployment=await runMissionBatch(forbidden);
 assert.equal(mismatchedDeployment.claimed,0);
 assert.equal(mismatchedDeployment.releaseFence,'canonical_alias_changed');
 assert.equal(verifications,2,'Different gate deployment rejects before HTTP alias verification');
 gateDeployment=deploymentId;
 epochLive=false;aliasLive=false;
 await runMissionBatch(forbidden);
 assert.equal(verifications,2,'No mission79 alias proof is needed after the SQL gate was closed');
 // A failed epoch lookup denies only mission79; ordinary work uses epoch-zero SQL.
 const previousClaims=calls.filter(x=>x==='claim_mission_work_release_epoch').length;
 epochUnavailable=true;
 const denied=await runMissionBatch(forbidden);
 assert.equal(denied.claimed,0);
 assert.equal(denied.releaseFence,'release_epoch_unavailable');
 assert.equal(calls.filter(x=>x==='claim_mission_work_release_epoch').length,previousClaims+1,
  'An unavailable epoch must still route ordinary claims through epoch-zero SQL');
 // An authentic negative epoch still allows unrelated ordinary claim routing.
 epochUnavailable=false;epochLive=false;
 const ordinary=await runMissionBatch(forbidden);
 assert.equal(ordinary.claimed,0);
 assert.equal(calls.filter(x=>x==='claim_mission_work_release_epoch').length,previousClaims+2);
});


test('real Chromium original mission79 owner cutoff and separate exact-release binding',{timeout:100000},async()=>{
 const source=ts.transpileModule(readFileSync('components/mission79-future-window-control.tsx','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}
 }).outputText;
 const react=['react/umd/react.production.min.js','react-dom/umd/react-dom.production.min.js']
  .map(f=>readFileSync('node_modules/'+f,'utf8')).join('\n');
 const browser=await chromium.launch({
  executablePath:process.env.KATIE_TEST_CHROMIUM||await bundledChromium.executablePath(),
  args:bundledChromium.args,headless:true,
 });
 const context=await browser.newContext({timezoneId:'UTC'});
 const page=await context.newPage();
 const base={projectId,releaseSha,releaseGeneration,deploymentId,status:'blocked',missionStatus:'blocked',
  sourceMissionId:sourceId,missionId,assignmentId,priorWindowId:priorWindow,
  scopeHash,priorCutoff,cutoff:null,authorizationId:null,
  historicalMissions:79,maxMissions:96,tokenAllowance:600000,nodeCount:13,
  stateHash,stage:'authorize'};
 const approved={...base,stage:'authorized',authorizationId:approvalId,cutoff:futureCutoff,
  authorizedAt:'2026-11-18T16:00:00Z'};
 try{
  for(const scenario of ['owner-window','no-owner','bind-release']){
   await page.unroute('http://localhost/**');
   const responseGate={};
   let releaseResponse;
   responseGate.promise=new Promise(resolve=>{releaseResponse=resolve;});
   const posts=[],errors=[];
   let observedRequest;
   const requestSeen=new Promise(resolve=>{observedRequest=resolve;});
   page.removeAllListeners('pageerror');page.on('pageerror',e=>errors.push(e.message));
   const input=scenario==='bind-release'?approved:base;
   const bearer=scenario==='no-owner'?'null':'"actual-ui-test-owner"';
   const script='const exports={};const require=n=>n==="react"?React:'+
    'n==="react/jsx-runtime"?{Fragment:React.Fragment,jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})}:'+
    '{ownerSessionBearer:async()=>'+bearer+'};'+
    'Date.now=()=>'+Date.parse('2026-11-18T16:00:00Z')+';window.refreshCount=0;'+source+
    ';ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(exports.Mission79FutureWindowControl,{initial:'+
    JSON.stringify(input)+',onRefresh:()=>window.refreshCount++}));';
   await page.route('http://localhost/**',async route=>{
    if(new URL(route.request().url()).pathname==='/owner')
     return route.fulfill({contentType:'text/html; charset=utf-8',
      body:'<html><div id="root"></div><script>'+react+'</script><script>'+script+'</script></html>'});
    const item={method:route.request().method(),headers:route.request().headers(),body:route.request().postDataJSON()};
    posts.push(item);
    observedRequest(item);
    await responseGate.promise;
    const newReceipt=scenario==='bind-release'
     ?{stage:'bound',projectId,releaseSha,missionId,assignmentId,scopeHash,
       cutoff:futureCutoff,historicalMissions:79,maxMissions:96,tokenAllowance:600000,
       boundAt:'2026-11-18T16:01:00Z'}
     :{...approved,authorizationId:item.body.authorizationId,cutoff:item.body.cutoff,
       stage:'authorized',existing:false};
    return route.fulfill({status:200,json:newReceipt});
   });
   await page.goto('http://localhost/owner',{waitUntil:'domcontentloaded',timeout:12000});
   if(scenario==='bind-release'){
    const button=page.getByRole('button',{name:'Resume one owner-approved management decision'});
    await button.waitFor({timeout:12000});
    await button.evaluate(el=>{el.click();el.click();});
    await Promise.race([requestSeen,new Promise((_,reject)=>setTimeout(()=>reject(Error('Binding POST not sent')),12000))]);
    await page.waitForFunction(()=>window.refreshCount===0&&document.body.textContent.includes('Verifying exact released authority'),{timeout:12000});
    assert.equal(posts.length,1,'Double click must not bind release twice');
    assert.equal(posts[0].method,'POST');assert.equal(posts[0].headers.authorization,'Bearer actual-ui-test-owner');
    assert.deepEqual(posts[0].body,{trialAction:'bind_mission79_release',projectId,releaseSha,releaseGeneration,deploymentId,
     missionId,assignmentId,stateHash});
    releaseResponse();
    await page.getByText('Exact release binding is recorded.').waitFor({timeout:12000});
    assert.equal(await page.evaluate(()=>window.refreshCount),1);
   }else{
    const cutoff=page.locator('#mission79-cutoff');
    await cutoff.waitFor({timeout:12000});
    assert.equal(await cutoff.inputValue(),'','No deadline may be preselected');
    await cutoff.fill('2026-11-18T20:00');
    const button=page.getByRole('button',{name:'Approve new execution window'});
    await button.evaluate((el,double)=>{el.click();if(double)el.click();},scenario==='owner-window');
    if(scenario==='no-owner'){
     await page.getByRole('alert').filter({hasText:'Sign in as the existing Katie owner'}).waitFor({timeout:12000});
     assert.equal(posts.length,0,'Unauthenticated UI must not POST');
     releaseResponse();
    }else{
     await page.waitForFunction(()=>document.body.textContent.includes('Recording owner authorization'),{timeout:12000});
     await Promise.race([requestSeen,new Promise((_,reject)=>setTimeout(()=>reject(Error('Owner authorization POST not sent')),12000))]);
     // The first-party control owns the browser-selected time and fresh UUID;
     // the actual response is tied back to both before it displays success.
     await page.waitForFunction(()=>Boolean(document.querySelector('button:disabled')),{timeout:12000});
     assert.equal(posts.length,1,'Double-click may submit only one owner authorization');
     const sent=posts[0];assert.equal(sent.method,'POST');
     assert.equal(sent.headers.authorization,'Bearer actual-ui-test-owner');
     assert.equal(sent.body.trialAction,'authorize_mission79_future_window');
     assert.equal(sent.body.projectId,projectId);assert.equal(sent.body.releaseSha,releaseSha);
     assert.equal(sent.body.releaseGeneration,releaseGeneration);assert.equal(sent.body.deploymentId,deploymentId);
     assert.equal(sent.body.missionId,missionId);assert.equal(sent.body.assignmentId,assignmentId);
     assert.equal(sent.body.stateHash,stateHash);
     assert.equal(sent.body.cutoff,futureCutoff);
     assert.match(sent.body.authorizationId,/^[a-f0-9-]{36}$/i);
     releaseResponse();
     await page.getByText('Owner window recorded.').waitFor({timeout:12000});
     assert.equal(await page.evaluate(()=>window.refreshCount),1);
     assert.equal(await button.count(),0,'Consumed UI action cannot be repeated');
    }
   }
   assert.deepEqual(errors,[],'Real browser must not throw: '+errors.join('; '));
   console.log('MISSION79_REAL_BROWSER_OWNER_'+scenario.toUpperCase().replaceAll('-','_')+'_PASS');
  }
 }finally{await page.close({runBeforeUnload:false});await context.close();await browser.close();}
});

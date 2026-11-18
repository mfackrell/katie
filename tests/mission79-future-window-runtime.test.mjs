import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {modules} from './helpers/load-project-modules.mjs';

const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const sourceId='911d15bd-be5f-416e-bbac-fbe86ca6fa90';
const missionId='b7c2e557-83e1-41cb-b174-bdb0d77d12e5';
const assignmentId='85e229aa-e571-43ef-9d4a-5cb64f4efcd1';
const priorWindow='7d216bbe-596e-457e-b84d-e07ad1e80365';
const scopeHash='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
const priorCutoff='2026-11-18T14:00:00Z';
const releaseSha='a'.repeat(40),stateHash='b'.repeat(64),ownerId='04ed6c05-a586-4a56-ba81-1b50e378746b';
const approvalId='a083ef03-80b0-44ac-9e24-6e66b223f017',futureCutoff='2026-11-18T20:00:00.000Z';

test('expired original mission79 requires separately authenticated, owner-selected cutoff and durable receipt',async t=>{
 const env={VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA,
  KATIE_OWNER_AUTH_USER_ID:process.env.KATIE_OWNER_AUTH_USER_ID},before=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:releaseSha,KATIE_OWNER_AUTH_USER_ID:ownerId});
 Date.now=()=>Date.parse('2026-11-18T16:00:00Z');
 t.after(()=>{Date.now=before;for(const [key,value] of Object.entries(env)){
  if(value==null)delete process.env[key];else process.env[key]=value;
 }});
 let owner=false,stage='authorize',aliasLive=true;const writes=[];
 const base={projectId,releaseSha,status:'blocked',missionStatus:'blocked',
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
 const correct={trialAction:'authorize_mission79_future_window',projectId,releaseSha,
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
 const env={VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA,
  KATIE_OWNER_AUTH_USER_ID:process.env.KATIE_OWNER_AUTH_USER_ID},oldNow=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:releaseSha,KATIE_OWNER_AUTH_USER_ID:ownerId});
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
 const payload={trialAction:'bind_mission79_release',projectId,releaseSha,missionId,assignmentId,stateHash:bindHash};
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
   p_mission:missionId,p_assignment:assignmentId,p_state_hash:bindHash});
});

test('canonical alias verification rejects superseded deployment, redirect and spoofed version',async t=>{
 const env={VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA};
 process.env.VERCEL_ENV='production';process.env.VERCEL_GIT_COMMIT_SHA=releaseSha;
 t.after(()=>{for(const [k,v] of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 const {verifyMission79ActiveProductionSha}=modules()('@/lib/projects/mission79-active-release');
 let checked=0;
 const fake=async(url,options)=>{
  checked++;
  assert.equal(new URL(url).origin,'https://katie-mu.vercel.app');
  assert.equal(new URL(url).pathname,'/api/version');
  assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');
  return new Response(JSON.stringify({version:releaseSha}),{status:200});
 };
 assert.equal(await verifyMission79ActiveProductionSha(releaseSha,fake),true);
 assert.equal(checked,1);
 assert.equal(await verifyMission79ActiveProductionSha('b'.repeat(40),fake),false);
 assert.equal(checked,1,'Stale self-reported runtime SHA cannot even query the alias');
 assert.equal(await verifyMission79ActiveProductionSha(releaseSha,async()=>new Response(JSON.stringify({version:'c'.repeat(40)}),{status:200})),false);
 assert.equal(await verifyMission79ActiveProductionSha(releaseSha,async()=>new Response('<html>login</html>',{status:401})),false);
 assert.equal(await verifyMission79ActiveProductionSha(releaseSha,async()=>{throw Error('unavailable');}),false);
});

test('real first-party owner auth and independently resolved production alias gate the actual window writer',async t=>{
 const env={VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA,
  KATIE_OWNER_AUTH_USER_ID:process.env.KATIE_OWNER_AUTH_USER_ID,
  NEXT_PUBLIC_SUPABASE_URL:process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY:process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY};
 const oldFetch=globalThis.fetch,oldNow=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:releaseSha,
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
   return new Response(JSON.stringify({version:currentAlias}),{status:200});
  }
  throw Error('Unexpected external request '+host);
 };
 const offer={projectId,stage:'authorize',status:'blocked',missionStatus:'blocked',
  sourceMissionId:sourceId,missionId,assignmentId,priorWindowId:priorWindow,
  authorizationId:null,releaseSha,scopeHash,priorCutoff,cutoff:null,
  historicalMissions:79,maxMissions:96,tokenAllowance:600000,nodeCount:13,stateHash};
 const load=modules({
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_org_retest_future_window_offer')return offer;
   if(name==='project_org_authorize_retest_future_window'){
    writeCalls++;return {...offer,stage:'authorized',authorizationId:approvalId,
     cutoff:futureCutoff,authorizedAt:'2026-11-18T16:00:00Z',existing:false};
   }
   throw Error('Unexpected SQL call '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]},
 });
 const {POST}=load('@/app/api/projects/organization/route');
 const payload={trialAction:'authorize_mission79_future_window',projectId,releaseSha,
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
 const env={VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA,
  KATIE_OWNER_AUTH_USER_ID:process.env.KATIE_OWNER_AUTH_USER_ID,
  NEXT_PUBLIC_SUPABASE_URL:process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY:process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY};
 const oldFetch=globalThis.fetch,oldNow=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:releaseSha,
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
   return new Response(JSON.stringify({version:currentAlias}),{status:200});
  }
  throw Error('Unexpected auth/release identity fetch '+dest);
 };
 const saved={projectId,stage:'authorized',status:'blocked',missionStatus:'blocked',
  sourceMissionId:sourceId,missionId,assignmentId,priorWindowId:priorWindow,
  authorizationId:approvalId,releaseSha,scopeHash,priorCutoff,cutoff:futureCutoff,
  historicalMissions:79,maxMissions:96,tokenAllowance:600000,nodeCount:13,
  stateHash,authorizedAt:'2026-11-18T15:00:00Z'};
 const module=modules({
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_org_retest_future_window_offer')return saved;
   if(name==='project_org_retest_claim_release_offer')
    return {stage:'bind',projectId,releaseSha,missionId,assignmentId,cutoff:futureCutoff,stateHash:bindHash};
   if(name==='project_org_bind_retest_claim_release'){
    bindCalls++;
    assert.deepEqual(JSON.parse(JSON.stringify(args)),{
     p_owner:ownerId,p_project:projectId,p_release:releaseSha,
     p_mission:missionId,p_assignment:assignmentId,p_state_hash:bindHash});
    return {stage:'bound',projectId,releaseSha,missionId,assignmentId,
     scopeHash,cutoff:futureCutoff,historicalMissions:79,maxMissions:96,
     tokenAllowance:600000,boundAt:'2026-11-18T16:00:01Z',existing:false};
   }
   throw Error('Unexpected binder RPC '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]},
 });
 const {POST}=module('@/app/api/projects/organization/route');
 const input={trialAction:'bind_mission79_release',projectId,releaseSha,missionId,assignmentId,stateHash:bindHash};
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
 const original={VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA};
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:releaseSha});
 t.after(()=>{for(const [key,value] of Object.entries(original)){
  if(value===undefined)delete process.env[key];else process.env[key]=value;
 }});
 const calls=[];let aliasLive=false,epochLive=true,epochUnavailable=false,verifications=0;
 const load=modules({
  '@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async sha=>{
   verifications++;assert.equal(sha,releaseSha);return aliasLive;
  }},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   calls.push(name);
   if(name==='project_org_retest_active_release'){
    assert.equal(args.p_project,projectId);assert.equal(args.p_release,releaseSha);
     if(epochUnavailable)throw Error('database epoch lookup unavailable');
     return epochLive;
   }
   if(name==='claim_mission_work_release')return null;
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
 assert.equal(calls.filter(x=>x==='claim_mission_work_release').length,0,
  'A superseded production deployment must not even request the worker lease');
 aliasLive=true;
 const normal=await runMissionBatch(forbidden);
 assert.equal(normal.claimed,0);
 assert.equal(calls.filter(x=>x==='claim_mission_work_release').length,1,
  'A canonical READY deployment may reach only the normal SQL claim RPC');
 assert.equal(verifications,2);
 epochLive=false;aliasLive=false;
 await runMissionBatch(forbidden);
 assert.equal(verifications,2,'No mission79 alias proof is needed after the SQL gate was closed');
 // A failed epoch lookup is not evidence of a closed release. Deny claims.
 const previousClaims=calls.filter(x=>x==='claim_mission_work_release').length;
 epochUnavailable=true;
 const denied=await runMissionBatch(forbidden);
 assert.equal(denied.claimed,0);
 assert.equal(denied.releaseFence,'release_epoch_unavailable');
 assert.equal(calls.filter(x=>x==='claim_mission_work_release').length,previousClaims);
 // An authentic negative epoch still allows unrelated ordinary claim routing.
 epochUnavailable=false;epochLive=false;
 const ordinary=await runMissionBatch(forbidden);
 assert.equal(ordinary.claimed,0);
 assert.equal(calls.filter(x=>x==='claim_mission_work_release').length,previousClaims+1);
});

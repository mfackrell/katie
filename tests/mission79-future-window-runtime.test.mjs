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
 let owner=false,stage='authorize';const writes=[];
 const base={projectId,releaseSha,status:'blocked',missionStatus:'blocked',
  sourceMissionId:sourceId,missionId,assignmentId,priorWindowId:priorWindow,
  scopeHash,priorCutoff,cutoff:null,authorizationId:null,
  historicalMissions:79,maxMissions:96,tokenAllowance:600000,nodeCount:13,
  stateHash,stage};
 const saved={...base,stage:'authorized',authorizationId:approvalId,cutoff:futureCutoff,authorizedAt:'2026-11-18T16:00:00Z'};
 const mock=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},
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
 assert.equal((await POST(request(correct))).status,200);
 assert.equal(writes.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(writes[0])),{
  p_owner:ownerId,p_project:projectId,p_release:releaseSha,
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

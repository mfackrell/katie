import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';
const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe',scope='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
const release='d'.repeat(40),cutoff='2026-11-16T18:00:00Z';
function environment(t){
 const saved={...process.env},now=Date.now;t.after(()=>{Date.now=now;for(const key of ['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','KATIE_OWNER_AUTH_USER_ID']){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}});
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:release,KATIE_OWNER_AUTH_USER_ID:'11111111-1111-4111-8111-111111111111'});Date.now=()=>Date.parse('2026-11-16T13:00:00Z');
}
const initial={projectId,stage:'renew',releaseSha:release,expectedReleaseSha:'c1d9a5f1ac10396c3015a7d5ae5f22254502e5de',scopeHash:scope,sourceMissionId:'62cd8da3-1bcc-41ae-9470-574c6b05e420',windowId:'a837004e-75d3-497d-b05a-482886ed5a5f',priorCutoff:'2026-11-15T18:00:00Z',cutoff,stateHash:'a'.repeat(64),authorizationId:null,status:'paused',historicalMissions:73,maxMissions:96,tokenAllowance:600000,nodeCount:13};

test('original chat exposes the specific owner recovery control rather than legacy arbitrary continuation',async t=>{
 environment(t);let owner=true,chatOwned=true,reads=0,unavailable=false;
 const actor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',chat='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const {GET}=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},
  '@/lib/data/persistence-store':{getChatById:async()=>({actorId:chatOwned?actor:'another-actor'}),getMessages:async()=>[]},
  '@/lib/projects/store':{projectForChat:async()=>({id:projectId,status:'paused',phase:'development',organization_version:1,deadline:initial.priorCutoff}),projectRpc:async name=>{assert.equal(name,'project_provider_mode');return true;}},
  '@/lib/missions/store':{rpc:async(name,args)=>{assert.equal(name,'project_org_management_activation_offer');assert.equal(args.p_owner,process.env.KATIE_OWNER_AUTH_USER_ID);reads++;if(unavailable)throw Error('Unavailable recovery state');return initial;}},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>assert.fail('The old continuation lookup must not run')},
  '@/lib/executive/delivery':{hasPendingExecutiveDelivery:async()=>false},
 })('@/app/api/projects/route');
 const get=()=>{const req=new Request('https://synthetic.test/api/projects?actorId='+actor+'&chatId='+chat);req.nextUrl=new URL(req.url);return GET(req);};
 const result=await (await get()).json();assert.equal(result.directorRecovery.managementActivation.stage,'renew');assert.equal(result.directorRecovery.cutoff,cutoff);assert.equal(result.directorRecovery.continuation,undefined);assert.equal(reads,1);
 owner=false;assert.equal((await (await get()).json()).directorRecovery,null);assert.equal(reads,1);
 owner=true;chatOwned=false;assert.equal((await get()).status,404);assert.equal(reads,1);
 chatOwned=true;unavailable=true;const blocked=(await (await get()).json()).directorRecovery;
 assert.match(blocked.managementActivationError,/Refresh project status/);assert.equal(blocked.managementActivation,undefined);assert.equal(blocked.continuation,undefined);
});

test('preflight validates exact scope/source/release/resources and returns a fixed expired status',async t=>{
 environment(t);let offer=initial,reads=0;
 const {managementActivationOffer}=modules({'@/lib/missions/store':{rpc:async()=>{reads++;return offer;}}})('@/lib/projects/management-activation');
 for(const patch of [{projectId:crypto.randomUUID()},{releaseSha:'e'.repeat(40)},{scopeHash:'f'.repeat(64)},{sourceMissionId:crypto.randomUUID()},{maxMissions:97},{tokenAllowance:600001},{nodeCount:14},{historicalMissions:72},{stateHash:'bad'},{cutoff:'2026-11-17T18:00:00Z'},{stage:'unknown'}]){
  offer={...initial,...patch};await assert.rejects(managementActivationOffer(projectId),/receipt changed/);
 }
 offer={...initial,cutoff:'2026-11-16T18:00:00+00:00'};assert.equal((await managementActivationOffer(projectId)).cutoff,cutoff);
 Date.now=()=>Date.parse(cutoff);assert.equal((await managementActivationOffer(projectId)).stage,'expired');
 const previous=reads;await assert.rejects(managementActivationOffer(crypto.randomUUID()),/original project/);assert.equal(reads,previous);
});

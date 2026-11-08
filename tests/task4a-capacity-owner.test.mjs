import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {modules} from './helpers/load-project-modules.mjs';
import {readOrdinaryNativeAuthority} from '../scripts/benchmark/ordinary-native-authority.mjs';

test('capacity-only owner route verifies latest evidence, accepts no financial edits and never dispatches',async()=>{
 const owner='04ed6c05-a586-4a56-ba81-1b50e378746b',sha='e'.repeat(40),digest='f'.repeat(64);
 const env={KATIE_OWNER_AUTH_USER_ID:process.env.KATIE_OWNER_AUTH_USER_ID,VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA};
 Object.assign(process.env,{KATIE_OWNER_AUTH_USER_ID:owner,VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha});
 let signed=false,saved=null,mutations=0,ready=true,proofs=0,head=sha;
 const checkpoint={checkpointSha:'2667a81d4f18452e9ca59498c8805670b04cfe47',releaseSha:'3c148a4ea9a2f8bee9d35b7e430eee0f66ff58a0'};
 const result={authorized:true,dispatchAuthorized:false,paidInferenceAuthorized:false,newPaidCalls:0,deadline:'2026-11-08T00:00:00Z'};
 const db={from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:saved?{data:saved}:null,error:null})}),rpc:async(name,args)=>{
  assert.equal(args.p_release,sha);assert.deepEqual(args.p_checkpoint,checkpoint);
  if(name==='task4a_capacity_proposal')return {data:{ready,digest,proposal:{ownerId:owner}},error:null};
  assert.equal(name,'task4a_capacity_authorize');assert.equal(args.p_owner,owner);assert.equal(args.p_digest,digest);
  mutations++;saved={ownerId:owner,consentDigest:digest,proposal:{releaseSha:sha,checkpoint},result};return {data:result,error:null};
 }};
 const route=modules({'next/server':{NextResponse:{json:(b,o)=>Response.json(b,o)}},
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>signed},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},
  '@/lib/agents/development':{authenticatedTask4aCapacityCheckpoint:async()=>{proofs++;return {record:checkpoint,checkpoint};},qualifiedOrdinaryDevelopmentRelease:async()=>head}
 })('@/app/api/projects/task4a-capacity/route');
 const get=()=>route.GET(new Request('https://katie.local/api/projects/task4a-capacity?chatId=e53defeb-16eb-457e-aa07-435141165ee8'));
 const post=body=>route.POST(new Request('https://katie.local/api/projects/task4a-capacity',{method:'POST',body:JSON.stringify(body)}));
 const decision={action:'approveCapacityOnly',confirm:true,digest};
 try{
  assert.equal((await get()).status,401);assert.equal((await post(decision)).status,403);signed=true;
  assert.equal((await(await get()).json()).state,'pending_capacity_only');assert.equal(mutations,0);
  for(const payload of [{...decision,limits:{developmentCalls:21}},{...decision,dispatch:true},{...decision,deadline:'tomorrow'},{...decision,confirm:false}])assert.equal((await post(payload)).status,400);
  assert.equal((await post({...decision,digest:'0'.repeat(64)})).status,409);
  ready=false;assert.equal((await post(decision)).status,409);ready=true;
  head='a'.repeat(40);assert.equal((await post(decision)).status,409);head=sha;
  assert.equal(mutations,0);
  const first=await(await post(decision)).json();assert.equal(first.state,'capacity_authorized_execution_blocked');assert.deepEqual(first.result,result);
  const replay=await(await post(decision)).json();assert.deepEqual(replay,first);assert.equal(mutations,1);
  assert.equal((await post({...decision,digest:'0'.repeat(64)})).status,409);assert.ok(proofs>=4);
  assert.equal((await(await get()).json()).state,'capacity_authorized_execution_blocked');
 }finally{for(const [k,v] of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('capacity-only successor is rejected before native authority or scheduler side effects',async()=>{
 let calls=0;
 await assert.rejects(readOrdinaryNativeAuthority({approval:{developer_authority:{task4aCapacityRenewal:{executionAuthorized:false}}},db:{rpc:async()=>{calls++;return {data:false,error:null};}}}),/ORDINARY_NATIVE_AUTHORITY_DENIED/);
 assert.equal(calls,1);
 const src=readFileSync('lib/agents/development.ts','utf8');
 const start=src.indexOf(' for(const a of rows.data){',src.indexOf('async function dispatchOrdinaryNativeDevelopment'));
 const end=src.indexOf('  if(onlyTaskId',start);
 assert.ok(start>0&&end>start);
 const code=src.slice(start,end)+'seen++;}';
 const context={rows:{data:[{developer_authority:{task4aCapacityRenewal:{executionAuthorized:false}}},{developer_authority:{version:'ordinary-developer-v1'}},{developer_authority:{task4aCapacityRenewal:{},task4aFinalSuccessor:{}}}]},seen:0,capacityExecution:false,finalExecution:false,verifierExecution:false};
 vm.runInNewContext(code,context);assert.equal(context.seen,1);
 context.seen=0;context.capacityExecution=true;context.finalExecution=true;
 vm.runInNewContext(code,context);assert.equal(context.seen,1,'Explicit final mode selects only final successor; scheduler never does');
});

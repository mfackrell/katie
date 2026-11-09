import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';
test('replacement route requires fresh exact owner consent, reauthenticates WIP and never replays',async()=>{
 const owner='04ed6c05-a586-4a56-ba81-1b50e378746b',sha='e'.repeat(40),digest='f'.repeat(64);
 const prior={KATIE_OWNER_AUTH_USER_ID:process.env.KATIE_OWNER_AUTH_USER_ID,VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA};
 Object.assign(process.env,{KATIE_OWNER_AUTH_USER_ID:owner,VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha});
 let signed=false,authorized=false,claimed=false,dispatches=0,proofs=0,live=true;
 const db={from:()=>({select:()=>({eq:()=>({in:()=>({returns:async()=>({data:authorized?[{id:'new-owner-receipt',event:'task4a_replacement_authorized',data:{}},
  ...(claimed?[{id:'new-claim',event:'task4a_replacement_claimed',data:{}}]:[])]:[],error:null})})})})}),
 rpc:async(name,args)=>{
  assert.equal(args.p_release,sha);assert.deepEqual(args.p_evidence,{verified:true});
  if(name==='task4a_replacement_proposal')return {data:{ready:live,digest,proposal:{ownerId:owner,deadline:'existing-deadline'}},error:null};
  assert.equal(name,'task4a_replacement_authorize');assert.equal(args.p_owner,owner);assert.equal(args.p_digest,digest);
  assert.equal(authorized,false);authorized=true;
  return {data:{authorized:true,receiptId:'new-owner-receipt',dispatched:false,newPaidCalls:0,newFinancialAuthority:false},error:null};
 }};
 const {GET,POST}=modules({
  'next/server':{NextResponse:{json:(b,o)=>Response.json(b,o)}},
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>signed},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},
  '@/lib/agents/development':{authenticatedTask4aReplacementCheckpoint:async()=>{proofs++;return {evidence:{verified:true}};},
   qualifiedOrdinaryDevelopmentRelease:async()=>sha,
   dispatchTask4aReplacementOnce:async()=>{dispatches++;claimed=true;return true;}}
 })('@/app/api/projects/task4a-replacement/route');
 const url='https://katie.local/api/projects/task4a-replacement';
 const get=()=>GET(new Request(url+'?chatId=e53defeb-16eb-457e-aa07-435141165ee8'));
 const post=body=>POST(new Request(url,{method:'POST',body:JSON.stringify(body)}));
 const decision={action:'approveReplacement',confirm:true,digest};
 try{
  assert.equal((await get()).status,401);assert.equal((await post(decision)).status,403);
  signed=true;
  assert.equal((await(await get()).json()).state,'pending_replacement');assert.equal(dispatches,0);assert.equal(authorized,false);
  assert.equal((await post({...decision,limits:{ceilingMicrousd:10000000}})).status,400);
  assert.equal((await post({...decision,digest:'0'.repeat(64)})).status,409);
  live=false;assert.equal((await post(decision)).status,409);assert.equal(authorized,false);live=true;
  const accepted=await(await post(decision)).json();assert.equal(accepted.accepted,true);assert.equal(accepted.dispatchAccepted,true);
  assert.equal(accepted.newFinancialAuthority,false);assert.equal(dispatches,1);assert.ok(proofs>=4);
  assert.equal((await post(decision)).status,409);assert.equal(dispatches,1);
  assert.equal((await(await get()).json()).state,'claimed_once');
 }finally{for(const [k,v] of Object.entries(prior))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {modules} from './helpers/load-project-modules.mjs';
const release='d530aa94dd8d9c2bc442b43b324ace312d0d62b9';
const checkpoint='8e53ce01693303fc50daf5da1567e93e725f9b2d';
const task='d0e41ff5-149e-4319-9e65-dcc605fb75da';
const project='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const owner='04ed6c05-a586-4a56-ba81-1b50e378746b';
const chat='e53defeb-16eb-457e-aa07-435141165ee8';
const limits={cumulativeTokens:240000,developmentTokens:180000,developmentCalls:24,
 assessmentTokens:60000,completionTokens:60000,assessmentCalls:4,completionCalls:4,
 perCallMicrousd:1680000,ceilingMicrousd:6000000,durationSeconds:14400};
test('Task 4A postpaid owner HTTP route: three independent decisions and no inferred paid grant',async()=>{
 const previous={owner:process.env.KATIE_OWNER_AUTH_USER_ID,env:process.env.VERCEL_ENV,sha:process.env.VERCEL_GIT_COMMIT_SHA};
 process.env.KATIE_OWNER_AUTH_USER_ID=owner;process.env.VERCEL_ENV='production';process.env.VERCEL_GIT_COMMIT_SHA=release;
 let signed=false,stage=0,dispatches=0,commits=0,providerCalls=0;
 const receipt=()=>{
  const list=[];
  if(stage>=1)list.push({id:'owner-receipt',event:'task4a_postpaid_owner_authorized'});
  if(stage>=2)list.push({id:'redispatch-receipt',event:'task4a_postpaid_redispatch_authorized'});
  if(stage>=3)list.push({id:'paid-receipt',event:'task4a_postpaid_paid_authorized'});
  if(stage>=4)list.push({id:'one-claim',event:'task4a_postpaid_dispatch_claimed'});
  return list;
 };
 const db={
  from(table){
   assert.equal(table,'project_events');
   return {select:()=>({eq:()=>({in:()=>({
     returns:async()=>({data:receipt(),error:null})
   })})})};
  },
  async rpc(name,args){
   assert.equal(args.p_release,release);
   if(name==='task4a_postpaid_proposal'){
    assert.equal(args.p_checkpoint,checkpoint);
    assert.equal(args.p_checkpoint_digest,'f'.repeat(64));
    if(args.p_limits===null)return {data:{ready:false,reason:'explicit_owner_limits_required',
     evidence:{settledCalls:4,settledTokens:49620}},error:null};
    assert.deepEqual(args.p_limits,limits);
    return {data:{ready:true,digest:'a'.repeat(64),
     proposal:{kind:'task4a_postpaid_same_task_continuation',ownerId:owner,taskId:task,
      nativeLimits:limits,checkpointSha:checkpoint}},error:null};
   }
   if(name==='task4a_postpaid_redispatch_proposal')
    return {data:stage===1?{ready:true,digest:'b'.repeat(64),proposal:{ownerId:owner}}:{ready:false},error:null};
   if(name==='task4a_postpaid_paid_proposal')
    return {data:stage===2?{ready:true,digest:'c'.repeat(64),proposal:{ownerId:owner}}:{ready:false},error:null};
   assert.equal(args.p_owner,owner);
   if(name==='task4a_postpaid_authorize'){
    assert.equal(args.p_digest,'a'.repeat(64));assert.equal(stage,0);
    assert.deepEqual(args.p_limits,limits);stage=1;commits++;
    return {data:{authorized:true,receiptId:'owner-receipt',newApprovalId:'approved-native',
      newContinuationId:'approved-continuation',deadline:'2026-11-06T04:00:00Z',
      dispatchAuthorized:false,paidInferenceAuthorized:false,newPaidCalls:0},error:null};
   }
   if(name==='task4a_postpaid_authorize_redispatch'){
    assert.equal(args.p_digest,'b'.repeat(64));assert.equal(stage,1);
    stage=2;commits++;return {data:{authorized:true,receiptId:'redispatch-receipt',
      dispatched:false,paidInferenceAuthorized:false},error:null};
   }
   assert.equal(name,'task4a_postpaid_authorize_paid');
   assert.equal(args.p_digest,'c'.repeat(64));assert.equal(stage,2);
   stage=3;commits++;return {data:{authorized:true,receiptId:'paid-receipt'},error:null};
  }
 };
 const {GET,POST}=modules({
  'next/server':{NextResponse:{json:(body,opts)=>Response.json(body,opts)}},
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>signed},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},
  '@/lib/agents/development':{
   authenticatedLifecycleCheckpoint:async()=>({record:{checkpointSha:checkpoint,
    runId:'42102615797',taskId:task,projectId:project},checkpoint:{checkpointSha:checkpoint}}),
   qualifiedOrdinaryDevelopmentRelease:async()=>release,
   dispatchTask4aPostpaidOnce:async()=>{dispatches++;stage=4;return true;}
  },
  '@/lib/projects/contract':{digest:()=> 'f'.repeat(64)}
 })('@/app/api/projects/task4a-postpaid-continuation/route');
 const get=()=>GET(new Request('https://katie.local/api/projects/task4a-postpaid-continuation?chatId='+chat));
 const post=payload=>POST(new Request('https://katie.local/api/projects/task4a-postpaid-continuation',
  {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}));
 try{
  assert.equal((await get()).status,401);
  assert.equal((await post({action:'approveAuthority',limits,digest:'a'.repeat(64),confirm:true})).status,403);
  signed=true;
  assert.equal((await post({action:'approveAuthority',limits,confirm:true})).status,400);
  assert.equal((await post({action:'approvePaidInference',digest:'c'.repeat(64),confirm:true})).status,409);
  assert.equal((await (await get()).json()).state,'requires_owner_limits');
  const q=await post({action:'previewAuthority',limits});assert.equal(q.status,200);
  assert.equal((await q.json()).digest,'a'.repeat(64));
  assert.equal(dispatches,0);assert.equal(commits,0);
  assert.equal((await post({action:'approveAuthority',limits,digest:'b'.repeat(64),confirm:true})).status,409);
  const ownerResult=await post({action:'approveAuthority',limits,digest:'a'.repeat(64),confirm:true});
  assert.equal(ownerResult.status,200);assert.equal((await ownerResult.json()).dispatched,false);
  assert.equal(stage,1);assert.equal(dispatches,0);
  assert.equal((await post({action:'approveAuthority',limits,digest:'a'.repeat(64),confirm:true})).status,409);
  assert.equal((await (await get()).json()).state,'pending_redispatch');
  assert.equal((await post({action:'approveRedispatch',digest:'c'.repeat(64),confirm:true})).status,409);
  const d=await post({action:'approveRedispatch',digest:'b'.repeat(64),confirm:true});
  assert.equal(d.status,200);assert.equal((await d.json()).dispatched,false);
  assert.equal(dispatches,0);
  assert.equal((await (await get()).json()).state,'pending_paid');
  assert.equal((await post({action:'approvePaidInference',digest:'b'.repeat(64),confirm:true})).status,409);
  const paid=await post({action:'approvePaidInference',digest:'c'.repeat(64),confirm:true});
  assert.equal(paid.status,200);assert.equal((await paid.json()).dispatchAccepted,true);
  assert.equal(commits,3);assert.equal(dispatches,1);assert.equal(providerCalls,0);
  assert.equal((await post({action:'approvePaidInference',digest:'c'.repeat(64),confirm:true})).status,409);
  assert.equal((await (await get()).json()).state,'claimed_once');
 }finally{
  for(const [k,v] of Object.entries({KATIE_OWNER_AUTH_USER_ID:previous.owner,
   VERCEL_ENV:previous.env,VERCEL_GIT_COMMIT_SHA:previous.sha}))
   if(v===undefined)delete process.env[k];else process.env[k]=v;
 }
});
test('known incorrect Task 4A generic owner path is removed without affecting unrelated tasks',()=>{
 const api=readFileSync('app/api/projects/lifecycle-approval/route.ts','utf8');
 const chat=readFileSync('components/chat-panel.tsx','utf8');
 const recovery=readFileSync('app/api/projects/task4a-postpaid-continuation/route.ts','utf8');
 const sql=readFileSync('supabase/migrations/20261106173000_task4a_generic_owner_approval_conflict.sql','utf8');
 assert.match(api,/taskId===TASK4A/);
 assert.match(chat,/chatId!==\'e53defeb-16eb-457e-aa07-435141165ee8\'/);
 assert.match(recovery,/authenticatedLifecycleCheckpoint\(TASK,WRONG_GENERIC_APPROVAL\)/);
 assert.match(sql,/TASK4A_GENERIC_LIFECYCLE_FORBIDDEN/);
 assert.match(sql,/mistakenGenericApproval/);
 assert.match(sql,/coalesce\(wrong.id,a.id\)/);
 assert.match(sql,/TASK4A_POSTPAID_OWNER_CONSENT_DENIED/);
 assert.doesNotMatch(sql,/delete from public.project_events/i);
});
test('no SQL owner path can bypass the two distinct consents and original settled ledger',()=>{
 const sql=readFileSync('supabase/migrations/20261105224500_task4a_postpaid_same_task_continuation.sql','utf8');
 const route=readFileSync('app/api/projects/task4a-postpaid-continuation/route.ts','utf8');
 const worker=readFileSync('lib/agents/development.ts','utf8');
 assert.match(sql,/task4a_postpaid_owner_authorized/);
 assert.match(sql,/task4a_postpaid_authorize_redispatch/);
 assert.match(sql,/task4a_postpaid_authorize_paid/);
 assert.match(sql,/task4a_postpaid_grant_ready/);
 assert.match(sql,/pg_advisory_xact_lock/);
 assert.match(sql,/task4a_postpaid_dispatch_claimed/);
 assert.match(sql,/49620/);
 assert.match(sql,/60000/);
 assert.match(sql,/pricing_status.*'verified'/s);
 assert.match(sql,/TASK4A_POSTPAID_SEPARATE_PAID_OWNER_CONSENT_REQUIRED/);
 assert.match(sql,/'mode','provider_enforced_at_responses_execution'/);
 assert.match(sql,/'modelLookupProvesInferencePermission',false/);
 assert.doesNotMatch(sql,/task4a_postpaid_model_eligible|task4a_credential_lookup/);
 assert.match(route,/authenticatedLifecycleCheckpoint/);
 assert.match(route,/qualifiedOrdinaryDevelopmentRelease/);
 assert.match(worker,/dispatchTask4aPostpaidOnce/);
 assert.match(worker,/task4a_postpaid_paid_proposal/);
});

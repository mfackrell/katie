import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {modules} from './helpers/load-project-modules.mjs';

const project='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const task='d0e41ff5-149e-4319-9e65-dcc605fb75da';
const owner='04ed6c05-a586-4a56-ba81-1b50e378746b';
const release='d530aa94dd8d9c2bc442b43b324ace312d0d62b9';
const wip='8e53ce01693303fc50daf5da1567e93e725f9b2d';
const digest='a'.repeat(64);
const limits={cumulativeTokens:260000,developmentTokens:200000,assessmentTokens:60000,
 completionTokens:60000,developmentCalls:20,assessmentCalls:4,completionCalls:4,
 perCallMicrousd:1680000,ceilingMicrousd:4000000,durationSeconds:14400};
const old={};
test('three owner decisions are explicit, ordered, digest-bound and separate from dispatch',async()=>{
 const previous={owner:process.env.KATIE_OWNER_AUTH_USER_ID,
   env:process.env.VERCEL_ENV,release:process.env.VERCEL_GIT_COMMIT_SHA};
 process.env.KATIE_OWNER_AUTH_USER_ID=owner;
 process.env.VERCEL_ENV='production';process.env.VERCEL_GIT_COMMIT_SHA=release;
 let signed=false,authority=false,redispatch=false,paid=false,dispatches=0;
 const rows=()=>[
  ...(authority?[{id:'authority-id',event:'task4a_postpaid_owner_authorized',data:{}}]:[]),
  ...(redispatch?[{id:'redispatch-id',event:'task4a_postpaid_redispatch_authorized',data:{}}]:[]),
  ...(paid?[{id:'paid-id',event:'task4a_postpaid_paid_authorized',data:{}}]:[])
 ];
 const db={from:table=>{
  assert.equal(table,'project_events');
  return{select:()=>({eq:()=>({in:()=>({returns:async()=>({data:rows(),error:null})})})})};
 },rpc:async(name,args)=>{
  assert.equal(args.p_release,release);
  if(name==='task4a_postpaid_proposal'){
   assert.equal(args.p_checkpoint,wip);
   assert.equal(args.p_checkpoint_digest,digest);
   return{data:args.p_limits?{ready:true,digest,proposal:{ownerId:owner,originalIssue:969,
    nativeLimits:args.p_limits}}:
    {ready:false,reason:'explicit_owner_limits_required',
     evidence:{settledCalls:4,settledTokens:49620}},error:null};
  }
  if(name==='task4a_postpaid_authorize'){
   assert.equal(args.p_owner,owner);assert.equal(args.p_digest,digest);
   assert.equal(authority,false);authority=true;
   return{data:{authorized:true,receiptId:'authority-id',
    newApprovalId:'approval-id',newContinuationId:'continuation-id',
    dispatchAuthorized:false,paidInferenceAuthorized:false,newPaidCalls:0},error:null};
  }
  if(name==='task4a_postpaid_redispatch_proposal')
   return{data:authority&&!redispatch?{ready:true,digest:'b'.repeat(64),
    proposal:{ownerId:owner}}:{ready:false,reason:'already_decided'},error:null};
  if(name==='task4a_postpaid_authorize_redispatch'){
   assert.equal(args.p_digest,'b'.repeat(64));assert.equal(redispatch,false);
   redispatch=true;return{data:{authorized:true,receiptId:'redispatch-id',
    dispatched:false,paidInferenceAuthorized:false},error:null};
  }
  if(name==='task4a_postpaid_paid_proposal')
   return{data:redispatch&&!paid?{ready:true,digest:'c'.repeat(64),
     proposal:{ownerId:owner}}:{ready:false},error:null};
  if(name==='task4a_postpaid_authorize_paid'){
   assert.equal(args.p_digest,'c'.repeat(64));assert.equal(paid,false);
   paid=true;return{data:{authorized:true,receiptId:'paid-id'},error:null};
  }
  throw Error('unexpected RPC '+name);
 }};
 const loaded=modules({
  'next/server':{NextResponse:{json:(body,options)=>Response.json(body,options)}},
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>signed},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},
  '@/lib/agents/development':{
   authenticatedLifecycleCheckpoint:async()=>({record:{checkpointSha:wip,runId:'42102615797',
      projectId:project,taskId:task},checkpoint:{checkpointSha:wip}}),
   qualifiedOrdinaryDevelopmentRelease:async()=>release,
   dispatchTask4aPostpaidOnce:async()=>{dispatches++;return true;}
  },
  '@/lib/projects/contract':{digest:()=>digest}
 })('@/app/api/projects/task4a-postpaid-continuation/route');
 const get=()=>loaded.GET(new Request('https://katie.local/api/projects/task4a-postpaid-continuation?chatId=e53defeb-16eb-457e-aa07-435141165ee8'));
 const post=body=>loaded.POST(new Request('https://katie.local/api/projects/task4a-postpaid-continuation',{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
 try{
  assert.equal((await get()).status,401);
  assert.equal((await post({action:'approveAuthority',limits,digest,confirm:true})).status,403);
  signed=true;
  const initial=await(await get()).json();assert.equal(initial.state,'requires_owner_limits');
  assert.equal((await post({action:'approvePaidInference',confirm:true,digest:'c'.repeat(64)})).status,409);
  assert.equal((await post({action:'approveAuthority',confirm:true,digest})).status,400);
  assert.equal((await post({action:'approveAuthority',confirm:true,digest:'0'.repeat(64),limits})).status,409);
  assert.equal(dispatches,0);
  const quoted=await(await post({action:'previewAuthority',limits})).json();
  assert.equal(quoted.ready,true);assert.equal(quoted.digest,digest);
  assert.equal(authority,false);assert.equal(dispatches,0);
  const committed=await(await post({action:'approveAuthority',limits,confirm:true,digest})).json();
  assert.equal(committed.accepted,true);assert.equal(authority,true);
  assert.equal(redispatch,false);assert.equal(paid,false);assert.equal(dispatches,0);
  assert.equal((await post({action:'approveAuthority',limits,confirm:true,digest})).status,409);
  const stage=await(await get()).json();assert.equal(stage.nextAction,'approveRedispatch');
  assert.equal((await post({action:'approveRedispatch',confirm:true,digest:'0'.repeat(64)})).status,409);
  const dispatchConsent=await(await post({action:'approveRedispatch',confirm:true,digest:'b'.repeat(64)})).json();
  assert.equal(dispatchConsent.dispatched,false);assert.equal(dispatches,0);
  assert.equal((await post({action:'approveRedispatch',confirm:true,digest:'b'.repeat(64)})).status,409);
  assert.equal((await(await get()).json()).nextAction,'approvePaidInference');
  const last=await(await post({action:'approvePaidInference',confirm:true,digest:'c'.repeat(64)})).json();
  assert.equal(last.dispatchAccepted,true);assert.equal(paid,true);assert.equal(dispatches,1);
  assert.equal((await post({action:'approvePaidInference',confirm:true,digest:'c'.repeat(64)})).status,409);
  assert.equal(dispatches,1);
 }finally{
  for(const [k,v] of Object.entries({KATIE_OWNER_AUTH_USER_ID:previous.owner,
   VERCEL_ENV:previous.env,VERCEL_GIT_COMMIT_SHA:previous.release})){
   if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
 }
});
test('SQL and worker preserve old grants, require three receipts, and forbid automatic duplicate dispatch',()=>{
 const sql=readFileSync('supabase/migrations/20261105224500_task4a_postpaid_same_task_continuation.sql','utf8');
 const native=readFileSync('lib/agents/development.ts','utf8');
 const route=readFileSync('app/api/projects/task4a-postpaid-continuation/route.ts','utf8');
 for(const item of ['task4a_postpaid_owner_authorized','task4a_postpaid_redispatch_authorized',
  'task4a_postpaid_paid_authorized','task4a_postpaid_dispatch_claimed',
  'task4a_postpaid_grant_ready','task4a_postpaid_record_submitted'])
  assert.ok(sql.includes(item));
 for(const item of ['49620','60000','42102615797','8e53ce016933',
  'pg_advisory_xact_lock','developer_validate_limits','pricing_status'])
  assert.ok(sql.includes(item));
 assert.match(native,/task4a_postpaid_paid_proposal/);
 assert.match(native,/task4a_postpaid_claim/);
 assert.match(native,/task4a_postpaid_record_submitted/);
 assert.match(native,/authenticatedLifecycleCheckpoint\(task.id,a.id\)/);
 assert.match(native,/run.path==='\.github\/workflows\/autonomous-development.yml'/);
 assert.match(route,/verifiedProjectOwnerSession/);
 assert.match(route,/authenticatedLifecycleCheckpoint/);
 assert.match(route,/qualifiedOrdinaryDevelopmentRelease/);
 assert.doesNotMatch(route.slice(route.indexOf("if(stage==='redispatch')"),route.indexOf("let accepted=false")),/dispatchTask4aPostpaidOnce/);
});

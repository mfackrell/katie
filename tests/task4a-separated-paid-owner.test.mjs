import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {modules} from './helpers/load-project-modules.mjs';

const owner='04ed6c05-a586-4a56-ba81-1b50e378746b';
const release='1143ca99ea16f90877ad55e68da05656864d2cd9';
const recoveryDigest='a'.repeat(64),paidDigest='b'.repeat(64);
const base={ownerId:owner,taskId:'d0e41ff5-149e-4319-9e65-dcc605fb75da',
 issueNumber:969,model:'openai:gpt-5.3-codex',
 originalClaimId:'283dd2c4-5bac-4804-b8ed-3358c22896b0',
 approvalId:'12345678-1234-4123-8123-123456789abc',
 continuationId:'12345678-1234-4123-8123-123456789def',
 expiresAt:'2026-11-06T12:00:00.000Z',
 nativeLimits:{cumulativeTokens:180000,developmentCalls:12,
  assessmentCalls:4,completionCalls:4,ceilingMicrousd:2520000}};

test('authenticated recovery cannot dispatch; separate paid owner action can initiate one dispatch',async()=>{
 const previous={owner:process.env.KATIE_OWNER_AUTH_USER_ID,
  env:process.env.VERCEL_ENV,sha:process.env.VERCEL_GIT_COMMIT_SHA};
 process.env.KATIE_OWNER_AUTH_USER_ID=owner;
 process.env.VERCEL_ENV='production';process.env.VERCEL_GIT_COMMIT_SHA=release;
 let signed=false,recovery=false,paid=false,dispatches=0,recoveryCommits=0,paidCommits=0;
 const records=()=>[
  ...(recovery?[{id:'recovery-receipt',event:'task4a_failed_dispatch_owner_authorized'}]:[]),
  ...(paid?[{id:'paid-receipt',event:'task4a_failed_dispatch_paid_execution_authorized'}]:[])
 ];
 const db={
  from:table=>{
   assert.equal(table,'project_events');
   return {select:()=>({eq:()=>({in:()=>({order:()=>({
    returns:async()=>({data:records(),error:null})
   })})})})};
  },
  rpc:async(name,args)=>{
   assert.equal(args.p_release,release);
   if(name==='task4a_failed_dispatch_proposal')
    return {data:!recovery?{ready:true,digest:recoveryDigest,proposal:base}:{ready:false,reason:'already_recovered'},error:null};
   if(name==='task4a_paid_execution_proposal')
    return {data:recovery&&!paid?{ready:true,digest:paidDigest,
     proposal:{...base,recoveryReceiptId:'recovery-receipt',recoveryDigest}}:
     {ready:false,reason:'paid_authorized'},error:null};
   assert.equal(args.p_owner,owner);
   if(name==='task4a_authorize_failed_dispatch'){
    assert.equal(args.p_digest,recoveryDigest);
    assert.equal(recovery,false);recovery=true;recoveryCommits++;
    return {data:{authorized:true,receiptId:'recovery-receipt',
     recoveryOnly:true,dispatchAuthorized:false,newExecutionGrants:0,newPaidCalls:0},error:null};
   }
   assert.equal(name,'task4a_authorize_paid_execution');
   assert.equal(args.p_digest,paidDigest);assert.equal(recovery,true);
   assert.equal(paid,false);paid=true;paidCommits++;
   return {data:{authorized:true,paidExecutionAuthorized:true,
    receiptId:'paid-receipt',recoveryReceiptId:'recovery-receipt'},error:null};
  }
 };
 const {GET,POST}=modules({
  'next/server':{NextResponse:{json:(body,opts)=>Response.json(body,opts)}},
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>signed},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},
  '@/lib/agents/development':{dispatchTask4aFailedDispatchOnce:async()=>{
   assert.equal(recovery,true);assert.equal(paid,true);dispatches++;return true;
  }}
 })('@/app/api/projects/task4a-failed-dispatch/route');
 const get=()=>GET(new Request('https://katie.local/api/projects/task4a-failed-dispatch'));
 const post=body=>POST(new Request('https://katie.local/api/projects/task4a-failed-dispatch',{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
 try{
  assert.equal((await get()).status,401);
  assert.equal((await post({action:'approveRecovery',confirm:true,digest:recoveryDigest})).status,403);
  signed=true;
  assert.equal((await post({confirm:true,digest:recoveryDigest})).status,400,
   'Old combined action must not work');
  assert.equal((await post({action:'approvePaidExecution',confirm:true,digest:paidDigest})).status,409,
   'Paid action requires prior distinct recovery consent');
  const first=await (await get()).json();
  assert.equal(first.nextAction,'approveRecovery');
  assert.equal(first.digest,recoveryDigest);
  process.env.VERCEL_ENV='preview';
  assert.equal((await post({action:'approveRecovery',confirm:true,digest:recoveryDigest})).status,503);
  process.env.VERCEL_ENV='production';
  assert.equal((await post({action:'approveRecovery',confirm:true,digest:paidDigest})).status,409);
  assert.equal(dispatches,0);
  const restored=await post({action:'approveRecovery',confirm:true,digest:recoveryDigest});
  assert.equal(restored.status,200);
  const restoredBody=await restored.json();
  assert.equal(restoredBody.phase,'recovery');
  assert.equal(restoredBody.dispatched,false);
  assert.equal(restoredBody.newPaidCalls,0);
  assert.equal(restoredBody.newExecutionGrants,0);
  assert.equal(recoveryCommits,1);assert.equal(paidCommits,0);assert.equal(dispatches,0);
  assert.equal((await post({action:'approveRecovery',confirm:true,digest:recoveryDigest})).status,409);
  const second=await (await get()).json();
  assert.equal(second.nextAction,'approvePaidExecution');
  assert.equal(second.digest,paidDigest);
  assert.notEqual(second.digest,first.digest);
  assert.equal(second.proposal.recoveryReceiptId,'recovery-receipt');
  assert.equal(dispatches,0);
  assert.equal((await post({action:'approvePaidExecution',confirm:false,digest:paidDigest})).status,400);
  assert.equal((await post({action:'approvePaidExecution',confirm:true,digest:recoveryDigest})).status,409);
  assert.equal(dispatches,0);
  process.env.KATIE_OWNER_AUTH_USER_ID='99999999-9999-4999-8999-999999999999';
  assert.equal((await post({action:'approvePaidExecution',confirm:true,digest:paidDigest})).status,403);
  process.env.KATIE_OWNER_AUTH_USER_ID=owner;
  const launched=await post({action:'approvePaidExecution',confirm:true,digest:paidDigest});
  assert.equal(launched.status,200);
  const launchedBody=await launched.json();
  assert.equal(launchedBody.phase,'paidExecution');
  assert.equal(launchedBody.dispatchAccepted,true);
  assert.equal(launchedBody.paidExecutionReceiptId,'paid-receipt');
  assert.equal(recoveryCommits,1);assert.equal(paidCommits,1);assert.equal(dispatches,1);
  assert.equal((await post({action:'approvePaidExecution',confirm:true,digest:paidDigest})).status,409);
  assert.equal(dispatches,1,'Replaying owner consent cannot duplicate GitHub dispatch');
  const final=await (await get()).json();
  assert.equal(final.alreadyPaidAuthorized,true);
  assert.equal(final.ownerAuthorizationReceiptId,'recovery-receipt');
  assert.equal(final.paidExecutionReceiptId,'paid-receipt');
 }finally{
  for(const [key,value] of Object.entries({KATIE_OWNER_AUTH_USER_ID:previous.owner,
   VERCEL_ENV:previous.env,VERCEL_GIT_COMMIT_SHA:previous.sha})){
   if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
 }
});

test('native and PostgreSQL execution-grant paths require both immutable owner receipts',()=>{
 const route=readFileSync('app/api/projects/task4a-failed-dispatch/route.ts','utf8');
 const native=readFileSync('lib/agents/development.ts','utf8');
 const sql=readFileSync('supabase/migrations/20261105210000_task4a_separate_dispatch_paid_execution.sql','utf8');
 const ui=readFileSync('components/task4a-failed-dispatch-recovery-approval.tsx','utf8');
 assert.match(route,/action:z\.literal\('approveRecovery'\)/);
 assert.match(route,/action:z\.literal\('approvePaidExecution'\)/);
 const recovery=route.slice(route.indexOf('if(!paid){'),route.indexOf('// Distinct second owner decision'));
 assert.doesNotMatch(recovery,/dispatchTask4aFailedDispatchOnce/);
 assert.match(native,/task4a_paid_execution_proposal/);
 assert.match(native,/task4a_failed_dispatch_paid_execution_authorized/);
 assert.match(sql,/task4a_one_paid_execution_consent/);
 assert.match(sql,/task4a_paid_execution_receipt_immutable/);
 assert.match(sql,/task4a_distinct_paid_grant_guard/);
 assert.match(sql,/TASK4A_SEPARATE_PAID_AUTH_REQUIRED_BEFORE_GRANT/);
 assert.match(sql,/task4a_claim_failed_dispatch/);
 assert.match(sql,/paidExecutionReceiptId/);
 assert.match(sql,/pg_advisory_xact_lock/);
 assert.match(ui,/Decision 1 — recovery only/);
 assert.match(ui,/Decision 2 — bounded paid execution/);
});

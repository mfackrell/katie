import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {modules} from './helpers/load-project-modules.mjs';

const owner='04ed6c05-a586-4a56-ba81-1b50e378746b';
const project='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const release='535492415e5eb5ccbdc58fd9eabf5716fc9db032';
const digest='c'.repeat(64);
const limits={deadline:'2026-11-07T15:00:00.000Z',tokens:240000,calls:24,dollarsCents:900};
const proposal={ownerId:owner,productionReleaseSha:release,
 newDeadline:limits.deadline,incrementalTokens:240000,incrementalCalls:24,
 incrementalMicrousd:9000000,originalFailedClaimId:'283dd2c4-5bac-4804-b8ed-3358c22896b0',
 previousContinuationId:'02951ce8-e502-4fe0-852c-95a69c877b78',
 previousNativeApprovalId:'c8dfdbf2-56e2-474d-a8b4-82267001fb47',
 nativeLimits:{cumulativeTokens:180000,ceilingMicrousd:2520000}};

test('owner-governed blocked Task 4A recovery requires authenticated exact digest and distinct paid dispatch consent',async()=>{
 const save={owner:process.env.KATIE_OWNER_AUTH_USER_ID,env:process.env.VERCEL_ENV,sha:process.env.VERCEL_GIT_COMMIT_SHA};
 process.env.KATIE_OWNER_AUTH_USER_ID=owner;
 process.env.VERCEL_ENV='production';
 process.env.VERCEL_GIT_COMMIT_SHA=release;
 let signed=false,ownerValid=true,eligible=true,granted=0,readOnly=0;
 const db={
  rpc:async(name,args)=>{
   if(name==='task4a_original_owner_id')return {data:ownerValid?owner:null,error:null};
   if(name==='task4a_blocked_dispatch_proposal'){
    assert.deepEqual(args,{p_release:release,p_deadline:limits.deadline,
     p_tokens:240000,p_calls:24,p_money:9000000});
    readOnly++;return {data:eligible?{ready:true,digest,proposal}:{ready:false,reason:'expired'},error:null};
   }
   assert.equal(name,'task4a_authorize_blocked_dispatch');
   assert.equal(args.p_owner,owner);
   assert.equal(args.p_digest,digest);
   granted++;eligible=false;
   return {data:{authorized:true,receiptId:'receipt',newContinuationId:'renewal',newNativeApprovalId:'native'},error:null};
  },
  from:name=>{
   if(name==='work_projects')return {select:()=>({eq:(k,id)=>({
    maybeSingle:async()=>({data:id===project?{actor_id:'actor',chat_id:'chat'}:null,error:null})
   })})};
   assert.equal(name,'project_events');
   return {select:()=>({eq:()=>({eq:()=>({
    maybeSingle:async()=>({data:granted?{id:'receipt',data:{newContinuationId:'renewal',newNativeApprovalId:'native'},created_at:'2026-11-05'}:null,error:null})
   })})})};
  }
 };
 const {GET,POST}=modules({
  'next/server':{NextResponse:{json:(body,opts)=>Response.json(body,opts)}},
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>signed},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db}
 })('@/app/api/projects/task4a-blocked-dispatch/route');
 const get=()=>GET(new Request('https://katie.local/api/projects/task4a-blocked-dispatch'));
 const post=body=>POST(new Request('https://katie.local/api/projects/task4a-blocked-dispatch',{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
 try{
  assert.equal((await get()).status,401);
  assert.equal((await post({action:'approve',limits,digest})).status,403);
  assert.equal(granted,0);
  signed=true;
  assert.equal((await get()).status,200);
  assert.equal((await post({action:'approve',limits:{...limits,dollarsCents:1000},digest})).status,400);
  assert.equal((await post({action:'approve',limits:{...limits,deadline:'broken'},digest})).status,400);
  assert.equal((await post({action:'approve',limits,digest:'f'.repeat(64)})).status,409);
  assert.equal(granted,0);
  const preview=await post({action:'propose',limits});
  assert.equal(preview.status,200);
  assert.equal((await preview.json()).digest,digest);
  assert.equal(granted,0,'Read-only proposal never creates spending authority');
  ownerValid=false;
  assert.equal((await post({action:'approve',limits,digest})).status,403);
  assert.equal(granted,0);
  ownerValid=true;
  process.env.VERCEL_ENV='preview';
  assert.equal((await post({action:'approve',limits,digest})).status,503,'Preview must never issue owner renewal');
  process.env.VERCEL_ENV='production';
  const result=await post({action:'approve',limits,digest});
  assert.equal(result.status,200);
  const receipt=await result.json();
  assert.equal(receipt.developmentDispatched,false);
  assert.equal(receipt.newPaidCalls,0);
  assert.equal(receipt.separatePaidDispatchConsentRequired,true);
  assert.equal(granted,1);
  assert.equal((await post({action:'approve',limits,digest})).status,409);
  assert.equal(granted,1,'Second exact grant is denied after use');
  assert.equal((await get()).status,200);
  assert.equal((await (await get()).json()).alreadyAuthorized,true);
  assert.ok(readOnly>=4);
 }finally{
  for(const [key,val] of Object.entries({KATIE_OWNER_AUTH_USER_ID:save.owner,VERCEL_ENV:save.env,VERCEL_GIT_COMMIT_SHA:save.sha})){
   if(val===undefined)delete process.env[key];else process.env[key]=val;
  }
 }
});

test('original signed dispatch, immutable owner receipt and distinct paid consent remain mandatory',()=>{
 const native=readFileSync('lib/agents/development.ts','utf8');
 const sql=readFileSync('supabase/migrations/20261105173000_task4a_blocked_dispatch_owner_recovery.sql','utf8');
 const ui=readFileSync('components/task4a-blocked-dispatch-owner-approval.tsx','utf8');
 const panel=readFileSync('components/chat-panel.tsx','utf8');
 assert.match(native,/renewal\?\.version==='blocked-dispatch-owner-v1'/);
 assert.match(native,/priorProof\.approvalId!==renewal\.previousApprovalId/);
 assert.match(native,/task4a_blocked_dispatch_owner_recovered/);
 assert.match(native,/task4a_failed_dispatch_owner_authorized/);
 assert.match(sql,/pg_advisory_xact_lock/);
 assert.match(sql,/task4a_one_blocked_dispatch_owner_recovery/);
 assert.match(sql,/originalFailedClaimId/);
 assert.match(sql,/public\.task4a_native_authority_ready/);
 assert.match(sql,/Ordinary authority requires its committed exact owner decision/);
 assert.match(ui,/Preview exact renewal \(no charges\)/);
 assert.match(ui,/Approve exact deadline and renewed authority/);
 assert.match(ui,/separate (signed )?consent/i);
 assert.match(panel,/Task4aBlockedDispatchOwnerApproval/);
 assert.doesNotMatch(sql,/create.*workflow_dispatch|create.*benchmark_budget_calls/i);
});

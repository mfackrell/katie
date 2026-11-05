import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';
const project='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const owner='04ed6c05-a586-4a56-ba81-1b50e378746b';
const task='d0e41ff5-149e-4319-9e65-dcc605fb75da';
const oldApproval='ddccc7a1-743f-4031-8ecd-a6926568ca98';
const continuation='405ea82c-6f52-49e5-babf-891ecac64d14';
const digest='e'.repeat(64);

test('pre-inference Task4A recovery requires authenticated owner and exact unchanged-limit proposal',async()=>{
 const savedOwnerEnv=process.env.KATIE_OWNER_AUTH_USER_ID;
 process.env.KATIE_OWNER_AUTH_USER_ID=owner;
 let signed=false,commits=0,eligible=true;
 const limits={cumulativeTokens:180000,developmentTokens:120000,
  developmentCalls:12,assessmentCalls:4,completionCalls:4,
  assessmentTokens:60000,completionTokens:60000,
  perCallMicrousd:1680000,ceilingMicrousd:2520000,durationSeconds:86400};
 const proposal={ready:true,digest,proposal:{projectId:project,taskId:task,oldApprovalId:oldApproval,
  ownerId:owner,continuationId:continuation,limits,
  originalNativeDeadline:'2026-11-04T16:17:55.386Z',
  continuationDeadline:'2026-11-03T18:43:35.617Z',
  replacementDeadline:'2026-11-03T18:43:35.617Z'}};
 const db={rpc:async(name,args)=>{
  if(name==='task4a_native_recovery_proposal')return {data:eligible?proposal:null,error:null};
  assert.equal(name,'task4a_confirm_pregrant_recovery');
  assert.equal(args.p_owner,owner);assert.equal(args.p_digest,digest);
  commits++;eligible=false;
  return {data:{recovered:true,receiptId:'receipt',newApprovalId:'new-grant',
   nativeDeadline:proposal.proposal.replacementDeadline},error:null};
 },from:table=>{
  assert.equal(table,'benchmark_native_spending_approvals');
  const filters={};
  const chain={
   select:()=>chain,
   eq:(key,value)=>{filters[key]=value;return chain;},
   maybeSingle:async()=>{
    assert.equal(filters.previous_developer_approval_id,oldApproval);
    assert.equal(filters.project_id,project);
    assert.equal(filters.task_id,task);
    return {data:eligible?null:{
     id:'new-grant',created_at:'2026-11-05T13:43:04Z',
     developer_authority:{task4aRecovery:{version:'preinference-invalid-handoff-v1',
      oldApprovalId:oldApproval,issueNumber:969,ownerConsentDigest:digest}}
    },error:null};
   }
  };
  return chain;
 }};
 const {GET,POST}=modules({
  'next/server':{NextResponse:{json:(body,options)=>Response.json(body,options)}},
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>signed},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db}
 })('@/app/api/projects/task4a-native-recovery/route');
 const get=()=>GET(new Request('https://katie.local/api/projects/task4a-native-recovery'));
 const post=body=>POST(new Request('https://katie.local/api/projects/task4a-native-recovery',{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
 assert.equal((await get()).status,401);
 assert.equal((await post({confirm:true,proposalDigest:digest})).status,403);
 assert.equal(commits,0);
 signed=true;
 const preview=await get();
 assert.equal(preview.status,200);
 const details=await preview.json();
 assert.equal(details.ready,true);
 assert.equal(details.proposal.limits.ceilingMicrousd,2520000);
 assert.equal(details.proposal.continuationId,continuation);
 assert.equal(details.proposal.oldApprovalId,oldApproval);
 assert.equal((await post({confirm:false,proposalDigest:digest})).status,400);
 assert.equal((await post({confirm:true,proposalDigest:'f'.repeat(64)})).status,409);
 assert.equal(commits,0);
 process.env.KATIE_OWNER_AUTH_USER_ID='99999999-9999-4999-8999-999999999999';
 assert.equal((await get()).status,403,'Native proposal must reject unrelated owner');
 assert.equal((await post({confirm:true,proposalDigest:digest})).status,403,'Native owner mismatch blocks approval');
 assert.equal(commits,0);
 process.env.KATIE_OWNER_AUTH_USER_ID=owner;
 const approved=await post({confirm:true,proposalDigest:digest});
 assert.equal(approved.status,200);
 assert.equal((await approved.json()).sameAccountSameLimits,true);
 assert.equal(commits,1);
 assert.equal((await post({confirm:true,proposalDigest:digest})).status,409);
 assert.equal(commits,1,'No duplicate authority accepted');
 const saved=await get();
 assert.equal(saved.status,200);
 const savedResult=await saved.json();
 assert.equal(savedResult.recovered,true);
 assert.equal(savedResult.originalIssueNumber,969);
 assert.equal(savedResult.noNewSpendingAuthorized,true);
 assert.equal(commits,1,'Read-only status must not authorize additional spending');
 if(savedOwnerEnv===undefined)delete process.env.KATIE_OWNER_AUTH_USER_ID;
 else process.env.KATIE_OWNER_AUTH_USER_ID=savedOwnerEnv;
});

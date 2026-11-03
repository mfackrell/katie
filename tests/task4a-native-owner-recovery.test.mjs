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
 const approved=await post({confirm:true,proposalDigest:digest});
 assert.equal(approved.status,200);
 assert.equal((await approved.json()).sameAccountSameLimits,true);
 assert.equal(commits,1);
 assert.equal((await post({confirm:true,proposalDigest:digest})).status,409);
 assert.equal(commits,1,'No duplicate authority accepted');
});

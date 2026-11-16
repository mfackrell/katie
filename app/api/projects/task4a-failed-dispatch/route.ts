import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {dispatchTask4aFailedDispatchOnce} from '@/lib/agents/development';

export const runtime='nodejs';
const PROJECT='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const consent=z.discriminatedUnion('action',[
 z.object({action:z.literal('approveRecovery'),confirm:z.literal(true),digest}).strict(),
 z.object({action:z.literal('approvePaidExecution'),confirm:z.literal(true),digest}).strict()
]);
type Offer={ready?:boolean;reason?:string;digest?:string;proposal?:{
 ownerId:string;taskId:string;issueNumber:number;model:string;
 originalClaimId:string;approvalId:string;continuationId:string;
 recoveryReceiptId?:string;recoveryDigest?:string;
 nativeLimits:{cumulativeTokens:number;developmentCalls:number;assessmentCalls:number;
 completionCalls:number;ceilingMicrousd:number};expiresAt:string;
}};
type Saved={ownerAuthorizationReceiptId:string|null;paidExecutionReceiptId:string|null;
 claimReceiptId:string|null;githubAcceptedReceiptId:string|null};
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
function releaseSha(){
 const sha=process.env.VERCEL_GIT_COMMIT_SHA;
 return process.env.VERCEL_ENV==='production'&&sha&&/^[a-f0-9]{40}$/.test(sha)?sha:null;
}
async function savedState():Promise<Saved>{
 const {data,error}=await getSupabaseAdminClient().from('project_events')
  .select('id,event,created_at').eq('project_id',PROJECT)
  .in('event',['task4a_failed_dispatch_owner_authorized',
   'task4a_failed_dispatch_paid_execution_authorized',
   'task4a_failed_dispatch_recovery_claimed',
   'task4a_failed_dispatch_recovery_submitted'])
  .order('created_at',{ascending:true})
  .returns<{id:string;event:string;created_at:string}>();
 if(error)throw Error('Immutable Task 4A two-consent history unavailable');
 const event=(name:string)=>data?.find(e=>e.event===name)?.id??null;
 return {ownerAuthorizationReceiptId:event('task4a_failed_dispatch_owner_authorized'),
  paidExecutionReceiptId:event('task4a_failed_dispatch_paid_execution_authorized'),
  claimReceiptId:event('task4a_failed_dispatch_recovery_claimed'),
  githubAcceptedReceiptId:event('task4a_failed_dispatch_recovery_submitted')};
}
export async function GET(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Original owner sign-in required'},401);
 const release=releaseSha();if(!release)return reply({error:'Exact production SHA unavailable'},503);
 try{
  const saved=await savedState();
  if(saved.paidExecutionReceiptId||saved.claimReceiptId)
   return reply({ready:false,alreadyPaidAuthorized:Boolean(saved.paidExecutionReceiptId),
    ...saved,originalIssue:969,noNewProject:true,
    noAutomaticRedispatch:true});
  const action=saved.ownerAuthorizationReceiptId?'approvePaidExecution':'approveRecovery';
  const rpc=action==='approvePaidExecution'?'task4a_paid_execution_proposal':'task4a_failed_dispatch_proposal';
  const {data,error}=await getSupabaseAdminClient().rpc<Offer>(rpc,{p_release:release});
  if(error)return reply({error:'Failed original-dispatch qualification'},503);
  if(!data?.ready||!data.digest||!data.proposal)
   return reply({ready:false,reason:data?.reason??'Unqualified original dispatch',...saved},409);
  if(data.proposal.ownerId!==process.env.KATIE_OWNER_AUTH_USER_ID)
   return reply({error:'Original project owner mismatch'},403);
  return reply({...data,...saved,nextAction:action,
   recoveryOnly:action==='approveRecovery',nonbillableReadOnly:true});
 }catch{return reply({error:'Original Task 4A recovery evidence unavailable'},503);}
}
export async function POST(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Authenticated original owner required'},403);
 let input:z.infer<typeof consent>;
 try{input=consent.parse(await request.json());}
 catch{return reply({error:'Separate exact-digest recovery or paid-execution action required'},400);}
 const release=releaseSha();if(!release)return reply({error:'Production release not qualified'},503);
 const db=getSupabaseAdminClient();
 const paid=input.action==='approvePaidExecution';
 const {data:offer,error}=await db.rpc<Offer>(
  paid?'task4a_paid_execution_proposal':'task4a_failed_dispatch_proposal',
  {p_release:release});
 if(error||!offer?.ready||!offer.proposal||offer.digest!==input.digest)
  return reply({error:'Failed dispatch evidence or requested owner-decision digest is stale'},409);
 if(offer.proposal.ownerId!==process.env.KATIE_OWNER_AUTH_USER_ID)
  return reply({error:'Original owner identity mismatch'},403);
 if(!paid){
  // This transaction records recovery consent ONLY. It must never invoke GitHub
  // or create a grant: a second digest and a second owner action are required.
  const {data:receipt,error:commitError}=await db.rpc<{
   authorized:boolean;receiptId:string;recoveryOnly:boolean;dispatchAuthorized:boolean;
   newExecutionGrants:number;newPaidCalls:number
  }>('task4a_authorize_failed_dispatch',{
   p_owner:offer.proposal.ownerId,p_digest:input.digest,p_release:release
  });
  if(commitError||receipt?.authorized!==true||receipt.recoveryOnly!==true||
    receipt.dispatchAuthorized!==false||receipt.newExecutionGrants!==0||receipt.newPaidCalls!==0)
   return reply({error:'Atomic recovery-only owner consent rejected; dispatch is prohibited'},409);
  return reply({accepted:true,phase:'recovery',ownerAuthorizationReceiptId:receipt.receiptId,
   dispatched:false,paidExecutionAuthorized:false,newPaidCalls:0,newExecutionGrants:0,
   separatePaidExecutionDecisionRequired:true,originalIssue:969});
 }
 // Distinct second owner decision: fresh digest + fresh SQL financial/pricing
 // evidence. The native dispatcher can claim only AFTER this receipt commits.
 const {data:receipt,error:commitError}=await db.rpc<{
  authorized:boolean;receiptId:string;recoveryReceiptId:string;
  paidExecutionAuthorized:boolean
 }>('task4a_authorize_paid_execution',{
  p_owner:offer.proposal.ownerId,p_digest:input.digest,p_release:release
 });
 if(commitError||receipt?.authorized!==true||receipt.paidExecutionAuthorized!==true)
  return reply({error:'Atomic distinct paid-execution authorization rejected'},409);
 let dispatchAccepted=false,dispatchStatus='paid_authorized_pending_native_dispatch';
 try{
  dispatchAccepted=await dispatchTask4aFailedDispatchOnce();
  dispatchStatus=dispatchAccepted?'github_dispatch_accepted':'paid_authorized_pending_native_dispatch';
 }catch{
  // GitHub may have accepted the dispatch before this response failed.
  // The SQL claim is permanently one-shot; NEVER automatically retry.
  dispatchStatus='dispatch_status_uncertain_reconcile_claim_and_github_runs';
 }
 return reply({accepted:true,phase:'paidExecution',
  ownerAuthorizationReceiptId:receipt.recoveryReceiptId,
  paidExecutionReceiptId:receipt.receiptId,dispatchAccepted,dispatchStatus,
  originalIssue:969,existingTaskReused:true,newFinancialAuthority:false,
  independentAcceptanceNotYetPerformed:true});
}

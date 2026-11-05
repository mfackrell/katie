import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {dispatchTask4aFailedDispatchOnce} from '@/lib/agents/development';

export const runtime='nodejs';
const PROJECT='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const consent=z.object({confirm:z.literal(true),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type Offer={ready?:boolean;reason?:string;digest?:string;proposal?:{
 ownerId:string;taskId:string;issueNumber:number;model:string;
 originalClaimId:string;approvalId:string;continuationId:string;
 nativeLimits:{cumulativeTokens:number;developmentCalls:number;assessmentCalls:number;
 completionCalls:number;ceilingMicrousd:number};expiresAt:string;
}};
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
function releaseSha(){const sha=process.env.VERCEL_GIT_COMMIT_SHA;return sha&&/^[a-f0-9]{40}$/.test(sha)?sha:null;}
async function savedState(){
 const db=getSupabaseAdminClient();
 const {data,error}=await db.from('project_events').select('id,event,created_at')
  .eq('project_id',PROJECT)
  .in('event',['task4a_failed_dispatch_owner_authorized',
   'task4a_failed_dispatch_recovery_claimed','task4a_failed_dispatch_recovery_submitted'])
  .order('created_at',{ascending:true});
 if(error)throw Error('Immutable Task 4A recovery history unavailable');
 return {ownerAuthorizationReceiptId:data?.find(e=>e.event==='task4a_failed_dispatch_owner_authorized')?.id??null,
  claimReceiptId:data?.find(e=>e.event==='task4a_failed_dispatch_recovery_claimed')?.id??null,
  githubAcceptedReceiptId:data?.find(e=>e.event==='task4a_failed_dispatch_recovery_submitted')?.id??null};
}
export async function GET(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Original owner sign-in required'},401);
 const release=releaseSha();if(!release)return reply({error:'Exact production SHA unavailable'},503);
 try{
  const saved=await savedState();
  if(saved.ownerAuthorizationReceiptId)return reply({ready:false,alreadyAuthorized:true,
   ...saved,originalIssue:969,noNewProject:true});
  const {data,error}=await getSupabaseAdminClient().rpc<Offer>('task4a_failed_dispatch_proposal',{p_release:release});
  if(error)return reply({error:'Failed original-dispatch qualification'},503);
  if(!data?.ready||!data.digest||!data.proposal)return reply({ready:false,reason:data?.reason??'Unqualified original dispatch',...saved},409);
  if(data.proposal.ownerId!==process.env.KATIE_OWNER_AUTH_USER_ID)return reply({error:'Original project owner mismatch'},403);
  return reply({...data,...saved,nonbillableReadOnly:true});
 }catch{return reply({error:'Original Task 4A recovery evidence unavailable'},503);}
}
export async function POST(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Authenticated original owner required'},403);
 let input:z.infer<typeof consent>;
 try{input=consent.parse(await request.json());}catch{return reply({error:'Explicit exact-digest owner approval required'},400);}
 const release=releaseSha();if(!release)return reply({error:'Production release not qualified'},503);
 const db=getSupabaseAdminClient();
 const {data:offer,error}=await db.rpc<Offer>('task4a_failed_dispatch_proposal',{p_release:release});
 if(error||!offer?.ready||offer.digest!==input.digest)return reply({error:'Failed dispatch evidence or owner consent digest is stale'},409);
 if(offer.proposal?.ownerId!==process.env.KATIE_OWNER_AUTH_USER_ID)return reply({error:'Original owner identity mismatch'},403);
 const {data:receipt,error:commitError}=await db.rpc<{authorized:boolean;receiptId:string}>('task4a_authorize_failed_dispatch',{
  p_owner:offer.proposal.ownerId,p_digest:input.digest,p_release:release
 });
 if(commitError||receipt?.authorized!==true)return reply({error:'Atomic owner consent rejected; no dispatch may be assumed'},409);
 // Exact consent permits ONE signed native dispatch, which may consume the
 // existing bounded account. All GitHub and PostgreSQL gates remain mandatory.
 let dispatchAccepted=false,dispatchStatus='authorized_queued';
 try{
  dispatchAccepted=await dispatchTask4aFailedDispatchOnce();
  dispatchStatus=dispatchAccepted?'github_dispatch_accepted':'authorized_pending_native_dispatch';
 }catch{
  // External acceptance may be uncertain. No automatic second dispatch.
  dispatchStatus='dispatch_status_uncertain_reconcile_claim_and_github_runs';
 }
 return reply({accepted:true,ownerAuthorizationReceiptId:receipt.receiptId,
  dispatchAccepted,dispatchStatus,originalIssue:969,existingTaskReused:true,
  noNewFinancialGrant:true,independentAcceptanceNotYetPerformed:true});
}

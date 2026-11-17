import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';

export const runtime='nodejs';
const PROJECT='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const limits=z.object({
 deadline:z.string().datetime({offset:true}),
 tokens:z.number().int().min(180000).max(240000).safe(),
 calls:z.number().int().min(20).max(24).safe(),
 dollarsCents:z.number().int().min(252).max(900).safe()
}).strict();
const requestSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('propose'),limits}).strict(),
 z.object({action:z.literal('approve'),limits,digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
]);
type RecoveryOffer={ready?:boolean;reason?:string;digest?:string;proposal?:{
 ownerId:string;newDeadline:string;incrementalTokens:number;incrementalCalls:number;
 incrementalMicrousd:number;previousContinuationId:string;previousNativeApprovalId:string;
 originalFailedClaimId:string;productionReleaseSha:string;
 nativeLimits:{cumulativeTokens:number;ceilingMicrousd:number};
}};
const reply=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
function releaseSha(){
 const sha=process.env.VERCEL_GIT_COMMIT_SHA;
 return process.env.VERCEL_ENV==='production'&&sha&&/^[a-f0-9]{40}$/.test(sha)?sha:null;
}
async function confirmOriginalOwner(){
 const db=getSupabaseAdminClient();
 const {data:project,error}=await db.from('work_projects').select('actor_id,chat_id')
  .eq('id',PROJECT).maybeSingle<{actor_id:string;chat_id:string}>();
 if(error||!project)return false;
 const {data:owner,error:ownerError}=await db.rpc<string|null>('task4a_original_owner_id',{
  p_actor:project.actor_id,p_chat:project.chat_id
 });
 return !ownerError&&Boolean(owner)&&owner===process.env.KATIE_OWNER_AUTH_USER_ID;
}
function params(input:z.infer<typeof limits>,release:string){
 return {p_release:release,p_deadline:input.deadline,p_tokens:input.tokens,
  p_calls:input.calls,p_money:input.dollarsCents*10000};
}
export async function GET(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Original owner sign-in required'},401);
 if(!await confirmOriginalOwner())return reply({error:'Original Task 4A owner identity mismatch'},403);
 const release=releaseSha();if(!release)return reply({error:'Production release unavailable'},503);
 const {data,error}=await getSupabaseAdminClient().from('project_events')
  .select('id,data,created_at').eq('project_id',PROJECT)
  .eq('event','task4a_blocked_dispatch_owner_recovered')
  .maybeSingle<{id:string;data:{newContinuationId?:string;newNativeApprovalId?:string};created_at:string}>();
 if(error)return reply({error:'Original recovery history unavailable'},503);
 if(data)return reply({alreadyAuthorized:true,receiptId:data.id,
  newContinuationId:data.data.newContinuationId??null,
  newNativeApprovalId:data.data.newNativeApprovalId??null,
  separatePaidDispatchConsentRequired:true});
 return reply({readyForOwnerProposal:true,originalProjectId:PROJECT,
  productionSha:release,previewIsNonbillable:true,approvalNotGranted:true,
  ceiling:{tokens:240000,calls:24,dollarsCents:900,nativeTokens:180000,nativeDollarsCents:252},
  noAutomaticExtension:true});
}
export async function POST(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Authenticated owner sign-in required'},403);
 if(!await confirmOriginalOwner())return reply({error:'Original Task 4A owner identity mismatch'},403);
 const release=releaseSha();if(!release)return reply({error:'Production release unavailable'},503);
 let input:z.infer<typeof requestSchema>;
 try{input=requestSchema.parse(await request.json());}
 catch{return reply({error:'Exact renewal limits, deadline and affirmative owner action required'},400);}
 const db=getSupabaseAdminClient(),args=params(input.limits,release);
 const {data:offer,error}=await db.rpc<RecoveryOffer>('task4a_blocked_dispatch_proposal',args);
 if(error)return reply({error:'Nonbillable blocked-dispatch qualification unavailable'},503);
 if(!offer?.ready||!offer.digest||!offer.proposal)return reply({
  ready:false,reason:offer?.reason??'Original authority is ineligible'},409);
 if(offer.proposal.ownerId!==process.env.KATIE_OWNER_AUTH_USER_ID ||
  offer.proposal.productionReleaseSha!==release)
  return reply({error:'Exact owner or release mismatch'},403);
 if(input.action==='propose')return reply({ready:true,digest:offer.digest,proposal:offer.proposal,
  ownerConsentNotYetGranted:true,separatePaidDispatchConsentRequired:true});
 if(input.digest!==offer.digest)return reply({error:'Proposal changed; preview and approve again'},409);
 const {data:receipt,error:commitError}=await db.rpc<{
  authorized:boolean;receiptId:string;newContinuationId:string;newNativeApprovalId:string
 }>('task4a_authorize_blocked_dispatch',{
  p_owner:offer.proposal.ownerId,p_digest:input.digest,...args
 });
 if(commitError||receipt?.authorized!==true)return reply({
  error:'Atomic owner recovery rejected; no authority may be assumed'},409);
 return reply({accepted:true,receiptId:receipt.receiptId,
  newContinuationId:receipt.newContinuationId,newNativeApprovalId:receipt.newNativeApprovalId,
  originalProjectId:PROJECT,originalIssue:969,developmentDispatched:false,
  newPaidCalls:0,separatePaidDispatchConsentRequired:true});
}

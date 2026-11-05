import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {authenticatedLifecycleCheckpoint,qualifiedOrdinaryDevelopmentRelease,dispatchTask4aPostpaidOnce} from '@/lib/agents/development';
import {digest} from '@/lib/projects/contract';

export const runtime='nodejs';
const PROJECT='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const TASK='d0e41ff5-149e-4319-9e65-dcc605fb75da';
const WIP='8e53ce01693303fc50daf5da1567e93e725f9b2d';
const CHAT='e53defeb-16eb-457e-aa07-435141165ee8';
const digestSchema=z.string().regex(/^[a-f0-9]{64}$/);
const limits=z.object({
 cumulativeTokens:z.number().int().min(191484).max(452898),
 developmentTokens:z.number().int().min(131484),
 assessmentTokens:z.literal(60000),completionTokens:z.literal(60000),
 developmentCalls:z.number().int().min(16).max(100),
 assessmentCalls:z.literal(4),completionCalls:z.literal(4),
 perCallMicrousd:z.literal(1680000),
 ceilingMicrousd:z.number().int().min(2520000).max(9000000),
 durationSeconds:z.number().int().min(3600).max(172800)
}).strict();
const action=z.discriminatedUnion('action',[
 z.object({action:z.literal('previewAuthority'),limits}).strict(),
 z.object({action:z.literal('approveAuthority'),limits,digest:digestSchema,confirm:z.literal(true)}).strict(),
 z.object({action:z.literal('approveRedispatch'),digest:digestSchema,confirm:z.literal(true)}).strict(),
 z.object({action:z.literal('approvePaidInference'),digest:digestSchema,confirm:z.literal(true)}).strict()
]);
type Offer={ready?:boolean;reason?:string;digest?:string;proposal?:Record<string,unknown>;evidence?:Record<string,unknown>};
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
const release=()=>process.env.VERCEL_ENV==='production'&&/^[a-f0-9]{40}$/.test(process.env.VERCEL_GIT_COMMIT_SHA??'')
 ? process.env.VERCEL_GIT_COMMIT_SHA!:null;
const owner=()=>process.env.KATIE_OWNER_AUTH_USER_ID;
const db=()=>getSupabaseAdminClient();
async function receipts(){
 const {data,error}=await db().from('project_events')
  .select('id,event,data').eq('project_id',PROJECT)
  .in('event',['task4a_postpaid_owner_authorized','task4a_postpaid_redispatch_authorized',
   'task4a_postpaid_paid_authorized','task4a_postpaid_dispatch_claimed',
   'task4a_postpaid_dispatch_submitted'])
  .returns<Array<{id:string;event:string;data:Record<string,unknown>}>>();
 if(error)throw Error('Immutable Task 4A authority history unavailable');
 const get=(kind:string)=>data?.find(x=>x.event===kind);
 return {authority:get('task4a_postpaid_owner_authorized'),
  redispatch:get('task4a_postpaid_redispatch_authorized'),
  paid:get('task4a_postpaid_paid_authorized'),
  claim:get('task4a_postpaid_dispatch_claimed'),
  submitted:get('task4a_postpaid_dispatch_submitted')};
}
async function checkpoint(){
 const evidence=await authenticatedLifecycleCheckpoint(TASK);
 if(evidence.record.checkpointSha!==WIP||
  evidence.record.runId!=='42102615797'&&String(evidence.record.runId)!=='42102615797'||
  evidence.record.projectId!==PROJECT||evidence.record.taskId!==TASK)
  throw Error('Latest original Task 4A checkpoint differs');
 return {sha:WIP,hash:digest(evidence.checkpoint)};
}
async function authorityOffer(nextLimits:z.infer<typeof limits>|null,releaseSha:string){
 const verified=await checkpoint();
 const {data,error}=await db().rpc<Offer>('task4a_postpaid_proposal',{
  p_release:releaseSha,p_checkpoint:verified.sha,p_checkpoint_digest:verified.hash,p_limits:nextLimits
 });
 if(error||!data)throw Error('Evidence-bound owner proposal unavailable');
 return {offer:data,checkpoint:verified};
}
async function offerForStage(releaseSha:string,stage:'redispatch'|'paid'){
 const rpc=stage==='redispatch'?'task4a_postpaid_redispatch_proposal':'task4a_postpaid_paid_proposal';
 const {data,error}=await db().rpc<Offer>(rpc,{p_release:releaseSha});
 if(error||!data)throw Error('Fresh separate owner consent unavailable');
 return data;
}
export async function GET(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Original owner sign-in required'},401);
 if(new URL(request.url).searchParams.get('chatId')!==CHAT)return reply({state:'not_for_this_chat'});
 const sha=release();if(!sha)return reply({error:'Qualified production release SHA unavailable'},503);
 try{
  const saved=await receipts();
  if(saved.submitted||saved.claim)return reply({state:'claimed_once',originalIssue:969,
   authorityReceiptId:saved.authority?.id,redispatchReceiptId:saved.redispatch?.id,
   paidReceiptId:saved.paid?.id,claimReceiptId:saved.claim?.id,
   submittedReceiptId:saved.submitted?.id,noAutomaticRetry:true});
  if(saved.authority){
   const stage=saved.redispatch?'paid':'redispatch';
   const offer=await offerForStage(sha,stage);
   return reply({state:offer.ready?'pending_'+stage:'blocked_'+stage,
    nextAction:stage==='redispatch'?'approveRedispatch':'approvePaidInference',
    ...offer,authorityReceiptId:saved.authority.id,
    redispatchReceiptId:saved.redispatch?.id});
  }
  const {offer}=await authorityOffer(null,sha);
  return reply({state:'requires_owner_limits',...offer,
   noNewProject:true,originalIssue:969,checkpointSha:WIP});
 }catch{return reply({state:'evidence_required',
  error:'The saved checkpoint or authoritative ledger is unavailable. No authority changed.'},409);}
}
export async function POST(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Authenticated original owner required'},403);
 const sha=release();if(!sha)return reply({error:'Qualified production release SHA unavailable'},503);
 let parsed:z.infer<typeof action>;
 try{parsed=action.parse(await request.json());}
 catch{return reply({error:'Exact, explicitly scoped owner decision required'},400);}
 try{
  const saved=await receipts();
  if(saved.claim||saved.submitted)return reply({error:'Original issue dispatch already claimed; no retry'},409);
  if(parsed.action==='previewAuthority'||parsed.action==='approveAuthority'){
   if(saved.authority)return reply({error:'Successor already committed; no replay'},409);
   const {offer,checkpoint:record}=await authorityOffer(parsed.limits,sha);
   if(!offer.ready||!offer.digest||!offer.proposal)
    return reply({ready:false,reason:offer.reason,evidence:offer.evidence,
     error:'Verified official pricing or exact financial limits are required'},409);
   if(offer.proposal.ownerId!==owner())return reply({error:'Wrong original owner'},403);
   if(parsed.action==='previewAuthority')return reply({ready:true,digest:offer.digest,proposal:offer.proposal,
    note:'Preview only. Does not authorize spending or dispatch.'});
   if(offer.digest!==parsed.digest)return reply({error:'Stale owner approval digest'},409);
   const qualified=await qualifiedOrdinaryDevelopmentRelease();
   if(qualified!==sha)return reply({error:'Deployed native executor is not qualified against main'},409);
   const {data,error}=await db().rpc<{authorized:boolean;receiptId:string;newApprovalId:string;newContinuationId:string;deadline:string;
    dispatchAuthorized:boolean;paidInferenceAuthorized:boolean;newPaidCalls:number}>('task4a_postpaid_authorize',{
     p_owner:owner(),p_digest:parsed.digest,p_release:sha,
     p_checkpoint:record.sha,p_checkpoint_digest:record.hash,p_limits:parsed.limits
    });
   if(error||data?.authorized!==true||data.dispatchAuthorized!==false||
     data.paidInferenceAuthorized!==false||data.newPaidCalls!==0)
    return reply({error:'Exact atomic owner continuation approval rejected'},409);
   return reply({accepted:true,stage:'authority',...data,
    originalTask:TASK,originalIssue:969,dispatched:false});
  }
  if(!saved.authority)return reply({error:'Separate continuation authority must be committed first'},409);
  const stage=parsed.action==='approveRedispatch'?'redispatch':'paid';
  if(stage==='redispatch'&&saved.redispatch||
     stage==='paid'&&(!saved.redispatch||saved.paid))
    return reply({error:'Owner decision is out of sequence or already recorded'},409);
  const offer=await offerForStage(sha,stage);
  if(!offer.ready||!offer.proposal||offer.digest!==parsed.digest||
     offer.proposal.ownerId!==owner())
   return reply({error:'Separate owner consent is stale or invalid'},409);
  const rpc=stage==='redispatch'?'task4a_postpaid_authorize_redispatch':'task4a_postpaid_authorize_paid';
  const {data,error}=await db().rpc<{authorized:boolean;receiptId:string;dispatched?:boolean;paidInferenceAuthorized?:boolean}>(
   rpc,{p_owner:owner(),p_digest:parsed.digest,p_release:sha});
  if(error||data?.authorized!==true)return reply({error:'Atomic owner consent rejected'},409);
  if(stage==='redispatch'){
   if(data.paidInferenceAuthorized!==false||data.dispatched!==false)
    return reply({error:'Redispatch-only receipt does not meet the separate-consent contract'},409);
   return reply({accepted:true,stage:'redispatch',receiptId:data.receiptId,
    dispatched:false,paidInferenceAuthorized:false});
  }
  let accepted=false,status='paid_authorized_pending_dispatch';
  try{accepted=await dispatchTask4aPostpaidOnce();
   status=accepted?'one_original_issue_dispatch_accepted':'paid_authorized_pending_dispatch';}
  catch{status='github_status_uncertain_one_shot_claim_must_be_reconciled';}
  return reply({accepted:true,stage:'paid',paidReceiptId:data.receiptId,
   dispatchAccepted:accepted,dispatchStatus:status,
   originalIssue:969,checkpointSha:WIP,noAutomaticRetry:true});
 }catch{
  return reply({error:'Authoritative state changed or authentication failed. No consent assumed.'},409);
 }
}

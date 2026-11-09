import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {digest} from '@/lib/projects/contract';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {authenticatedTask4aVerifierCheckpoint,qualifiedTask4aVerifierHandoffRelease,qualifiedOrdinaryDevelopmentRelease,dispatchTask4aVerifierOnce} from '@/lib/agents/development';
export const runtime='nodejs';
const PROJECT='6d1c29f1-b31e-47a5-aabb-cbcf1326f388',CHAT='e53defeb-16eb-457e-aa07-435141165ee8';
const input=z.object({action:z.enum(['authority','replacement','inference','handoff','dispatch']),confirm:z.literal(true),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type Offer={ready:boolean;reason?:string;digest?:string;proposal?:{ownerId:string;checkpoint:unknown}};
type Receipt={id:string;event:string;data:{ownerId:string;consentDigest:string;result?:{approvalId:string;deadline:string};proposal?:{releaseSha?:string;releaseEvidence?:unknown}}};
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
const release=()=>process.env.VERCEL_ENV==='production'&&/^[a-f0-9]{40}$/.test(process.env.VERCEL_GIT_COMMIT_SHA??'')?process.env.VERCEL_GIT_COMMIT_SHA!:null;
async function state(){
 const r=await getSupabaseAdminClient().from('project_events').select('id,event,data').eq('project_id',PROJECT).in('event',[
 'task4a_verifier_owner_authorized','task4a_verifier_execution_authorized','task4a_verifier_inference_authorized','task4a_verifier_dispatch_authorized','task4a_verifier_execution_claimed','task4a_verifier_execution_submitted','task4a_verifier_release_handoff_authorized']).returns<Receipt>();
 if(r.error||!r.data)throw Error('Successor audit unavailable');return r.data;
}
async function quote(sha:string,action:string,approval?:string,handoff?:Receipt){
 const e=await authenticatedTask4aVerifierCheckpoint(approval);
 const releaseEvidence=action==='handoff'||handoff?await qualifiedTask4aVerifierHandoffRelease():undefined;
 if(releaseEvidence&&(releaseEvidence.releaseSha!==sha||handoff&&digest(releaseEvidence)!==digest(handoff.data.proposal?.releaseEvidence)))throw Error('Qualified release changed');
 const r=action==='handoff'?await getSupabaseAdminClient().rpc<Offer>('task4a_verifier_handoff_proposal',{p_release:sha,p_evidence:releaseEvidence}):action==='authority'?await getSupabaseAdminClient().rpc<Offer>('task4a_verifier_proposal',{p_release:sha,p_checkpoint:e.checkpoint}):
 await getSupabaseAdminClient().rpc<Offer>('task4a_verifier_execution_proposal',{p_release:sha,p_action:action});
 if(r.error||!r.data)throw Error('Successor evidence unavailable');
 if(r.data.ready&&digest(r.data.proposal?.checkpoint)!==digest(e.checkpoint))throw Error('Checkpoint changed');
 return {offer:r.data,checkpoint:e.checkpoint,releaseEvidence};
}
// These separate public event names are the append-only audit protocol.
function eventFor(action:z.infer<typeof input>['action']){
 switch(action){
  case 'authority': return 'task4a_verifier_owner_authorized';
  case 'replacement': return 'task4a_verifier_execution_authorized';
  case 'inference': return 'task4a_verifier_inference_authorized';
  case 'handoff': return 'task4a_verifier_release_handoff_authorized';
  case 'dispatch': return 'task4a_verifier_dispatch_authorized';
  default: throw Error('Unknown recovery decision');
 }
}
export async function GET(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Original owner sign-in required'},401);
 if(new URL(request.url).searchParams.get('chatId')!==CHAT)return reply({state:'not_for_this_chat'});
 const sha=release();if(!sha)return reply({error:'Production release unavailable'},503);
 try{
 const receipts=await state();
 if(receipts.some(r=>r.event==='task4a_verifier_execution_claimed'))return reply({state:'claimed_once',receipts,noAutomaticRetry:true});
 const finance=receipts.find(r=>r.event==='task4a_verifier_owner_authorized');
 const handoff=receipts.find(r=>r.event==='task4a_verifier_release_handoff_authorized');
 const action=!finance?'authority':!receipts.some(r=>r.event==='task4a_verifier_execution_authorized')?'replacement':!receipts.some(r=>r.event==='task4a_verifier_inference_authorized')?'inference':finance.data.proposal?.releaseSha&&finance.data.proposal.releaseSha!==sha&&!handoff?'handoff':'dispatch';
 if(receipts.some(r=>r.event===eventFor(action)))return reply({state:'decision_recorded_no_retry',receipts,noAutomaticRetry:true});
 const {offer}=await quote(sha,action,finance?.data.result?.approvalId,handoff);
 return reply({state:offer.ready?'pending':'blocked',action,...offer,receipts,noAutomaticRetry:true});
 }catch{return reply({state:'blocked',error:'Authenticated WIP, unchanged accounting and current pricing required'},409);}
}
export async function POST(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Authenticated original owner required'},403);
 const sha=release(),owner=process.env.KATIE_OWNER_AUTH_USER_ID;if(!sha||!owner)return reply({error:'Production authority unavailable'},503);
 let decision:z.infer<typeof input>;try{decision=input.parse(await request.json());}catch{return reply({error:'Exact separate owner decision required'},400);}
 try{
 const receipts=await state(),finance=receipts.find(r=>r.event==='task4a_verifier_owner_authorized');
 if(receipts.some(r=>r.event===eventFor(decision.action)||r.event==='task4a_verifier_execution_claimed'))return reply({error:'Decision already recorded; no retry'},409);
 if(decision.action!=='authority'&&!finance)return reply({error:'Unused-capacity transfer and deadline decision required first'},409);
 if(decision.action==='dispatch'&&['task4a_verifier_execution_authorized','task4a_verifier_inference_authorized'].some(e=>!receipts.some(r=>r.event===e)))return reply({error:'Separate replacement and paid inference decisions required'},409);
 const handoff=receipts.find(r=>r.event==='task4a_verifier_release_handoff_authorized');
 if(decision.action==='dispatch'&&finance?.data.proposal?.releaseSha!==sha&&!handoff)return reply({error:'Separate release handoff required'},409);
 const {offer,checkpoint,releaseEvidence}=await quote(sha,decision.action,finance?.data.result?.approvalId,handoff);
 if(!offer.ready||offer.digest!==decision.digest||offer.proposal?.ownerId!==owner)return reply({error:'Evidence or consent changed'},409);
 if(await qualifiedOrdinaryDevelopmentRelease()!==sha)return reply({error:'Qualified release differs from production'},409);
 const r=await getSupabaseAdminClient().rpc<{authorized:boolean;newPaidCalls:number}>(decision.action==='handoff'?'task4a_verifier_handoff_authorize':decision.action==='authority'?'task4a_verifier_authorize':'task4a_verifier_execution_authorize',{
 p_owner:owner,p_digest:decision.digest,p_release:sha,...(decision.action==='handoff'?{p_evidence:releaseEvidence}:decision.action==='authority'?{p_checkpoint:checkpoint}:{p_action:decision.action})});
 if(r.error||r.data?.authorized!==true||r.data.newPaidCalls!==0)return reply({error:'Owner decision could not be confirmed; reconcile without retry'},409);
 if(decision.action!=='dispatch')return reply({accepted:true,result:r.data,dispatched:false});
 let dispatchAccepted=false;try{dispatchAccepted=await dispatchTask4aVerifierOnce();}catch{/* Keep uncertain claim consumed. */}
 return reply({accepted:true,result:r.data,dispatchAccepted,noAutomaticRetry:true});
 }catch{return reply({error:'Successor evidence unavailable; no authority inferred'},409);}
}

import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {authenticatedLifecycleCheckpoint,qualifiedOrdinaryDevelopmentRelease} from '@/lib/agents/development';
export const runtime='nodejs';
const PROJECT='6d1c29f1-b31e-47a5-aabb-cbcf1326f388',TASK='d0e41ff5-149e-4319-9e65-dcc605fb75da';
const CHAT='e53defeb-16eb-457e-aa07-435141165ee8';
const input=z.object({action:z.literal('approveCapacityOnly'),confirm:z.literal(true),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
const release=()=>process.env.VERCEL_ENV==='production'&&/^[a-f0-9]{40}$/.test(process.env.VERCEL_GIT_COMMIT_SHA??'')?process.env.VERCEL_GIT_COMMIT_SHA!:null;
type Offer={ready:boolean;reason?:string;digest?:string;proposal?:{ownerId:string}};
async function receipt(){
 const r=await getSupabaseAdminClient().from('project_events').select('data').eq('project_id',PROJECT)
  .eq('event','task4a_capacity_owner_authorized').maybeSingle<{data:{ownerId:string;consentDigest:string;proposal:{releaseSha:string;checkpoint:unknown};result:unknown}}>();
 if(r.error)throw Error('Capacity receipt unavailable');
 return r.data?.data;
}
async function quote(sha:string){
 const e=await authenticatedLifecycleCheckpoint(TASK);
 if(e.record.checkpointSha!=='2667a81d4f18452e9ca59498c8805670b04cfe47'||e.checkpoint.releaseSha!=='3c148a4ea9a2f8bee9d35b7e430eee0f66ff58a0')throw Error('Latest checkpoint changed');
 const r=await getSupabaseAdminClient().rpc<Offer>('task4a_capacity_proposal',{p_release:sha,p_checkpoint:e.checkpoint});
 if(r.error||!r.data)throw Error('Capacity evidence unavailable');
 return {offer:r.data,checkpoint:e.checkpoint};
}
export async function GET(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Original owner sign-in required'},401);
 if(new URL(request.url).searchParams.get('chatId')!==CHAT)return reply({state:'not_for_this_chat'});
 const sha=release();if(!sha)return reply({error:'Production release unavailable'},503);
 try{
  const saved=await receipt();
  if(saved)return reply({state:'capacity_authorized_execution_blocked',...saved});
  const {offer}=await quote(sha);
  return reply({state:offer.ready?'pending_capacity_only':'blocked',...offer});
 }catch{return reply({state:'evidence_required',error:'Latest checkpoint and reconciled accounting required'},409);}
}
export async function POST(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Authenticated original owner required'},403);
 const sha=release(),owner=process.env.KATIE_OWNER_AUTH_USER_ID;
 if(!sha||!owner)return reply({error:'Production authority unavailable'},503);
 let decision:z.infer<typeof input>;
 try{decision=input.parse(await request.json());}catch{return reply({error:'Exact capacity-only decision required'},400);}
 try{
  const saved=await receipt();
  if(saved){
   if(saved.ownerId!==owner||saved.consentDigest!==decision.digest)return reply({error:'Capacity decision already committed'},409);
   return reply({state:'capacity_authorized_execution_blocked',result:saved.result});
  }
  const {offer,checkpoint}=await quote(sha);
  if(!offer.ready||offer.digest!==decision.digest||offer.proposal?.ownerId!==owner)return reply({error:'Capacity evidence changed'},409);
  if(await qualifiedOrdinaryDevelopmentRelease()!==sha)return reply({error:'Qualified release differs from production'},409);
  const r=await getSupabaseAdminClient().rpc<{authorized:boolean;dispatchAuthorized:boolean;paidInferenceAuthorized:boolean;newPaidCalls:number}>(
   'task4a_capacity_authorize',{p_owner:owner,p_digest:decision.digest,p_release:sha,p_checkpoint:checkpoint});
  if(r.error||!r.data?.authorized||r.data.dispatchAuthorized!==false||r.data.paidInferenceAuthorized!==false||r.data.newPaidCalls!==0)
   return reply({error:'Capacity consent could not be confirmed; refresh before retrying'},409);
  return reply({state:'capacity_authorized_execution_blocked',result:r.data});
 }catch{return reply({error:'Capacity evidence unavailable. No execution authority inferred.'},409);}
}

import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {authenticatedTask4aReplacementCheckpoint,qualifiedOrdinaryDevelopmentRelease,dispatchTask4aReplacementOnce} from '@/lib/agents/development';

export const runtime='nodejs';
const PROJECT='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const CHAT='e53defeb-16eb-457e-aa07-435141165ee8';
const action=z.object({action:z.literal('approveReplacement'),confirm:z.literal(true),
 digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type Offer={ready:boolean;reason?:string;digest?:string;proposal?:Record<string,unknown>};
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
const release=()=>process.env.VERCEL_ENV==='production'&&/^[a-f0-9]{40}$/.test(process.env.VERCEL_GIT_COMMIT_SHA??'')
 ?process.env.VERCEL_GIT_COMMIT_SHA!:null;
async function state(){
 const {data,error}=await getSupabaseAdminClient().from('project_events').select('id,event,data')
  .eq('project_id',PROJECT).in('event',['task4a_replacement_authorized','task4a_replacement_claimed','task4a_replacement_submitted'])
  .returns<{id:string;event:string;data:Record<string,unknown>}>();
 if(error||!data)throw Error('Replacement audit unavailable');
 return {authorized:data.find(e=>e.event==='task4a_replacement_authorized'),
  claimed:data.find(e=>e.event==='task4a_replacement_claimed'),submitted:data.find(e=>e.event==='task4a_replacement_submitted')};
}
async function quote(sha:string){
 const verified=await authenticatedTask4aReplacementCheckpoint();
 const {data,error}=await getSupabaseAdminClient().rpc<Offer>('task4a_replacement_proposal',
  {p_release:sha,p_evidence:verified.evidence});
 if(error||!data)throw Error('Exact replacement proposal unavailable');
 return {offer:data,evidence:verified.evidence};
}
export async function GET(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Original owner sign-in required'},401);
 if(new URL(request.url).searchParams.get('chatId')!==CHAT)return reply({state:'not_for_this_chat'});
 const sha=release();if(!sha)return reply({error:'Qualified production release unavailable'},503);
 try{
  const saved=await state();
  if(saved.authorized)return reply({state:saved.claimed?'claimed_once':'authorized_pending_dispatch',
   authorizationId:saved.authorized.id,claimId:saved.claimed?.id,submittedId:saved.submitted?.id,noAutomaticRetry:true});
  const {offer}=await quote(sha);
  return reply({state:offer.ready?'pending_replacement':'blocked',...offer,noAutomaticRetry:true});
 }catch{return reply({state:'evidence_required',error:'Both workflow proofs, the original WIP and unchanged ledger are required.'},409);}
}
export async function POST(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Authenticated original owner required'},403);
 const sha=release();if(!sha)return reply({error:'Qualified production release unavailable'},503);
 let decision:z.infer<typeof action>;
 try{decision=action.parse(await request.json());}catch{return reply({error:'Exact replacement decision required'},400);}
 try{
  const saved=await state();
  if(saved.authorized||saved.claimed)return reply({error:'Replacement decision already consumed; no retry'},409);
  const {offer,evidence}=await quote(sha);
  const owner=process.env.KATIE_OWNER_AUTH_USER_ID;
  if(!owner||!offer.ready||offer.digest!==decision.digest||offer.proposal?.ownerId!==owner)
   return reply({error:'Replacement evidence or consent is stale'},409);
  if(await qualifiedOrdinaryDevelopmentRelease()!==sha)return reply({error:'Executor release differs from production main'},409);
  const {data,error}=await getSupabaseAdminClient().rpc<{
   authorized:boolean;receiptId:string;dispatched:boolean;newPaidCalls:number;newFinancialAuthority:boolean
  }>('task4a_replacement_authorize',{p_owner:owner,p_digest:decision.digest,p_release:sha,p_evidence:evidence});
  if(error||data?.authorized!==true||data.dispatched!==false||data.newPaidCalls!==0||data.newFinancialAuthority!==false)
   return reply({error:'Atomic replacement owner decision rejected'},409);
  let dispatchAccepted=false;
  try{dispatchAccepted=await dispatchTask4aReplacementOnce();}catch{/* Retain consumed claim on uncertain acceptance. */}
  return reply({accepted:true,authorizationId:data.receiptId,dispatchAccepted,noAutomaticRetry:true,
   originalIssue:969,newFinancialAuthority:false,
   dispatchStatus:dispatchAccepted?'one_replacement_accepted':'reconcile_without_retry'});
 }catch{return reply({error:'Authoritative replacement evidence changed. No consent inferred.'},409);}
}

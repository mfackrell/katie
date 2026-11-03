import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';

export const runtime='nodejs';
const ORIGINAL='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const limits=z.object({
 tokens:z.number().int().positive().safe(),
 calls:z.number().int().positive().safe(),
 dollarsCents:z.number().int().min(1).max(10000).safe(),
 assessmentTokens:z.number().int().nonnegative().safe(),
 completionTokens:z.number().int().nonnegative().safe(),
 assessmentCalls:z.number().int().nonnegative().safe(),
 completionCalls:z.number().int().nonnegative().safe(),
 seconds:z.number().int().min(300).max(172800).safe(),
 models:z.array(z.enum(['openai:gpt-5.3-codex','openai:gpt-5.6-sol'])).min(1).max(2)
}).strict();
const decision=z.discriminatedUnion('action',[
 z.object({action:z.literal('propose'),limits}).strict(),
 z.object({action:z.literal('approve'),limits,digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
]);
type Proposal={ready?:boolean;reason?:string;ledger?:Record<string,unknown>;digest?:string;proposal?:Record<string,unknown>};
const reply=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
function params(l:z.infer<typeof limits>){
 return {p_tokens:l.tokens,p_calls:l.calls,p_money:l.dollarsCents*10000,
  p_assess_tokens:l.assessmentTokens,p_complete_tokens:l.completionTokens,
  p_assess_calls:l.assessmentCalls,p_complete_calls:l.completionCalls,
  p_seconds:l.seconds,p_models:l.models};
}
export async function GET(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Original owner sign-in required'},401);
 const {data,error}=await getSupabaseAdminClient().rpc<Proposal>('task4a_successor_proposal',{
  p_tokens:0,p_calls:0,p_money:0,p_assess_tokens:0,p_complete_tokens:0,
  p_assess_calls:0,p_complete_calls:0,p_seconds:0,p_models:[]
 });
 if(error)return reply({error:'Successor-continuation qualification unavailable'},503);
 return reply({projectId:ORIGINAL,readiness:data,noAuthorityCreated:true});
}
export async function POST(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Authenticated owner consent required'},403);
 let input:z.infer<typeof decision>;
 try{input=decision.parse(await request.json());}
 catch{return reply({error:'Exact owner limits and affirmative digest consent required'},400);}
 const db=getSupabaseAdminClient(),args=params(input.limits);
 const {data:offer,error}=await db.rpc<Proposal>('task4a_successor_proposal',args);
 if(error)return reply({error:'Successor financial qualification failed'},503);
 if(!offer||offer.ready!==true||!offer.digest)
  return reply({ready:false,reason:offer?.reason??'Current source or financial state not eligible',
   ledger:offer?.ledger},409);
 if(input.action==='propose')
  return reply({ready:true,digest:offer.digest,proposal:offer.proposal,
   originalProjectId:ORIGINAL,ownerConsentNotYetGranted:true,
   nativeConsentSeparate:true});
 if(input.digest!==offer.digest)return reply({error:'Stale or mismatched exact proposal; preview again'},409);
 const {data:project,error:projectError}=await db.from('work_projects')
  .select('actor_id,chat_id').eq('id',ORIGINAL)
  .maybeSingle<{actor_id:string;chat_id:string}>();
 if(projectError||!project)return reply({error:'Original owner binding unavailable'},409);
 const {data:owner,error:ownerError}=await db.rpc<string|null>('task4a_original_owner_id',{
  p_actor:project.actor_id,p_chat:project.chat_id
 });
 if(ownerError||!owner)return reply({error:'Original owner identity not verified'},403);
 const {data:receipt,error:commitError}=await db.rpc<{authorized:boolean;authorizationId:string;receiptId:string}>(
  'task4a_authorize_successor',{p_owner:owner,p_digest:input.digest,...args}
 );
 if(commitError||receipt?.authorized!==true)
  return reply({error:'Atomic successor approval rejected; no authority may be assumed'},409);
 return reply({accepted:true,authorizationId:receipt.authorizationId,
  receiptId:receipt.receiptId,originalProjectId:ORIGINAL,
  noPaidCall:true,originalTaskStillBlocked:true,requiresSeparateNativeOwnerConsent:true});
}

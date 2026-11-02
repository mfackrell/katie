import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';

export const runtime='nodejs';
const original='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const approval=z.object({
 approve:z.literal(true),
 proposalDigest:z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const reply=(payload:unknown,status=200)=>NextResponse.json(payload,{status,headers:{'Cache-Control':'private, no-store'}});

// Exact original project only. An authenticated owner is necessary for even
// the read-only budget proposal; this endpoint cannot create new projects.
export async function GET(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))
  return reply({error:'Katie owner sign-in required to view continuation authorization.'},401);
 try{
  const db=getSupabaseAdminClient();
  const {data:project,error:projectError}=await db.from('work_projects')
   .select('id,status,phase,actor_id,chat_id,active_mission_id')
   .eq('id',original).maybeSingle();
  if(projectError||!project)return reply({error:'Original project unavailable.'},404);
  const {data:proposal,error}=await db.rpc('task4a_continuation_proposal',{p_id:original});
  if(error)return reply({error:'Task 4A financial qualification is not deployed or cannot be verified.'},503);
  return reply({projectId:original,chatId:project.chat_id,status:project.status,
   phase:project.phase,originalMissionId:project.active_mission_id,
   continuation:proposal});
 }catch{return reply({error:'Owner continuation proposal unavailable.'},503)}
}

// A *single*, explicit, authenticated owner approval atomically installs the
// capped continuation and recovers the original expired research. No separate
// project, token reset, silent approval or unreviewed coding is created.
export async function POST(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))
  return reply({error:'Authenticated Katie owner approval required.'},403);
 let input:z.infer<typeof approval>;
 try{input=approval.parse(await request.json());}
 catch{return reply({error:'Exact displayed approval digest and explicit consent required.'},400)}
 try{
  const db=getSupabaseAdminClient();
  const {data:project,error:projectError}=await db.from('work_projects')
   .select('id,status,phase,actor_id,chat_id').eq('id',original).maybeSingle();
  if(projectError||!project||project.status!=='paused'||project.phase!=='research')
   return reply({error:'Original owner-paused project is no longer eligible. No new authorization was created.'},409);
  const {data:current,error:proposalError}=await db.rpc('task4a_continuation_proposal',{p_id:original});
  if(proposalError||!current||current.ready!==true||current.digest!==input.proposalDigest)
   return reply({error:'The financial proposal or verified model prices changed. Refresh before authorizing.'},409);
  const {data:committed,error}=await db.rpc('authorize_task4a_expired_research',{
   p_id:original,p_actor:project.actor_id,p_chat:project.chat_id,
   p_digest:input.proposalDigest
  });
  if(error||committed?.authorized!==true)
   return reply({error:'Atomic original-project continuation was rejected. No new authorization can be assumed.'},409);
  return reply({accepted:true,originalProjectId:original,sourceMissionId:committed.oldMissionId,
   continuationMissionId:committed.newMissionId,authorizationId:committed.authorizationId,
   historicalTokens:committed.originalTokens,historicalCalls:committed.originalCalls,
   authorizedIncrementalTokens:committed.additionalTokens,
   authorizedIncrementalCalls:committed.additionalCalls,
   authorizedIncrementalMicrousd:committed.additionalMicrousd,
   scopeApprovalStillRequired:true});
 }catch{return reply({error:'Owner continuation request failed. Inspect saved status before any retry.'},503)}
}

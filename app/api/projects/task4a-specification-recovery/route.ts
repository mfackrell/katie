import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';
import {baseline} from '@/lib/projects/worker';
import type {Project} from '@/lib/projects/store';
import {
 TASK4A_ORIGINAL_PROJECT,TASK4A_ORIGINAL_CHAT,TASK4A_SPECIFICATION_MISSION,
 prepareTask4aSavedRecovery
} from '@/lib/projects/task4a-saved-specification-recovery';

export const runtime='nodejs';
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
const approval=z.object({confirm:z.literal(true),sourceHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type Job={id:string;job_key:string;role:string;status:string;result:Record<string,unknown>|null};
type Authority={id:string;deadline:string;revoked_at:string|null};
type Mission={id:string;status:string;project_kind:string;result:string|null};

async function preflight(){
 const db=getSupabaseAdminClient();
 const [pRead,mRead,jRead,aRead]=await Promise.all([
  db.from('work_projects').select('*').eq('id',TASK4A_ORIGINAL_PROJECT).maybeSingle<Project>(),
  db.from('agent_missions').select('id,status,project_kind,result')
   .eq('id',TASK4A_SPECIFICATION_MISSION).maybeSingle<Mission>(),
  db.from('mission_assignments').select('id,job_key,role,status,result')
   .eq('mission_id',TASK4A_SPECIFICATION_MISSION).in('job_key',['revision','review_again']).returns<Job>(),
  db.from('project_continuation_authorizations').select('id,deadline,revoked_at')
   .eq('project_id',TASK4A_ORIGINAL_PROJECT).maybeSingle<Authority>()
 ]);
 if(pRead.error||mRead.error||jRead.error||aRead.error)throw Error('Saved recovery evidence is unavailable');
 const p=pRead.data,m=mRead.data,j=jRead.data??[],authority=aRead.data;
 if(!p||p.chat_id!==TASK4A_ORIGINAL_CHAT||p.status!=='failed'||p.phase!=='specification'||
  p.active_mission_id!==TASK4A_SPECIFICATION_MISSION||p.approved_hash!==null||p.spec!==null||
  !m||m.id!==p.active_mission_id||m.status!=='completed'||m.project_kind!=='specification'||
  !authority||authority.revoked_at||Date.parse(authority.deadline)<=Date.now()||
  Date.parse(p.deadline)<=Date.now())
  throw Error('Original failed project or unexpired continuation authority unavailable');
 const revision=j.find(x=>x.id==='08a62aa5-e4c0-49a3-ae9d-ae5b77275a71'&&x.job_key==='revision'&&x.role==='revise'&&x.status==='completed');
 const review=j.find(x=>x.id==='dd46bc5a-50cf-49fe-a8dd-ab36e52d6d73'&&x.job_key==='review_again'&&x.role==='review'&&x.status==='completed');
 if(!revision||!review||typeof revision.result?.text!=='string'||typeof m.result!=='string')
  throw Error('Original revised artifact or independent review unavailable');
 const corrected=prepareTask4aSavedRecovery(revision.result.text,m.result,review.result);
 return {db,p,authority,corrected};
}

// No state changes on GET. The owner sees the exact saved-source identity.
export async function GET(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Katie owner sign-in required'},401);
 try{
  const {data:prior,error:priorError}=await getSupabaseAdminClient().from('project_events')
   .select('id').eq('project_id',TASK4A_ORIGINAL_PROJECT)
   .eq('event','task4a_saved_specification_recovered').limit(1);
  if(priorError)return reply({error:'Saved recovery receipt cannot be verified'},503);
  if(prior?.length)return reply({recovered:true,scopeApprovalStillRequired:true});
  const {p,authority,corrected}=await preflight();
  return reply({ready:true,projectId:p.id,chatId:p.chat_id,
   sourceHash:corrected.sourceHash,correctedHash:corrected.correctedHash,
   existingAuthorityExpiresAt:authority.deadline,
   correction:{before:'/project-pilots/task4a-preview-probe/',after:'app/project-pilots/task4a-preview-probe/'},
   scopeApprovalStillRequired:true,willDispatchDevelopment:false});
 }catch(e){return reply({ready:false,error:e instanceof Error?e.message:'Saved recovery unavailable'},409);}
}

// An owner-authenticated nonbillable repair is NOT scope or spending consent.
// One serializable DB operation rechecks all original evidence before transition.
export async function POST(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Authenticated Katie owner session required'},403);
 const raw=await request.json().catch(()=>null);
 const parsed=approval.safeParse(raw);
 if(!parsed.success)return reply({error:'Explicit repair confirmation and exact source hash required'},400);
 try{
  const {db,p,corrected}=await preflight();
  if(parsed.data.sourceHash!==corrected.sourceHash)return reply({error:'Saved source changed; refresh recovery proposal'},409);
  const base=await baseline(p);
  if(!base||!(/^[a-f0-9]{40}$/.test(base)))return reply({error:'Verified GitHub main-branch baseline unavailable'},409);
  const {data,error}=await db.rpc<{recovered:boolean;receiptId:string;scopeHash:string;status:string}>(
    'recover_task4a_reviewed_specification',{
     p_actor:p.actor_id,p_chat:p.chat_id,
     p_source_hash:corrected.sourceHash,p_review_hash:corrected.reviewHash,
     p_corrected:corrected.corrected,p_corrected_hash:corrected.correctedHash,
     p_baseline_sha:base
    });
  if(error||data?.recovered!==true)return reply({error:'Atomic saved-specification recovery rejected; verify current state before retry'},409);
  return reply({recovered:true,receiptId:data.receiptId,projectId:p.id,
   scopeHash:data.scopeHash,correctedHash:corrected.correctedHash,
   status:data.status,scopeApprovalStillRequired:true,
   developmentDispatched:false,spendingAuthorized:false});
 }catch(e){return reply({error:e instanceof Error?e.message:'Saved-specification recovery unavailable'},409);}
}

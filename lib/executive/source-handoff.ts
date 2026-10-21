import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
export const EXECUTIVE_SOURCE_MARKER='\nExecutive source handoff: use the verified source reports supplied in projectEvidence.executiveSources.';
export async function executiveSourceReports(input:{actorId:string;chatId:string;missionIds:string[]}){
 const ids=[...new Set(input.missionIds)];
 if(!ids.length||ids.length>8||ids.length!==input.missionIds.length||ids.some(id=>!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)))throw Error('Invalid Executive source mission binding');
 const db=getSupabaseAdminClient();
 const {data:links,error:linkError}=await db.from('executive_delegations').select('mission_id').eq('actor_id',input.actorId).eq('chat_id',input.chatId).in('mission_id',ids).returns<{mission_id:string}>();
 if(linkError||ids.some(id=>!links?.some(d=>d.mission_id===id)))throw Error('Executive source outside the owning conversation');
 const [missions,reviews]=await Promise.all([
  db.from('agent_missions').select('id,objective,status,result,updated_at').in('id',ids).returns<{id:string;objective:string;status:string;result:string|null;updated_at:string}>(),
  db.from('mission_assignments').select('id,mission_id,job_key,status,result').in('mission_id',ids).eq('role','review').returns<{id:string;mission_id:string;job_key:string;status:string;result:{verdict?:string}|null}>()
 ]);
 if(missions.error||reviews.error)throw Error('Executive source review evidence unavailable');
 return ids.map(id=>{
  const mission=missions.data?.find(m=>m.id===id),rows=reviews.data?.filter(r=>r.mission_id===id);
  const review=rows?.find(r=>r.job_key==='review_again')??rows?.find(r=>r.job_key==='review');
  if(mission?.status!=='completed'||!mission.result?.trim()||review?.status!=='completed'||review.result?.verdict!=='pass')throw Error('Executive source requires a completed independently reviewed report');
  return{missionId:id,objective:mission.objective,report:mission.result,reviewJobId:review.id,reviewVerdict:'pass',observedUpdatedAt:mission.updated_at};
 });
}
export async function sourceReportsForMission(missionId:string){
 const {data:binding,error}=await getSupabaseAdminClient().from('executive_delegations').select('actor_id,chat_id,result').eq('mission_id',missionId).maybeSingle<{actor_id:string;chat_id:string;result:{sourceMissionIds?:string[]}|null}>();
 if(error||!binding?.result?.sourceMissionIds)throw Error('Durable Executive source handoff unavailable');
 return executiveSourceReports({actorId:binding.actor_id,chatId:binding.chat_id,missionIds:binding.result.sourceMissionIds});
}

import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {readMission} from '@/lib/missions/store';
import {recordAndReconcileSpecialistEstimate} from './specialist-estimate-handoff';

// At most one newly admitted specialist mission per worker tick.
// Existing project authorization and database mission reservations remain binding.
export async function runSpecialistResourceBatch(){
 const db=getSupabaseAdminClient();
 const {data:dispatched,error:dispatchError}=await db.rpc<Record<string,string>|null>('dispatch_specialist_resource_estimate',{});
 if(dispatchError)throw Error('Specialist resource dispatch unavailable: '+dispatchError.message.slice(0,150));
 const {data:rows,error}=await db.from('project_specialist_dispatches')
   .select('project_id,scope_hash,package_id,specialist,mission_id,status')
   .eq('status','dispatched').limit(10);
 if(error)throw Error('Specialist handoff index unavailable');
 let completed=0,blocked=0;
 for(const entry of (rows??[]) as Array<{project_id:string;scope_hash:string;package_id:string;specialist:string;mission_id:string;status:string}>){
  const {mission}=await readMission(entry.mission_id);
  if(mission.status==='blocked'||mission.status==='stopped'){
   const {error:markError}=await db.from('project_specialist_dispatches')
     .eq('project_id',entry.project_id).eq('scope_hash',entry.scope_hash)
     .eq('package_id',entry.package_id).eq('status','dispatched')
     .update({status:'blocked',updated_at:new Date().toISOString()});
   if(markError)throw Error('Cannot preserve blocked specialist state');
   blocked++;
   continue;
  }
  if(mission.status!=='completed')continue;
  const {data:projects,error:projectError}=await db.from('work_projects')
    .select('estimate_rationale,approval_hash').eq('id',entry.project_id).limit(1);
  if(projectError)throw Error('Project resource baseline unavailable');
  const p=(projects??[])[0] as {estimate_rationale:string;approval_hash:string}|undefined;
  if(!p||p.approval_hash!==entry.scope_hash)continue; // Superseded contract; no stale budget update.
  let scope:Record<string,unknown>;
  try{scope=JSON.parse(p.estimate_rationale);}catch{throw Error('Saved project forecast invalid');}
  if(!scope.workPackages||!scope.totals)throw Error('Scoped work packages unavailable');
  const revised=await recordAndReconcileSpecialistEstimate({
   projectId:entry.project_id,missionId:entry.mission_id,specialist:entry.specialist,
   scopeHash:entry.scope_hash,
   scopeForecast:scope as {workPackages:Array<{id:string}>;totals:{expectedTokens:number}}
  });
  if(revised){
   // Compare-and-swap prevents stale results overriding concurrent project updates.
   const updated={...scope,specialistPlan:revised};
   const {error:updateError}=await db.from('work_projects')
     .eq('id',entry.project_id).eq('approval_hash',entry.scope_hash)
     .eq('estimate_rationale',p.estimate_rationale)
     .update({estimate_rationale:JSON.stringify(updated),estimate_updated_at:new Date().toISOString()});
   if(updateError)throw Error('Consolidated specialist forecast persistence failed');
  }
  const {error:markError}=await db.from('project_specialist_dispatches')
   .eq('project_id',entry.project_id).eq('scope_hash',entry.scope_hash)
   .eq('package_id',entry.package_id).eq('status','dispatched')
   .update({status:'completed',updated_at:new Date().toISOString()});
  if(markError)throw Error('Specialist completion receipt unavailable');
  completed++;
 }
 return {admitted:dispatched?.missionId??null,completed,blocked};
}

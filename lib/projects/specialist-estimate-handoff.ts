import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {readMission} from '@/lib/missions/store';
import {reconcileSpecialistEstimates} from './specialist-resource-plan.mjs';

// Called only when a specialist mission has completed its normal independent
// review. Never accept estimates that originated with a provisional baseline.
export async function recordAndReconcileSpecialistEstimate(input:{
 projectId:string;missionId:string;specialist:string;scopeHash:string;packageId?:string;
 scopeForecast:{workPackages:Array<{id:string}>;totals:{expectedTokens:number}};
}){
 const {mission,jobs}=await readMission(input.missionId);
 if(mission.project_id!==input.projectId||mission.status!=='completed'||
  !jobs.some(j=>j.role==='review'&&j.status==='completed')||
  typeof mission.result!=='string')throw Error('A completed independently reviewed specialist mission is required');
 let parsed:unknown;
 try{parsed=JSON.parse(mission.result);}catch{throw Error('Specialist estimate is not structured JSON');}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Invalid specialist estimate');
 const body=parsed as Record<string,unknown>;
 const packages=body.packages;
 if(!Array.isArray(packages)||body.specialist!==input.specialist||
    body.scopeHash!==input.scopeHash)throw Error('Specialist submission identity and scope mismatch');
 if(input.packageId&&(packages.length!==1||!packages[0]||packages[0].packageId!==input.packageId))throw Error('Specialist estimate must match its single assigned package');
 const proposal={specialist:input.specialist,origin:'specialist_verified',packages};
 // Do not authorize a call or spending because the forecast changed.
 const db=getSupabaseAdminClient();
 const {data:written,error:writeError}=await db.rpc<boolean>('record_reviewed_specialist_estimate',{
  p_project:input.projectId,p_mission:input.missionId,p_specialist:input.specialist,
  p_scope_hash:input.scopeHash,p_estimate:proposal
 });
 if(writeError||!written)throw Error('Failed to save independently reviewed specialist estimate');
 const {data:rows,error}=await db.from('project_specialist_estimates').select('estimate')
  .eq('project_id',input.projectId).eq('scope_hash',input.scopeHash);
 if(error)throw Error('Specialist estimation records unavailable');
 const submissions=(rows??[]).map((row:unknown)=>{if(!row||typeof row!=='object'||!('estimate' in row))throw Error('Invalid specialist estimate record');return (row as {estimate:unknown}).estimate;});
 try{return reconcileSpecialistEstimates(input.scopeForecast,submissions);}
 catch{return null;} // Other specialists have not yet delivered; never use provisional as reviewed.
}

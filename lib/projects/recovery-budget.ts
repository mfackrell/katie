import {createHash} from 'node:crypto';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {estimateProjectResources} from './resource-forecast.mjs';
import {validateProjectPlan} from './contract';
import type {Project} from './store';

type Usage={actual_tokens:number|null;reserved_tokens:number|null;project_kind:string};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
export async function recoveryResourceProposal(p:Project) {
 if(p.status!=='blocked'||p.phase!=='specification'||p.approved_hash) return null;
 const db=getSupabaseAdminClient();
 const {data:missions,error:me}=await db.from('agent_missions').select('actual_tokens,reserved_tokens,project_kind').eq('project_id',p.id).returns<Usage>();
 if(me)throw Error('Cannot read historical resource usage');
 const used=(missions??[]).reduce((sum,m)=>sum+Math.max(m.actual_tokens??0,m.reserved_tokens??0),0);
 const {data:drafts,error:de}=await db.from('project_runs').select('mission_id').eq('project_id',p.id).eq('kind','specification').order('created_at',{ascending:false}).limit(10).returns<Array<{mission_id:string}>>();
 if(de)throw Error('Cannot read saved specification lineage');
 let spec=p.spec;
 if(!spec) for(const run of drafts??[]){
   const {data:jobs,error:je}=await db.from('mission_assignments').select('result').eq('mission_id',run.mission_id).eq('role','compose').eq('status','completed').limit(1).returns<Array<{result:{text?:string}}>>();
   if(je)throw Error('Cannot read saved composition');
   try {if(jobs?.[0]?.result?.text){spec=validateProjectPlan(JSON.parse(jobs[0].result.text));break;}}catch{/* a rejected draft is not approved scope */}
 }
 // The developer must not invent a financial estimate from an invalid specification.
 if(!spec)return {state:'needs_specialist_estimate' as const,used,authorized:p.token_allowance,remaining:Math.max(0,p.token_allowance-used),reason:'No validated, source-grounded specification for resource planning'};
 const forecast=estimateProjectResources(spec,p.objective+' '+p.clarifications);
 // Forecast remaining scope independently; prior usage is not an estimate of future cost.
 const pending=forecast.totals.upperTokens;
 const expected=forecast.totals.expectedTokens;
 const ceiling=Math.ceil((used+pending)/1000)*1000;
 const scopeHash=hash(JSON.stringify({projectId:p.id,missionId:p.active_mission_id,used,authorized:p.token_allowance,scope:spec,forecast:forecast.totals}));
 const needsAuthorization=ceiling>p.token_allowance || new Date(p.deadline).getTime()<=Date.now()+30*60*1000 || (missions?.length??0)>=p.max_missions-1;
 return {state:'estimated' as const,used,authorized:p.token_allowance,remaining:Math.max(0,p.token_allowance-used),expectedAdditional:expected,upperAdditional:pending,proposedCeiling:Math.max(p.token_allowance,ceiling),priorMissionCount:missions?.length??0,proposedMaxMissions:Math.max(p.max_missions,(missions?.length??0)+Math.max(3,spec.milestones.length*2+2)),forecast,scopeHash,needsAuthorization,authorizationSource:p.budget_authorization_source??'legacy_default'};
}

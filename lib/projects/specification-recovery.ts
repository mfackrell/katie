import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {canonical,digest,gameSpecificationView,validateProjectPlan} from './contract';
import {parseJSON} from '@/lib/missions/types';

// Hard stage ceilings, not permission to spend or predicted actual usage.
// Native token counting and the existing fenced reservations remain authoritative.
export const SPECIFICATION_STAGE_TOKENS={compose:30000,review:24000,revision:40000,review_again:24000,routing:2000} as const;
export function specificationMissionTokens(recovered:boolean){
 return (recovered?0:SPECIFICATION_STAGE_TOKENS.compose)+SPECIFICATION_STAGE_TOKENS.review+
  SPECIFICATION_STAGE_TOKENS.revision+SPECIFICATION_STAGE_TOKENS.review_again+SPECIFICATION_STAGE_TOKENS.routing;
}
export function specificationProjectAdmission(recovered:boolean,milestones=1){
 const missionTokens=specificationMissionTokens(recovered);
 // Existing project child ceiling for each remaining development milestone and
 // whole-project assessment. This is headroom, not an additional charge/grant.
 const futureMissions=milestones+1;
 return {missionTokens,futureMissions,futureTokens:futureMissions*120000,
  requiredTokens:missionTokens+futureMissions*120000,requiredMissionSlots:futureMissions+1};
}
export type SpecificationJob={id:string;mission_id:string;job_key:string;role:string;status:string;dependencies?:string[];created_at:string;updated_at:string;result:Record<string,unknown>|null};
// Only a changed candidate or authoritative user scope permits another recovery.
// Reviewer wording, copied job IDs and transport diagnostics cannot reopen it.
export function specificationRecoveryKey(sourceHash:string,objective:string,clarifications:string){
 return digest({sourceHash,objective,clarifications:clarifications??''});
}
export function specificationFindings(result:Record<string,unknown>|null){
 if(!result)return null;
 const findings=Array.isArray(result.findings)?result.findings:typeof result.findings==='string'?[result.findings]:[];
 const duplicateSummary=typeof result.summary==='string'&&result.summary===findings.join('\n');
 return {verdict:result.verdict,...(!duplicateSummary?{summary:result.summary}:{}),findings,clarification:result.clarification,
  failedChecks:Array.isArray(result.checks)?result.checks.filter((c:Record<string,unknown>)=>c.passed!==true):[]};
}
/** Select by artifact completion, never a stale recovery-event pointer. A later
 * invalid draft remains evidence; it is not permission for blank generation. */
export function selectSpecificationRecovery(jobs:SpecificationJob[],originalRequirements:string){
 const ordered=[...jobs].sort((a,b)=>Date.parse(b.updated_at)-Date.parse(a.updated_at)||Date.parse(b.created_at)-Date.parse(a.created_at)||b.id.localeCompare(a.id));
 const diagnostics:Array<{sourceJobId:string;detail:string}>=[];
 let selected:{job:SpecificationJob;plan:ReturnType<typeof validateProjectPlan>}|undefined;
 for(const job of ordered.filter(j=>j.status==='completed'&&['compose','revise'].includes(j.role))){
  if(typeof job.result?.text!=='string')continue;
  try{selected={job,plan:validateProjectPlan(parseJSON(job.result.text))};break;}
  catch(error){diagnostics.push({sourceJobId:job.id,detail:error instanceof Error?error.message:String(error)});}
 }
 if(!selected){
  const hasPriorDraft=ordered.some(j=>['compose','revise'].includes(j.role)&&
   (typeof j.result?.text==='string'||typeof j.result?.rejectedSpecification==='string'));
  return {checkpoint:null,priorReviews:[],diagnostics,hasPriorDraft,fingerprint:null};
 }
 const {job,plan}=selected;
 // Preserve substantive findings, not duplicated blind criteria/passing checks.
 // Pass receipts are retained too: only a fresh exact-candidate review can close.
 const priorReviews=ordered.filter(j=>j.role==='review'&&j.status==='completed'&&j.result)
  .map(j=>({sourceJobId:j.id,sourceMissionId:j.mission_id,...specificationFindings(j.result)}));
 const findings=[...new Map(priorReviews.map(r=>{const {sourceJobId,sourceMissionId,...content}=r;void sourceJobId;void sourceMissionId;return[canonical(content),content];})).values()];
 const fingerprint=digest({candidate:plan,originalRequirements,findings,diagnostics:diagnostics.map(d=>d.detail)});
 return {checkpoint:{sourceJobId:job.id,sourceMissionId:job.mission_id,text:job.result!.text as string,
   fullSpecificationHash:digest(plan),status:'unreviewed' as const,
   instruction:'Reuse this exact saved artifact. Preserve original requirements and address saved independent findings. Fresh independent review is mandatory; no research or full regeneration is authorized.'},
  priorReviews,diagnostics,hasPriorDraft:true,fingerprint};
}
export async function loadSpecificationRecovery(projectId:string,runs:Array<{kind:string;mission_id:string}>,originalRequirements:string){
 const ids=runs.filter(r=>r.kind==='specification').map(r=>r.mission_id);
 if(!ids.length)return selectSpecificationRecovery([],originalRequirements);
 const {data,error}=await getSupabaseAdminClient().from('mission_assignments')
  .select('id,mission_id,job_key,role,status,dependencies,created_at,updated_at,result')
  .in('mission_id',ids).in('role',['compose','revise','review']).returns<SpecificationJob>();
 if(error)throw Error('Saved specification lineage could not be read; no regeneration authorized');
 return selectSpecificationRecovery(data??[],originalRequirements);
}
/** One candidate per repair request. Duplicate contracts use the canonical
 * lossless view; the complete expanded artifact stays stored and hashed. */
export function specificationCandidateEvidence(result:Record<string,unknown>){
 const plan=validateProjectPlan(parseJSON(String(result.text)));
 return {specification:plan.game?gameSpecificationView(plan):plan,fullSpecificationHash:digest(plan),sources:result.sources,calculations:result.calculations,
  referenceNote:'contractRef and stepsRef resolve losslessly to finalContract. Every original rule, model state, browser step and unique milestone contract is retained; return the full expanded specification.'};
}

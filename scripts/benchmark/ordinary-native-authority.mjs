// Trusted host adapter for ordinary Developer authority. No benchmark provenance
// is synthesized; the service snapshot authenticates the original project owner.
export async function readOrdinaryNativeAuthority({db,proof,approval,project,account,task,releaseSha}){
 const deny=()=>{throw Error('ORDINARY_NATIVE_AUTHORITY_DENIED');};
 if(proof.authorityKind!=='ordinary-developer'||approval.developer_authority?.version!=='ordinary-developer-v1'
  ||approval.trial_id!==null||approval.continuation_id!==null||account.arm!=='developer'
  ||account.trial_id!==null||account.experiment_id!==null||account.developer_project_id!==project.id
  ||account.developer_task_id!==task.id||proof.accountId!==account.id||approval.account_id!==account.id||approval.task_id!==task.id
  ||approval.project_id!==project.id||proof.releaseSha!==releaseSha||approval.model!=='gpt-5.3-codex'
  ||approval.consumed_at||approval.revoked_at||account.frozen_at
  ||task.external?.developerApprovalId!==approval.id||task.external?.developerReleaseSha!==releaseSha)deny();
 const result=await db.rpc('benchmark_lifecycle_snapshot',{p_task:task.id});
 const s=result.data;
 if(result.error||!s||s.authorityKind!=='ordinary-developer'||s.snapshot?.approval?.id!==approval.id
  ||s.ownerId!==approval.owner_id||s.accountId!==account.id||s.revoked||s.frozen
  ||s.position.expiresAt<=Date.now()||project.status!=='running'||project.phase!=='development')deny();
 for(const key of ['taskId','projectId','scopeHash','contractHash','baselineSha'])if(s.binding[key]!==proof[key])deny();
 return s;
}

import {assessLifecycleCapacity,STAGES} from './lifecycle-capacity.mjs';
import {capacityProgress} from './native-capacity-forecast.mjs';
export async function readOrdinaryLifecycleCapacity({db,task,project,approval,context,recovery,phase,completedStages=[],notRequiredStages=[],grantId=null,observations=[],now=Date.now()}){
 const binding={taskId:task.id,projectId:project.id,baselineSha:context.baselineSha,scopeHash:project.approved_hash,contractHash:context.contractHash};
 const progress=capacityProgress({binding,recovery,phase,completedStages,notRequiredStages});
 const input={binding,progress,observedAt:now,cohort:binding.scopeHash,work:{repairIterations:progress.completedStages.includes('repair')||progress.notRequiredStages.includes('repair')?0:1,additionalRepairIterations:0},observations:[],pricing:{},
  authorization:{live:!approval.revoked_at&&Date.parse(approval.deadline)>now,deadline:Date.parse(approval.deadline),executionAuthorized:approval.revoked_at?false:null},
  otherApiCostMicrousd:Object.fromEntries(Object.keys(STAGES).map(k=>[k,k==='browser_delivery'?null:'0']))};
 try{
  const {data:s,error}=await db.rpc('benchmark_lifecycle_snapshot',{p_task:task.id});
  if(error||!s||s.authorityKind!=='ordinary-developer'||s.snapshot?.approval?.id!==approval.id||Object.keys(binding).some(k=>s.binding[k]!==binding[k]))throw Error('snapshot unavailable');
  const p=s.position,g=s.snapshot.grants?.find(row=>row.id===grantId);
  input.authorization={source:'locked_ordinary_lifecycle_snapshot',live:!s.revoked&&!s.frozen&&p.expiresAt>now,deadline:p.expiresAt,
   executionAuthorized:grantId?Boolean(g&&g.id===grantId&&g.developer_approval_id===approval.id&&!g.revoked_at&&!g.stopped_at&&Date.parse(g.deadline)>now):null,
   tokens:{cumulativeLimit:p.cumulativeTokens,accountEncumbered:p.accountEncumberedTokens,developmentLimit:p.developmentTokens,developmentEncumbered:p.developmentEncumberedTokens,completionReserveRemaining:p.completionTokens,assessmentReserveRemaining:p.assessmentTokens},
   calls:{developmentLimit:p.developmentCalls,developmentConsumed:p.developmentConsumedCalls,completionReserveRemaining:p.completionCalls,assessmentLimit:p.assessmentCalls,assessmentConsumed:p.assessmentConsumedCalls},
   money:{complete:true,ceilingMicrousd:p.ceilingMicrousd,exposureMicrousd:s.exposureMicrousd}};
  const seen=new Set();
  input.observations=observations.filter(o=>{
   if(!Array.isArray(o.operationIds)||!o.operationIds.length||o.operationIds.length!==o.calls||new Set(o.operationIds).size!==o.calls)return false;
   const rows=o.operationIds.map(id=>s.snapshot.calls?.find(c=>c.id===id));
   if(rows.some(c=>!c||c.state!=='settled'||c.model!==approval.model||!c.provider_usage||seen.has(c.id)))return false;
   if(rows.reduce((n,c)=>n+c.provider_usage.input_tokens,0)!==o.inputTokens||rows.reduce((n,c)=>n+c.provider_usage.output_tokens,0)!==o.outputTokens)return false;
   rows.forEach(c=>seen.add(c.id));return true;
  });
  input.pricing.native=s.pricing;
  return assessLifecycleCapacity(input);
 }catch{
  const result=assessLifecycleCapacity(input);result.uncertainties.push('ordinary_authoritative_snapshot_unavailable');return result;
 }
}

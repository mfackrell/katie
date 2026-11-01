import {freshNativePhaseWork} from './native-phase-profile.mjs';
import {assessLifecycleCapacity,STAGES} from './lifecycle-capacity.mjs';
import {proposeLifecycleAmendment} from '../../lib/projects/lifecycle-authorization.mjs';

// The caller authenticates the durable record using Task 1 before calling this
// adapter. Snapshot comes from the locked service-only accounting RPC.
export function lifecycleProposalFromSnapshot({snapshot,record,observations=[],pricing=snapshot?.pricing??null,now=Date.now()}) {
 const p=snapshot.position,b=snapshot.binding;
 if(!record || record.taskId!==b.taskId || record.projectId!==b.projectId ||
  record.originalBaselineSha!==b.baselineSha || record.approvedScopeHash!==b.scopeHash ||
  record.approvedScope?.contractHash!==b.contractHash)throw Error('Authenticated checkpoint binding differs');
 let completed=record.phase==='repair'?['implementation','initial_review']:
  record.phase==='review'?['implementation']:record.phase==='final-review'?['implementation','initial_review','repair','verification']:
  record.phase==='do_completion'?['implementation','initial_review','repair','verification','final_review']:[];
 const skippedRepair=['final-review','do_completion'].includes(record.phase)&&record.lastCompleted?.repairPerformed!==true&&record.lastCompleted?.lifecycle?.repairPerformed!==true;
 if(skippedRepair)completed=completed.filter(s=>s!=='repair');
 const phase=({'review':'initial_review','final-review':'final_review'})[record.phase]??record.phase;
 const calls=snapshot.snapshot.calls,seen=new Set();
 const verified=observations.filter(o=>{
  if(!Array.isArray(o.operationIds)||o.operationIds.length!==o.calls||new Set(o.operationIds).size!==o.calls)return false;
  const rows=o.operationIds.map(id=>calls.find(c=>c.id===id));
  if(rows.some(c=>!c||c.state!=='settled'||c.model!==snapshot.model||!c.provider_usage||seen.has(c.id)))return false;
  if(rows.reduce((n,c)=>n+c.provider_usage.input_tokens,0)!==o.inputTokens||rows.reduce((n,c)=>n+c.provider_usage.output_tokens,0)!==o.outputTokens)return false;
  rows.forEach(c=>seen.add(c.id));return true;
 });
 // A consumed ordinary approval authorizes one execution grant. Authenticated
 // failed-run recovery cannot issue it again even if resource ceilings have room.
 // Offer explicit owner renewal through the existing transaction, never a grant.
 const priorApproval=snapshot.snapshot.approval,priorTask=snapshot.snapshot.task;
 const needsAttemptAuthority=snapshot.authorityKind==='ordinary-developer'&&
  priorTask?.id===b.taskId&&priorTask.status==='blocked'&&priorTask.external?.receipt?.outcome==='BLOCKED'&&
  String(priorTask.external.receipt.run_id)===String(record.runId)&&
  priorApproval?.id===record.approvalId&&priorApproval.id===snapshot.approvalId&&Boolean(priorApproval.consumed_at)&&
  snapshot.snapshot.grants?.some(g=>g.id===record.grantId&&g.developer_approval_id===priorApproval.id&&g.mission_assignment_id===b.taskId);
 const assessment=assessLifecycleCapacity({binding:b,observedAt:now,cohort:b.scopeHash,
  progress:{source:'authenticated_recovery',binding:b,phase,completedStages:completed,notRequiredStages:skippedRepair?['repair']:[],checkpointSha:record.checkpointSha},
  work:{...freshNativePhaseWork,repairIterations:completed.includes('repair')||skippedRepair?0:1,additionalRepairIterations:0},observations:verified,
  pricing:{native:pricing},otherApiCostMicrousd:Object.fromEntries(Object.keys(STAGES).map(k=>[k,k==='browser_delivery'?null:'0'])),
  authorization:{source:'locked_lifecycle_authority_snapshot',live:!snapshot.revoked&&!snapshot.frozen&&p.expiresAt>now,
   executionAuthorized:needsAttemptAuthority?false:null,deadline:p.expiresAt,
   tokens:{cumulativeLimit:p.cumulativeTokens,accountEncumbered:p.accountEncumberedTokens,developmentLimit:p.developmentTokens,
    developmentEncumbered:p.developmentEncumberedTokens,completionReserveRemaining:p.completionTokens,assessmentReserveRemaining:p.assessmentTokens},
   calls:{developmentLimit:p.developmentCalls,developmentConsumed:p.developmentConsumedCalls,completionReserveRemaining:p.completionCalls,
    assessmentLimit:p.assessmentCalls,assessmentConsumed:p.assessmentConsumedCalls},
   money:{complete:true,ceilingMicrousd:p.ceilingMicrousd,exposureMicrousd:snapshot.exposureMicrousd}}});
 const current={...snapshot,checkpointSha:record.checkpointSha,proposalExpiresAt:now+3600000};
 return {assessment,...proposeLifecycleAmendment({assessment,current,now})};
}

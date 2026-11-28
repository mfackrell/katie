import {isDeepStrictEqual} from 'node:util';
const deny=reason=>{throw Error('NATIVE_PROVIDER_RECOVERY_DENIED: '+reason);};
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const same=(a,b,label)=>{if(!isDeepStrictEqual(a,b))deny(label+' mismatch');};

// Historical evidence only. This does not grant a live dispatch, reopen an
// expired window, change a request ceiling, or attest final review.
export function validateProviderFinalReviewHistory({record,diagnostics,completedEvidence,task,project,context,assignment,run,dispatch,requests,proof}){
 if(!record||record.version!==2||record.kind!=='native-unverified-wip'||record.verification!=='unverified'||record.authorityKind!=='provider-execution'||record.trialId!==null||record.phase!=='final-review'||record.approvalId||record.grantId||record.executionEpoch!==undefined)deny('unsupported checkpoint');
 for(const key of ['checkpointSha','completedCheckpointSha','sourceTreeSha'])if(!sha(record[key]))deny('invalid Git identity');
 const receipt=task.external?.receipt;
 if(receipt?.outcome!=='BLOCKED'||receipt.repository!==task.repository_full_name||receipt.issue_number!==Number(task.external?.issueNumber)||String(receipt.run_id)!==record.runId)deny('missing failed task receipt');
 for(const [actual,expected,label] of [[record.taskId,task.id,'task'],[record.projectId,project.id,'project'],[record.originalBaselineSha,context.baselineSha,'baseline'],[record.baseSha,context.baseSha,'base'],[record.approvedScopeHash,project.approved_hash,'approved scope'],[project.approval_hash,project.approved_hash,'approval'],[record.approvedScope,{hash:project.approved_hash,allowedPaths:context.allowedPaths,contractHash:context.contractHash},'contract'],[proof.priorRunId,record.runId,'prior run'],[proof.checkpointSha,record.checkpointSha,'checkpoint'],[proof.candidateSha,record.completedCheckpointSha,'candidate'],[proof.sourceTreeSha,record.sourceTreeSha,'tree']])same(actual,expected,label);
 if(assignment.id!==task.id||assignment.role!=='development'||run.mission_id!==assignment.mission_id||run.project_id!==project.id||run.kind!=='development'||dispatch.task_id!==task.id||dispatch.run_id!==record.runId)deny('historical assignment or dispatch');
 for(const key of ['projectId','baseSha','baselineSha','allowedPaths','cumulativePaths','contractHash'])same(context[key],run.binding?.[key],'durable '+key);
 same(run.binding?.scopeHash,project.approved_hash,'durable scope');
 same(diagnostics.wipCheckpoint,record,'diagnostic checkpoint');
 if(diagnostics.completed!==false||diagnostics.taskId!==task.id||String(diagnostics.runId)!==record.runId||diagnostics.failure!=='NATIVE_HOST_DENIED: native final-review failed; evidence retained')deny('not a failed final-review run');
 const phases=diagnostics.phases;
 if(!Array.isArray(phases)||phases.length!==3||phases[0]?.phase!=='implementation'||phases[1]?.phase!=='review'||phases[2]?.phase!=='final-review'||phases.slice(0,2).some(p=>p.outcome?.code!==0||p.outcome?.signal!==null||p.terminalEvent!=='turn.completed')||phases[2].outcome?.code===0||phases[2].terminalEvent==='turn.completed')deny('phase completion mismatch');
 const last=completedEvidence,head=record.completedCheckpointSha,a=last?.adaptiveRepair;
 if(last?.checkpointSha!==head||last.phase!=='review'||last.verification?.head!==head||last.verification?.passed!==true||last.verification.pending===true||last.repairPerformed!==false||last.repairVerification!==null||last.reviewRepair!==null||a?.version!==2||a.nextAction!=='final-review'||a.candidateHead!==head||a.iteration!==0||a.pendingRepair!==null)deny('not a verified final-review checkpoint');
 for(const review of [last.initialReview,last.review])if(review?.phase!=='review'||review.verdict!=='pass'||review.reviewedHeadSha!==head||typeof review.findings!=='string'||!review.findings.trim())deny('initial review missing');
 // The admitted operation pairs and exact returned response IDs must match the
 // authenticated diagnostics. No unknown request can be retried or discarded.
 const usage=diagnostics.providerUsage;
 if(!Array.isArray(requests)||requests.length!==24||usage?.responses!==12||!Array.isArray(usage.receipts)||usage.receipts.length!==12)deny('exhausted dispatch evidence missing');
 const seen=new Set(),ids=new Set();
 const ordered=[...requests].sort((a,b)=>Date.parse(a.started_at)-Date.parse(b.started_at));
 let priorEnd=-Infinity,observed=0,unknown=0;
 for(let i=0;i<12;i++){
  const count=ordered[2*i],inference=ordered[2*i+1],response=usage.receipts[i];
  for(const q of [count,inference]){
   const start=Date.parse(q.started_at),end=Date.parse(q.resolved_at);
   if(q.project_id!==project.id||q.mission_id!==assignment.mission_id||q.assignment_id!==task.id||q.worker_id!==assignment.agent_id||q.execution_attempt!==record.runId||!hash(q.request_hash)||typeof q.id!=='string'||ids.has(q.id)||!Number.isFinite(start)||!Number.isFinite(end)||start<priorEnd||end<start)deny('unsettled, foreign or overlapping request');
   ids.add(q.id);priorEnd=end;
  }
  if(count.operation!=='input-count'||count.provider_receipt!=='input-token-count'||inference.operation!=='inference'||count.request_hash!==inference.request_hash||typeof inference.provider_receipt!=='string'||!inference.provider_receipt||seen.has(inference.provider_receipt)||response?.providerRequestId!==inference.provider_receipt)deny('provider receipt mismatch');
  seen.add(inference.provider_receipt);
  if(response.actualTokens===null)unknown++;else if(Number.isSafeInteger(response.actualTokens)&&response.actualTokens>=0)observed+=response.actualTokens;else deny('invalid observed usage');
 }
 if(usage.observedTokens!==observed||usage.unknownUsage!==unknown)deny('usage observation mismatch');
 return last;
}

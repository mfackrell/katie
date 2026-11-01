// Phase control shared by the real host and nonbillable recovery qualification.
// The caller must complete the existing live-authority checks before invoking.
export async function executeNativeDevelopmentLifecycle({recovery,runPhase,commitCandidate,verifyCandidate,qualifiedLifecycle,onCompleted=()=>{}}){
 let candidateHead,verification,first,repairPerformed=false,repairVerification=null;
 if(recovery?.phase==='do_completion')return recovery.lastCompleted.lifecycle;
 if(recovery?.phase==='final-review'){
  const final=await runPhase('final-review','Trusted deterministic verification: '+JSON.stringify(recovery.lastCompleted.verification));
  if(final.verdict!=='pass')throw Error('NATIVE_HOST_DENIED: independent final review requires changes');
  return {candidateHead:recovery.completedCheckpointSha,review:recovery.lastCompleted.review,finalReview:final,repairPerformed:recovery.lastCompleted.repairPerformed===true,repairVerification:null};
 }
 if(recovery?.phase==='repair'){
  candidateHead=recovery.completedCheckpointSha;
  verification=recovery.lastCompleted.verification;
  first=recovery.lastCompleted.review;
  // These are previously completed, independently authenticated decisions.
  // No implementation or initial review request is replayed.
 }else{
  if(recovery?.phase==='review'){
   candidateHead=recovery.completedCheckpointSha;verification=recovery.lastCompleted.verification;
  }else{
   await runPhase('implementation');
   candidateHead=commitCandidate('native: checkpoint approved implementation');
   verification=qualifiedLifecycle||recovery?await verifyCandidate(candidateHead):{passed:true,detail:''};
  }
  onCompleted({phase:'implementation',verification:{...verification,head:candidateHead}});
  first=await runPhase('review',qualifiedLifecycle||recovery?'Trusted deterministic verification: '+JSON.stringify(verification):'');
 }
 // Full repair instructions already live in reviewFindings. Do not duplicate
 // two 12 KB messages inside the existing 24 KB checkpoint metadata envelope.
 const summary=value=>Buffer.from(String(value??''),'utf8').subarray(0,1600).toString('utf8');
 onCompleted({phase:'review',review:{phase:'review',verdict:first.verdict,findings:summary(first.findings)},
  verification:{passed:verification.passed,detail:summary(verification.detail),head:candidateHead}});
 if(recovery?.phase==='repair'||first.verdict!=='pass'||!verification.passed){
  const failedVerification=!verification.passed?{head:candidateHead,passed:false}:null;
  await runPhase('repair',recovery?.phase==='repair'?recovery.reviewFindings:first.findings+'\nTrusted deterministic verification: '+JSON.stringify(verification));
  repairPerformed=true;
  candidateHead=commitCandidate('native: checkpoint bounded repair');
  if(qualifiedLifecycle||recovery){
   verification=await verifyCandidate(candidateHead);
   if(!verification.passed)throw Error('NATIVE_HOST_DENIED: bounded repair failed deterministic acceptance');
   if(failedVerification)repairVerification={before:failedVerification,after:{head:candidateHead,passed:true}};
  }
 }
 let final=first;
 if(repairPerformed||qualifiedLifecycle||recovery){
  onCompleted({verification:{...verification,head:candidateHead},repairPerformed});
  final=await runPhase('final-review',qualifiedLifecycle||recovery?'Trusted deterministic verification: '+JSON.stringify(verification):'');
  if(final.verdict!=='pass')throw Error('NATIVE_HOST_DENIED: independent final review requires changes');
 }
 return {candidateHead,review:first,finalReview:final,repairPerformed,repairVerification};
}

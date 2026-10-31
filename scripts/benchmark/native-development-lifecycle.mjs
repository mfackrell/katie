// Phase control shared by the real host and nonbillable recovery qualification.
// The caller must complete the existing live-authority checks before invoking.
export async function executeNativeDevelopmentLifecycle({recovery,runPhase,commitCandidate,verifyCandidate,qualifiedLifecycle,onCompleted=()=>{}}){
 let candidateHead,verification,first,repairPerformed=false;
 if(recovery?.phase==='repair'){
  candidateHead=recovery.completedCheckpointSha;
  verification=recovery.lastCompleted.verification;
  first=recovery.lastCompleted.review;
  // These are previously completed, independently authenticated decisions.
  // No implementation or initial review request is replayed.
 }else{
  await runPhase('implementation');
  candidateHead=commitCandidate('native: checkpoint approved implementation');
  verification=qualifiedLifecycle?await verifyCandidate(candidateHead):{passed:true,detail:''};
  first=await runPhase('review',qualifiedLifecycle?'Trusted deterministic verification: '+JSON.stringify(verification):'');
 }
 onCompleted({phase:'review',review:first,verification:{...verification,head:candidateHead}});
 if(recovery?.phase==='repair'||first.verdict!=='pass'||!verification.passed){
  await runPhase('repair',recovery?.phase==='repair'?recovery.reviewFindings:first.findings+'\nTrusted deterministic verification: '+JSON.stringify(verification));
  repairPerformed=true;
  candidateHead=commitCandidate('native: checkpoint bounded repair');
  if(qualifiedLifecycle||recovery){
   verification=await verifyCandidate(candidateHead);
   if(!verification.passed)throw Error('NATIVE_HOST_DENIED: bounded repair failed deterministic acceptance');
  }
 }
 let final=first;
 if(repairPerformed||qualifiedLifecycle||recovery){
  final=await runPhase('final-review',qualifiedLifecycle||recovery?'Trusted deterministic verification: '+JSON.stringify(verification):'');
  if(final.verdict!=='pass')throw Error('NATIVE_HOST_DENIED: independent final review requires changes');
 }
 return {candidateHead,review:first,finalReview:final,repairPerformed};
}

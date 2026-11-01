import {createHash} from 'node:crypto';

// Shared trusted control path. runPhase owns fresh authority/capacity admission;
// neither this controller nor recovery can grant authority or mutate accounting.
export async function executeNativeDevelopmentLifecycle({recovery,runPhase,commitCandidate,verifyCandidate,qualifiedLifecycle,onCompleted=()=>{},candidateIdentity=head=>head,onIteration=()=>{}}){
 const summary=value=>Buffer.from(String(value??''),'utf8').subarray(0,1600).toString('utf8');
 const findingsOf=review=>review?.verdict==='changes_requested'?String(review.findings).split('\n').map(s=>s.trim()).filter(Boolean).slice(0,32).map(s=>s.slice(0,240)):[];
 const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 if(recovery?.phase==='do_completion')return recovery.lastCompleted.lifecycle;
 const saved=recovery?.lastCompleted??{};
 let candidateHead=recovery?.completedCheckpointSha,verification=saved.verification,first=saved.initialReview??saved.review;
 let decision=saved.review,repairPerformed=saved.repairPerformed===true,repairVerification=saved.repairVerification??null;
 let iteration=saved.adaptiveRepair?.iteration??0,seen=saved.adaptiveRepair?.seen??[],stagnant=saved.adaptiveRepair?.stagnant??0;
 let previousFailure=saved.adaptiveRepair?.failureSignature??null;
 let resumedRepair=recovery?.phase==='repair';
 let reviewRepair=saved.reviewRepair??null;
 const state=()=>({version:1,iteration,seen:seen.slice(-16),stagnant,failureSignature:previousFailure});
 const publish=(extra={})=>onCompleted({phase:'review',verification:{...verification,head:candidateHead,detail:summary(verification?.detail)},
  initialReview:first&&{...first,findings:summary(first.findings)},review:decision&&{...decision,findings:summary(decision.findings)},repairPerformed,repairVerification,reviewRepair,adaptiveRepair:state(),...extra});
 const review=async phase=>{
  const result=await runPhase(phase,'Previous independent findings: '+(decision?.findings??'none')+'\nTrusted deterministic verification: '+JSON.stringify(verification),{candidateHead});
  if(!result||!['pass','changes_requested'].includes(result.verdict)||typeof result.findings!=='string'||!result.findings.trim())throw Error('NATIVE_REVIEW_INVALID');
  // Only the trusted read-only reviewer adapter can attest inspected source.
  if(result.reviewedHeadSha!==candidateHead)throw Error('NATIVE_REVIEW_CANDIDATE_MISMATCH');
  return {...result,phase,reviewedHeadSha:candidateHead};
 };
 if(!['repair','review','final-review'].includes(recovery?.phase)){
  await runPhase('implementation');candidateHead=await commitCandidate('native: checkpoint approved implementation');
  verification={passed:false,pending:true,head:candidateHead,detail:'Candidate verification pending'};publish({phase:'implementation'});
  verification=await verifyCandidate(candidateHead);
  publish({phase:'implementation'});
 }
 if(saved.verification?.pending===true){verification=await verifyCandidate(candidateHead);publish();}
 if(recovery?.phase!=='repair'){
  decision=await review(recovery?.phase==='final-review'?'final-review':'review');first??=decision;publish();
 }
 // Keep the existing separate final review on an initial pass. Every subsequent
 // changed candidate gets fresh deterministic verification and a fresh reviewer.
 if(decision?.verdict==='pass'&&verification?.passed&&recovery?.phase!=='final-review'){
  decision=await review('final-review');publish();
 }
 while(decision?.verdict!=='pass'||!verification?.passed){
  if(verification?.kind==='infrastructure')throw Error('NATIVE_VERIFICATION_INFRASTRUCTURE: trustworthy tests unavailable');
  const source=await candidateIdentity(candidateHead);
  const failure=digest({findings:decision?.verdict==='pass'?'':decision?.findings,verification:verification?.passed?null:verification?.detail});
  const signature=digest({source,failure});
  if(!resumedRepair&&(seen.includes(signature)||stagnant>=3)){publish({stopReason:'no_meaningful_progress'});throw Error('NATIVE_REPAIR_NO_PROGRESS: unresolved findings or deterministic acceptance repeat; source and failure evidence preserved');}
  if(!seen.includes(signature))seen=[...seen,signature].slice(-16);previousFailure=failure;publish({continueReason:'actionable_engineering_defects'});
  const priorFindings=findingsOf(decision);
  const before={head:candidateHead,passed:verification.passed};
  if(decision.verdict==='changes_requested')reviewRepair={before:{head:candidateHead,verdict:decision.verdict}};
  const findings=recovery?.phase==='repair'&&iteration===(saved.adaptiveRepair?.iteration??0)?recovery.reviewFindings:
   decision.findings+'\nTrusted deterministic verification: '+JSON.stringify(verification);
  await runPhase('repair',findings);resumedRepair=false;iteration++;repairPerformed=true;
  candidateHead=await commitCandidate('native: checkpoint bounded repair');
  // A changed candidate invalidates any earlier approval before verification.
  verification={passed:false,pending:true,head:candidateHead,detail:'Candidate verification pending'};publish({phase:'implementation'});
  verification=await verifyCandidate(candidateHead);
  if(!before.passed&&verification.passed)repairVerification={before,after:{head:candidateHead,passed:true}};
  else if(repairVerification&&verification.passed)repairVerification={...repairVerification,after:{head:candidateHead,passed:true}};
  publish();
  decision=await review('final-review');
  const nextFailure=digest({findings:decision.verdict==='pass'?'':decision.findings,verification:verification.passed?null:verification.detail});
  stagnant=nextFailure===previousFailure?stagnant+1:0;
  publish();
  const sourceHash=await candidateIdentity(candidateHead),outstandingFindings=findingsOf(decision);
  await onIteration({iteration,candidateHead,sourceHash,verification,review:decision,outstandingFindings,resolvedFindings:priorFindings.filter(f=>!outstandingFindings.includes(f)),newFindings:outstandingFindings.filter(f=>!priorFindings.includes(f)),reason:decision.verdict==='pass'&&verification.passed?'verified':'repair_required'});
  if(sourceHash===source&&(decision.verdict!=='pass'||!verification.passed)){publish({stopReason:'no_meaningful_progress'});throw Error('NATIVE_REPAIR_NO_PROGRESS: repair left source unchanged and acceptance remains unsatisfied');}
 }
 if(reviewRepair)reviewRepair={...reviewRepair,after:{head:candidateHead,verdict:decision.verdict}};
 const result={candidateHead,review:first,finalReview:decision,repairPerformed,repairVerification,reviewRepair,repairIterations:iteration};
 publish({lastVerifiedCandidate:candidateHead,stopReason:'verified_engineering_completion'});
 return result;
}

"use client";
import {useRef,useState} from "react";
import {ownerSessionBearer} from "@/lib/tools/browser-owner-session";
import type {PackageExecutionOffer} from "@/lib/projects/package-execution-authorization";
export function PackageExecutionControl({initial,onRefresh}:{initial:PackageExecutionOffer;onRefresh:()=>void}){
 const [consent,setConsent]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),[receipt,setReceipt]=useState<string|null>(null);
 const submitting=useRef(false),t=initial.terms,c=initial.continuation,correction=initial.correctiveTerms,completion=initial.completionTerms,cp=initial.completionCheckpoint;
 async function authorize(){
  if(!consent||pending||receipt||submitting.current||Date.now()>=Date.parse(initial.cutoff)-300000)return;
  submitting.current=true;setPending(true);setError(null);
  try{
   const bearer=await ownerSessionBearer();if(!bearer)throw Error('Sign in as verified Katie owner.');
   const authorizationId=crypto.randomUUID();
   const response=await fetch('/api/projects/organization',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},body:JSON.stringify({
    trialAction:completion?'authorize_package_completion':correction?'authorize_package_corrective_continuation':'authorize_existing_package_execution',projectId:initial.projectId,packageId:initial.packageId,authorizationId,releaseSha:initial.releaseSha,
    releaseGeneration:initial.releaseGeneration,deploymentId:initial.deploymentId,stateHash:initial.stateHash,terms:t,paidInferenceConsent:true,...(correction?{correctiveTerms:correction,contextHash:initial.contextHash,contextChars:initial.contextChars}:{}),...(completion?{completionTerms:completion}:{})
   })});
   const result=await response.json();
   if(!response.ok)throw Error(typeof result.error==='string'?result.error:'Package authorization rejected');
   if(result.stage!=='authorized'||result.authorizationId!==authorizationId||result.packageId!==initial.packageId||result.stateHash!==initial.stateHash)throw Error('Receipt not verified. Refresh without resubmitting.');
   setReceipt(authorizationId);onRefresh();
  }catch(e){setError(e instanceof Error?e.message:'Approval failed closed');}
  finally{setPending(false);submitting.current=false;}
 }
 return <aside aria-label="Mission 104 existing package execution" className="mx-3 my-3 rounded-xl border border-white/20 p-4">
  <h3 className="font-semibold">{completion?'Authorize bounded completion of the original package':correction?'Authorize bounded corrective releases and continuation':c?'Continue existing package on corrected release':'Authorize existing development package'}</h3>
  <p className="mt-2 text-sm">{completion?'Preserve all 109 missions, the original SMART package, and all provider receipts. Mission 109 lost its previously purchased management response; one explicitly bounded replacement inference is required. Future captured management responses will be recovered without repurchase.':correction?'Preserve all 106 missions and failed attempts. Resume the saved Mission 106 on this corrected release. Subsequent tested corrective releases may continue this exact package under the same authority without another owner approval.':c?'Preserve all 105 missions and the first failed, zero-provider-request development attempt. Continue only the existing package on the corrected release, with the original limits and no new authority.':'Preserve 104 historical missions, existing workers and the exact SMART package. Execution starts only after this owner approval.'} Stop at package acceptance, expiry, or the authorized limits. No new commissioning, scope expansion, or autonomous game production deployment is authorized.</p>
  <ul className="mt-2 list-disc pl-5 text-sm">
   <li>Package: {initial.packageId}</li>
   {completion&&cp?<><li>Mission ceiling: {cp.usedMissions} consumed of {completion.maxMissions}, {completion.maxMissions-cp.usedMissions} remaining.</li><li>{cp.usedAttempts} of {completion.developmentAttempts} development attempts used. Maximum {completion.codingDispatches} native coding dispatches; {completion.nativeInferencePerDispatch} inference calls per dispatch.</li><li>{cp.paidInferences} of {completion.paidInferenceLimit} cumulative paid inference calls used. One replacement inference on the exact Mission 109 assignment only. No automatic paid retries elsewhere.</li><li>Existing standing correction limit: {cp.correctiveReleasesUsed} of {correction?.maxCorrectiveReleases} used, including this corrected release. No extra tokens, dollar allowance or deadline extension.</li><li>Complete management context: {initial.contextChars} characters. Failed assignment: {cp.assignmentId}; prior settled provider receipt: {cp.priorProviderReceipt}.</li></>:<><li>{c?'Mission ceiling remains '+t.maxMissions+'; '+c.usedMissions+' consumed, '+c.remainingMissions+' remaining.':'Mission ceiling: 104 → '+t.maxMissions+'; maximum '+t.additionalMissions+' new missions.'}</li>{c&&<li>Failed mission: {c.failedMissionId}; failed assignment: {c.failedAssignmentId}. {c.usedAttempts} attempt used, {c.remainingAttempts} remaining; no provider request or coding dispatch occurred.</li>}
   <li>{t.developmentAttempts} development attempts including up to two manager-directed corrections; {t.codingDispatches} coding dispatches.</li>
   <li>Paid inference: up to {t.nativeInferenceLimit} native calls ({t.nativeInferencePerDispatch} per dispatch), {t.compositionLimit} composition, {t.reviewLimit} independent review, {t.managerEvaluationLimit} manager evaluations and {t.managerRepairLimit} repair decisions; {t.paidInferenceLimit} total.</li>
   {correction&&<><li>Complete corrected management context: {initial.contextChars} characters.</li><li>Up to {correction.maxCorrectiveReleases} subsequent qualified corrective releases of Katie only. Each requires an actual saved failure, no active leases or unresolved provider requests, passing focused regression tests, an exact verified canonical deployment, and an immutable release receipt.</li><li>Retest an existing failed assignment only when it has no prior provider request, charge, decision or external dispatch. Otherwise continue only from a safe saved native scheduler checkpoint; never replay a paid request.</li></>}
   </>}
   <li>Zero automatic retries or native automatic repairs. Existing 600,000 recorded-token ceiling unchanged; provider-account charges are not represented by that ledger.</li>
   <li>Actual provider-account charges apply. No verified enforceable dollar ceiling exists in this execution mode.</li>
   <li>Exact development files: {initial.developmentPaths.join(', ')}</li>
   <li>Cutoff: {initial.cutoff} (UTC)</li><li>Release: {initial.releaseSha} · generation {initial.releaseGeneration} · {initial.deploymentId}</li>
  </ul>
  {!receipt?<div className="mt-3 space-y-3">
   <label className="block text-sm"><input type="checkbox" checked={consent} disabled={pending} onChange={e=>setConsent(e.target.checked)}/> {completion?'I explicitly authorize the one paid retry of Mission 109 and the cumulative completion ceilings displayed above, with existing standing corrective release authority, exact scope and deadline.':correction?'I authorize Mission 106 continuation and the bounded corrective releases above under my existing package, mission, spending and deadline authority, without requiring another owner approval for each qualifying release. No additional paid retries are authorized.':c?'I explicitly authorize the corrected release to continue the original package with only the unused authority from my existing approval.':'I explicitly authorize the above bounded paid package execution under existing provider-account pricing, including corrections only after manager rejection.'} I understand there is no verified dollar cap.</label>
   <button type="button" className="min-h-11 rounded border px-3 py-2 font-semibold disabled:opacity-50" disabled={!consent||pending||Date.now()>=Date.parse(initial.cutoff)-300000} onClick={()=>void authorize()}>{pending?'Recording signed approval…':completion?'Authorize bounded package completion':correction?'Authorize bounded corrective continuation':c?'Continue existing package on corrected release':'Authorize existing package execution'}</button>
  </div>:<div className="mt-3 text-sm" role="status">Signed package authorization: {receipt}</div>}
  {error&&<p className="mt-2 text-sm" role="alert">{error}</p>}
 </aside>;
}

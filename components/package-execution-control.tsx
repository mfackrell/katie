"use client";
import {useRef,useState} from "react";
import {ownerSessionBearer} from "@/lib/tools/browser-owner-session";
import type {PackageExecutionOffer} from "@/lib/projects/package-execution-authorization";
export function PackageExecutionControl({initial,onRefresh}:{initial:PackageExecutionOffer;onRefresh:()=>void}){
 const [consent,setConsent]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),[receipt,setReceipt]=useState<string|null>(null);
 const submitting=useRef(false),t=initial.terms,c=initial.continuation;
 async function authorize(){
  if(!consent||pending||receipt||submitting.current||Date.now()>=Date.parse(initial.cutoff)-300000)return;
  submitting.current=true;setPending(true);setError(null);
  try{
   const bearer=await ownerSessionBearer();if(!bearer)throw Error('Sign in as verified Katie owner.');
   const authorizationId=crypto.randomUUID();
   const response=await fetch('/api/projects/organization',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},body:JSON.stringify({
    trialAction:'authorize_existing_package_execution',projectId:initial.projectId,packageId:initial.packageId,authorizationId,releaseSha:initial.releaseSha,
    releaseGeneration:initial.releaseGeneration,deploymentId:initial.deploymentId,stateHash:initial.stateHash,terms:t,paidInferenceConsent:true
   })});
   const result=await response.json();
   if(!response.ok)throw Error(typeof result.error==='string'?result.error:'Package authorization rejected');
   if(result.stage!=='authorized'||result.authorizationId!==authorizationId||result.packageId!==initial.packageId||result.stateHash!==initial.stateHash)throw Error('Receipt not verified. Refresh without resubmitting.');
   setReceipt(authorizationId);onRefresh();
  }catch(e){setError(e instanceof Error?e.message:'Approval failed closed');}
  finally{setPending(false);submitting.current=false;}
 }
 return <aside aria-label="Mission 104 existing package execution" className="mx-3 my-3 rounded-xl border border-white/20 p-4">
  <h3 className="font-semibold">{c?'Continue existing package on corrected release':'Authorize existing development package'}</h3>
  <p className="mt-2 text-sm">{c?'Preserve all 105 missions and the first failed, zero-provider-request development attempt. Continue only the existing package on the corrected release, with the original limits and no new authority.':'Preserve 104 historical missions, existing workers and the exact SMART package. Execution starts only after this owner approval.'} Stop at package acceptance, expiry, or the authorized limits. No deployment, new commissioning, or scope expansion is authorized.</p>
  <ul className="mt-2 list-disc pl-5 text-sm">
   <li>Package: {initial.packageId}</li><li>{c?'Mission ceiling remains '+t.maxMissions+'; '+c.usedMissions+' consumed, '+c.remainingMissions+' remaining.':'Mission ceiling: 104 → '+t.maxMissions+'; maximum '+t.additionalMissions+' new missions.'}</li>{c&&<li>Failed mission: {c.failedMissionId}; failed assignment: {c.failedAssignmentId}. {c.usedAttempts} attempt used, {c.remainingAttempts} remaining; no provider request or coding dispatch occurred.</li>}
   <li>{t.developmentAttempts} development attempts including up to two manager-directed corrections; {t.codingDispatches} coding dispatches.</li>
   <li>Paid inference: up to {t.nativeInferenceLimit} native calls ({t.nativeInferencePerDispatch} per dispatch), {t.compositionLimit} composition, {t.reviewLimit} independent review, {t.managerEvaluationLimit} manager evaluations and {t.managerRepairLimit} repair decisions; {t.paidInferenceLimit} total.</li>
   <li>Zero automatic retries or native automatic repairs. Existing 600,000 recorded-token ceiling unchanged; provider-account charges are not represented by that ledger.</li>
   <li>Actual provider-account charges apply. No verified enforceable dollar ceiling exists in this execution mode.</li>
   <li>Exact development files: {initial.developmentPaths.join(', ')}</li>
   <li>Cutoff: {initial.cutoff} (UTC)</li><li>Release: {initial.releaseSha} · generation {initial.releaseGeneration} · {initial.deploymentId}</li>
  </ul>
  {!receipt?<div className="mt-3 space-y-3">
   <label className="block text-sm"><input type="checkbox" checked={consent} disabled={pending} onChange={e=>setConsent(e.target.checked)}/> {c?'I explicitly authorize the corrected release to continue the original package with only the unused authority from my existing approval.':'I explicitly authorize the above bounded paid package execution under existing provider-account pricing, including corrections only after manager rejection.'} I understand there is no verified dollar cap.</label>
   <button type="button" className="min-h-11 rounded border px-3 py-2 font-semibold disabled:opacity-50" disabled={!consent||pending||Date.now()>=Date.parse(initial.cutoff)-300000} onClick={()=>void authorize()}>{pending?'Recording signed approval…':c?'Continue existing package on corrected release':'Authorize existing package execution'}</button>
  </div>:<div className="mt-3 text-sm" role="status">Signed package authorization: {receipt}</div>}
  {error&&<p className="mt-2 text-sm" role="alert">{error}</p>}
 </aside>;
}

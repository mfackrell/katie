"use client";
import {useRef,useState} from "react";
import {ownerSessionBearer} from "@/lib/tools/browser-owner-session";
import type {Mission84ProviderRetryOffer} from "@/lib/projects/mission84-provider-retry";

export function Mission84ProviderRetryControl({initial,onRefresh}:{
 initial:Mission84ProviderRetryOffer;onRefresh:()=>void;
}){
 const submitting=useRef(false);
 const [pending,setPending]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const [receipt,setReceipt]=useState<string|null>(null);
 const expired=Date.now()>=Date.parse(initial.cutoff)-300000;
 const eligible=initial.stage==='authorize'&&!receipt&&!expired;
 async function approve(){
  if(submitting.current||pending||!eligible)return;
  submitting.current=true;setPending(true);setError(null);
  try{
   const bearer=await ownerSessionBearer();
   if(!bearer)throw Error('Sign in as the authenticated Katie owner to approve one additional Mission84 attempt.');
   const authorizationId=crypto.randomUUID();
   const response=await fetch('/api/projects/organization',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},
    body:JSON.stringify({
     trialAction:'authorize_m84_provider_retry',
     projectId:initial.projectId,releaseSha:initial.releaseSha,
     releaseGeneration:initial.releaseGeneration,deploymentId:initial.deploymentId,
     scopeHash:initial.scopeHash,stateHash:initial.stateHash,
     missionId:initial.missionId,assignmentId:initial.assignmentId,
     authorizationId,cutoff:initial.cutoff,
     originalRequestId:initial.originalRequestId,originalAttempts:1,newPaidAttempts:1
    })
   });
   const result=await response.json();
   if(!response.ok){if(response.status===409)onRefresh();
    throw Error(typeof result.error==='string'?result.error:'The authenticated retry was rejected.');}
   if(result.stage!=='authorized'||result.existing!==false
    ||result.projectId!==initial.projectId||result.authorizationId!==authorizationId
    ||result.releaseSha!==initial.releaseSha
    ||result.releaseGeneration!==initial.releaseGeneration
    ||result.deploymentId!==initial.deploymentId
    ||result.scopeHash!==initial.scopeHash
    ||result.missionId!==initial.missionId||result.assignmentId!==initial.assignmentId
    ||Date.parse(result.cutoff)!==Date.parse(initial.cutoff)
    ||result.originalAttempts!==1||result.newPaidAttempts!==1
    ||result.historicalMissions!==84||result.maxMissions!==96
    ||result.tokenAllowance!==600000||result.nodeCount!==13)
    throw Error('Retry receipt could not be verified. Refresh status; never automatically resubmit.');
   setReceipt(authorizationId);onRefresh();
  }catch(cause){setError(cause instanceof Error?cause.message:'Owner retry failed closed.');}
  finally{setPending(false);submitting.current=false;}
 }
 return <aside aria-label="Mission84 provider recovery" className="mx-3 my-3 rounded-xl border border-white/20 p-4">
  <h3 className="font-semibold">Original Mission 84 — one provider-execution retry</h3>
  <p className="mt-2 text-sm">The November 23 model-catalog response was observed by Katie and its unpersisted receipt has been reconciled to the original request. No paid inference occurred. The earlier assignment attempt and original request remain preserved.</p>
  <p className="mt-2 text-sm">Authorize exactly one additional normal scheduler attempt for the same Mission84 assignment. This permits a paid provider call within existing model, per-call spending, scope and management controls. It does not guarantee that a coding worker will be commissioned.</p>
  <ul className="mt-2 list-disc pl-5 text-sm">
   <li>Original project: {initial.projectId}</li>
   <li>Historical missions: 84 of 96; total token ceiling: 600,000 (unchanged)</li>
   <li>Prior Mission84 attempts: 1; additional paid attempts authorized by this approval: 1</li>
   <li>Current owner-approved deadline: {new Date(initial.cutoff).toLocaleString()}</li>
   <li>Release: {initial.releaseSha.slice(0,12)} / generation {initial.releaseGeneration} / {initial.deploymentId}</li>
   <li>No authority for any further retry, deadline extension, new budget or direct inference</li>
  </ul>
  {eligible?
   <button type="button" className="mt-3 min-h-11 rounded border px-3 py-2 font-semibold"
    disabled={pending} onClick={()=>void approve()}>
    {pending?'Recording one-time owner approval…':'Authorize one additional Mission 84 attempt'}
   </button>:
   <p role="status" className="mt-3 text-sm">{expired&&initial.stage==='authorize'
     ?'The existing approved deadline is too near or expired. No retry can be authorized.'
     :'Owner retry receipt: '+(receipt??initial.authorizationId??'not available')}</p>}
  <button type="button" className="mt-3 min-h-11 rounded border px-3 py-2 text-sm"
   disabled={pending} onClick={onRefresh}>Refresh Mission 84 status</button>
  {error&&<p role="alert" className="mt-2 text-sm">{error}</p>}
 </aside>;
}

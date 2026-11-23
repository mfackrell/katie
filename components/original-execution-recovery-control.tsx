"use client";

import {useRef,useState} from "react";
import {ownerSessionBearer} from "@/lib/tools/browser-owner-session";
import type {OriginalRecoveryOffer} from "@/lib/projects/original-execution-recovery";

// The user, not the server, must select every new permission. No preselected
// cutoff or additional worker-claim authority; the action is opt-in only.
export function OriginalExecutionRecoveryControl({initial,onRefresh}:{
 initial:OriginalRecoveryOffer;onRefresh:()=>void;
}){
 const busy=useRef(false);
 const [pending,setPending]=useState(false);
 const [cutoffLocal,setCutoffLocal]=useState("");
 const [newMissions,setNewMissions]=useState("");
 const [maxClaims,setMaxClaims]=useState("");
 const [retries,setRetries]=useState("");
 const [error,setError]=useState<string|null>(null);
 const [confirmed,setConfirmed]=useState<string|null>(null);
 const missionNumber=newMissions===""?NaN:Number(newMissions);
 const claimNumber=maxClaims===""?NaN:Number(maxClaims);
 const retryNumber=retries===""?NaN:Number(retries);
 const cutoffTimestamp=cutoffLocal?new Date(cutoffLocal).getTime():NaN;
 const valid=initial.stage==='authorize'&&!confirmed
  &&Number.isFinite(cutoffTimestamp)
  &&cutoffTimestamp>Date.now()+600000&&cutoffTimestamp<=Date.now()+72*3600000
  &&Number.isSafeInteger(missionNumber)&&missionNumber>=0&&missionNumber<=12
  &&Number.isSafeInteger(claimNumber)&&claimNumber>=1&&claimNumber<=26
  &&claimNumber<=2*(1+missionNumber)
  &&(retryNumber===0||retryNumber===1);
 async function authorize(){
  if(pending||busy.current||!valid)return;
  busy.current=true;setPending(true);setError(null);
  try{
   const bearer=await ownerSessionBearer();
   if(!bearer)throw Error('Sign in to Katie as the verified owner to approve recovery.');
   const authorizationId=crypto.randomUUID(),cutoff=new Date(cutoffTimestamp).toISOString();
   const response=await fetch('/api/projects/organization',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},
    body:JSON.stringify({
     trialAction:'authorize_original_execution_recovery',
     projectId:initial.projectId,missionId:initial.missionId,
     assignmentId:initial.assignmentId,
     releaseSha:initial.releaseSha,releaseGeneration:initial.releaseGeneration,
     deploymentId:initial.deploymentId,authorizationId,
     priorCutoff:initial.priorCutoff,stateHash:initial.stateHash,
     cutoff,newMissions:missionNumber,maxClaims:claimNumber,retryLimit:retryNumber
    })
   });
   const result=await response.json();
   if(!response.ok){
    if(response.status===409)onRefresh();
    throw Error(typeof result.error==='string'?result.error:'Recovery was not authorized.');
   }
   if(result.projectId!==initial.projectId||result.stage!=='recovered'
    ||result.existing!==false||result.authorizationId!==authorizationId
    ||result.releaseSha!==initial.releaseSha
    ||result.releaseGeneration!==initial.releaseGeneration
    ||result.deploymentId!==initial.deploymentId
    ||result.missionId!==initial.missionId||result.assignmentId!==initial.assignmentId
    ||result.scopeHash!==initial.scopeHash
    ||Date.parse(result.cutoff)!==cutoffTimestamp
    ||Date.parse(result.priorCutoff)!==Date.parse(initial.priorCutoff)
    ||result.authorizedTotalMissions!==84+missionNumber
    ||result.approvedClaims!==claimNumber||result.approvedRetries!==retryNumber
    ||result.historicalMissions!==84||result.currentAttempts!==0
    ||result.maxMissions!==96||result.tokenAllowance!==600000
    ||result.nodeCount!==13||!Number.isFinite(Date.parse(result.authorizedAt)))
    throw Error('Recovery receipt was not fully verified. Refresh status before any resubmission.');
   setConfirmed(authorizationId);
   onRefresh();
  }catch(e){setError(e instanceof Error?e.message:'Authenticated recovery could not be confirmed.');}
  finally{setPending(false);busy.current=false;}
 }
 return <aside aria-label="Original tic-tac-toe project owner execution recovery"
  className="mx-3 my-3 min-w-0 rounded-xl border border-white/20 p-4">
  <h3 className="font-semibold">Original Developer Orchestrator — authorized execution recovery</h3>
  <p className="mt-2 text-sm">Project {initial.projectId}. Original 84 of 96 missions,
   approved scope and 13 organizational contracts are preserved. Mission 83's failed
   context attempt remains unchanged. The same never-claimed Mission 84 assignment
   ({initial.assignmentId}) will be the first eligible work after approval.</p>
  <p className="mt-2 text-sm">Original cutoff: {new Date(initial.priorCutoff).toLocaleString()}.
   Release: {initial.releaseSha} / {initial.deploymentId} / generation {initial.releaseGeneration}.</p>
  <p className="mt-2 text-sm">Existing project allowance: 600,000 tokens and 96
   maximum missions (12 remaining). No change to approved scope, provider model,
   per-call spending settings, or financial ceilings. Newly approved worker
   claims can cause paid provider-account usage. The 45-minute watchdog remains unchanged.</p>
  {initial.stage==='authorize'?<div className="mt-3 grid gap-3">
   <label className="grid gap-1 text-sm">New owner-approved cutoff (your local time, 10 minutes to 72 hours)
    <input type="datetime-local" aria-label="New owner-approved execution cutoff"
     className="rounded border bg-transparent p-2" value={cutoffLocal} disabled={pending}
     onChange={e=>setCutoffLocal(e.target.value)}/>
   </label>
   <label className="grid gap-1 text-sm">Additional new missions allowed (0–12; no increase to 96)
    <input type="number" aria-label="Additional new missions" min={0} max={12} step={1}
     className="rounded border bg-transparent p-2" value={newMissions}
     onChange={e=>setNewMissions(e.target.value)} disabled={pending}/>
   </label>
   <label className="grid gap-1 text-sm">Maximum new worker assignment claims, including Mission 84 (1–26)
    <input type="number" aria-label="Maximum additional worker claims"
     min={1} max={26} step={1} className="rounded border bg-transparent p-2"
     value={maxClaims} onChange={e=>setMaxClaims(e.target.value)} disabled={pending}/>
   </label>
   <label className="grid gap-1 text-sm">Additional attempts per newly authorized assignment
    <select aria-label="Additional permitted attempts" className="rounded border bg-transparent p-2"
     value={retries} onChange={e=>setRetries(e.target.value)} disabled={pending}>
     <option value="">Select explicit retry allowance</option>
     <option value="0">0 — initial assignment claim only</option>
     <option value="1">1 — one bounded re-claim only if no model call was consumed</option>
    </select>
   </label>
   <p className="text-xs">No Mission 83 retry. Total new claims cannot exceed twice
    the existing Mission 84 plus the additional missions you authorize. Every
    subsequent assignment still needs independent organizational and release authorization.</p>
   <button type="button" className="min-h-11 rounded border px-3 py-2 font-semibold"
    onClick={()=>void authorize()} disabled={pending||!valid}>
    {pending?'Recording signed approval…':'Approve exact new execution window and resume original Mission 84'}
   </button>
  </div>:<p className="mt-3 text-sm" role="status">
   Owner recovery status: {initial.stage}. Authorization: {confirmed??initial.authorizationId??'not recorded'}.
   {initial.cutoff?' Approved cutoff: '+new Date(initial.cutoff).toLocaleString()+'.':''}</p>}
  <button type="button" disabled={pending} className="mt-3 min-h-11 rounded border px-3 py-2 text-sm"
   onClick={onRefresh}>Refresh original project status</button>
  {error&&<p className="mt-2 text-sm" role="alert">{error}</p>}
 </aside>;
}

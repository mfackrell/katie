"use client";

import {useRef,useState} from "react";
import {ownerSessionBearer} from "@/lib/tools/browser-owner-session";
import type {OriginalBoundedRecoveryOffer} from "@/lib/projects/original-bounded-recovery";

export function OriginalBoundedRecoveryControl({initial,onRefresh}:{
 initial:OriginalBoundedRecoveryOffer;onRefresh:()=>void;
}){
 const sending=useRef(false);
 const [pending,setPending]=useState(false);
 const [cutoff,setCutoff]=useState("");
 const [error,setError]=useState<string|null>(null);
 const [receipt,setReceipt]=useState<string|null>(null);
 const isReady=initial.stage==='authorize'&&!receipt;
 async function authorize(){
  if(sending.current||pending||!isReady||!cutoff)return;
  const timestamp=Date.parse(cutoff);
  if(!Number.isFinite(timestamp)||timestamp<=Date.now()+30*60000
    ||timestamp>Date.now()+72*3600000){
   setError('Select an explicit deadline more than 30 minutes and no more than 72 hours from now.');
   return;
  }
  sending.current=true;setPending(true);setError(null);
  try{
   const token=await ownerSessionBearer();
   if(!token)throw Error('Authenticated owner sign-in is required.');
   const authorizationId=crypto.randomUUID();
   const newCutoff=new Date(timestamp).toISOString();
   const response=await fetch('/api/projects/organization',{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({
     trialAction:'authorize_original_bounded_recovery',
     projectId:initial.projectId,releaseSha:initial.releaseSha,
     releaseGeneration:initial.releaseGeneration,deploymentId:initial.deploymentId,
     scopeHash:initial.scopeHash,stateHash:initial.stateHash,
     activeMissionId:initial.activeMissionId,assignmentId:initial.assignmentId,
     priorCutoff:initial.priorCutoff,cutoff:newCutoff,authorizationId,
     historicalMissions:84,maxMissions:96,tokenAllowance:600000,
     additionalPaidRetries:0
    })
   });
   const result=await response.json();
   if(!response.ok){
    if(response.status===409)onRefresh();
    throw Error(typeof result.error==='string'?result.error:'Recovery rejected by the current owner approval contract.');
   }
   if(result.stage!=='recovered'||result.existing!==false
    ||result.authorizationId!==authorizationId
    ||result.projectId!==initial.projectId
    ||result.releaseSha!==initial.releaseSha
    ||result.releaseGeneration!==initial.releaseGeneration
    ||result.deploymentId!==initial.deploymentId
    ||result.scopeHash!==initial.scopeHash
    ||Date.parse(result.cutoff)!==timestamp
    ||result.historicalMissions!==84||result.maxMissions!==96
    ||result.tokenAllowance!==600000||result.additionalPaidRetries!==0
    ||result.activeMissionId!==initial.activeMissionId
    ||result.assignmentId!==initial.assignmentId
    ||result.nodeCount!==13)
    throw Error('Recovery receipt could not be verified. Refresh status; do not resubmit automatically.');
   setReceipt(authorizationId);onRefresh();
  }catch(e){setError(e instanceof Error?e.message:'Owner recovery could not be verified.');}
  finally{setPending(false);sending.current=false;}
 }
 return <aside aria-label="Original project bounded owner recovery"
  className="mx-3 my-3 rounded-xl border border-white/20 p-4">
  <h3 className="font-semibold">Original Developer Orchestrator — renew and recover</h3>
  <p className="mt-2 text-sm">
   Original project {initial.projectId}. The existing November 22 cutoff expired,
   and the normal 45-minute watchdog blocked the project. This action is for its
   existing 84 missions and original Mission 84 assignment, not a new project.
  </p>
  <p className="mt-2 text-sm">
   All prior management decisions, Mission 83&apos;s failed pre-inference attempt,
   provider records and original organization remain intact. The original Mission 84
   has zero attempts and is the only assignment this approval will resume.
  </p>
  <ul className="mt-2 list-disc pl-5 text-sm">
   <li>Existing mission ceiling: 96; 84 used, 12 remaining</li>
   <li>Existing project token ceiling: 600,000; {initial.stage==='authorize'
    ?initial.remainingTokens?.toLocaleString():'previously approved remaining'} available</li>
   <li>Additional paid retries of previously failed missions: zero</li>
   <li>Per-call and provider-account spending controls: unchanged; no new spending ceiling or credit granted</li>
   <li>Approved scope, directory restrictions, SMART and independent QA: unchanged</li>
   <li>Release: {initial.releaseSha.slice(0,12)}, generation {initial.releaseGeneration}, deployment {initial.deploymentId}</li>
  </ul>
  {initial.stage==='authorized'?
   <p className="mt-3 text-sm" role="status">Authorized cutoff: {new Date(initial.cutoff!).toLocaleString()}; receipt {initial.authorizationId}.</p>
   :<>
    <label className="mt-3 block text-sm">Choose the NEW execution deadline (your local time)
     <input type="datetime-local" className="mt-1 block rounded border bg-transparent p-2"
      aria-label="New owner-approved execution deadline" value={cutoff}
      onChange={e=>setCutoff(e.target.value)} disabled={pending}/>
    </label>
    <p className="mt-2 text-sm">More than 30 minutes, no more than 72 hours from approval.
     This is new execution permission within existing resource limits, not a retrospective extension of old authorizations.</p>
    <button type="button" className="mt-3 min-h-11 rounded border px-3 py-2 font-semibold"
     onClick={()=>void authorize()} disabled={pending||!cutoff}>
     {pending?'Recording authenticated authorization…':'Approve this cutoff and resume original Mission 84'}
    </button>
   </>}
  <button type="button" className="mt-3 min-h-11 rounded border px-3 py-2 text-sm"
   disabled={pending} onClick={onRefresh}>Refresh original project status</button>
  {receipt&&<p role="status" className="mt-2 text-sm">Authenticated receipt: {receipt}.</p>}
  {error&&<p role="alert" className="mt-2 text-sm">{error}</p>}
 </aside>;
}

"use client";

import {useRef,useState} from "react";
import {ownerSessionBearer} from "@/lib/tools/browser-owner-session";
import type {Mission79RetryOffer} from "@/lib/projects/mission79-retry";

export function Mission79RetryControl({initial,onRefresh}:{
 initial:Mission79RetryOffer;onRefresh:()=>void;
}){
 const submitting=useRef(false);
 const [pending,setPending]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const [confirmed,setConfirmed]=useState<string|null>(null);
 const expired=Date.now()>=Date.parse(initial.cutoff)-300000;
 async function approve(){
  if(submitting.current||pending||confirmed||initial.stage!=='approve_retry'||expired)return;
  submitting.current=true;setPending(true);setError(null);
  try{
   const bearer=await ownerSessionBearer();
   if(!bearer)throw Error('Authenticated Katie owner sign-in is required.');
   const authorizationId=crypto.randomUUID();
   const response=await fetch('/api/projects/organization',{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},
    body:JSON.stringify({
     trialAction:'authorize_mission79_failed_retry',
     projectId:initial.projectId,missionId:initial.missionId,
     assignmentId:initial.assignmentId,releaseSha:initial.releaseSha,
     releaseGeneration:initial.releaseGeneration,deploymentId:initial.deploymentId,
     authorizationId,cutoff:initial.cutoff,stateHash:initial.stateHash
    })
   });
   const result=await response.json();
   if(!response.ok){
    if(response.status===409)onRefresh();
    throw Error(typeof result.error==='string'?result.error:'One-time retry authorization was rejected.');
   }
   if(result.projectId!==initial.projectId||result.stage!=='authorized'||result.existing!==false
     ||result.authorizationId!==authorizationId||result.releaseSha!==initial.releaseSha
     ||result.releaseGeneration!==initial.releaseGeneration||result.deploymentId!==initial.deploymentId
     ||result.missionId!==initial.missionId||result.assignmentId!==initial.assignmentId
     ||result.scopeHash!==initial.scopeHash||Date.parse(result.cutoff)!==Date.parse(initial.cutoff)
     ||result.originalAttempts!==1||result.originalCalls!==1
     ||result.historicalMissions!==79||result.maxMissions!==96
     ||result.tokenAllowance!==600000||result.nodeCount!==13
     ||typeof result.authorizedAt!=='string'||!Number.isFinite(Date.parse(result.authorizedAt)))
    throw Error('Immutable retry receipt could not be verified. Refresh; never resubmit automatically.');
   setConfirmed(authorizationId);
   onRefresh();
  }catch(e){setError(e instanceof Error?e.message:'Retry authorization could not be confirmed.');}
  finally{setPending(false);submitting.current=false;}
 }
 return <aside className="mx-3 my-3 rounded-xl border border-white/20 p-4" aria-label="Mission 79 single retry authorization">
  <h3 className="font-semibold">Original Developer Orchestrator — one corrective retry</h3>
  <p className="mt-2 text-sm">The first Project Director management attempt failed hierarchy validation.
   Its provider receipt, rejection and consumed resources remain retained. The corrected management
   guidance is deployed. This is authorization for exactly <strong>one additional attempt</strong>
   of the same Mission 79 assignment—not a new mission, budget, deadline or project.</p>
  <p className="mt-2 text-sm">Existing cutoff: {new Date(initial.cutoff).toLocaleString()}.
   After approval, the normal scheduled worker may perform one additional paid provider call without
   another prompt. Do not approve unless you intend that execution.</p>
  {initial.stage==='approve_retry'&&!confirmed
   ?expired?<p role="alert" className="mt-3 text-sm">The existing execution cutoff is too close or has expired. No retry can be authorized.</p>
   :<button type="button" onClick={()=>void approve()} disabled={pending}
    className="mt-3 min-h-11 rounded border px-3 py-2 font-semibold">
    {pending?'Recording one-time owner authorization…':'Approve exactly one Mission 79 retry'}
   </button>
   :<p role="status" className="mt-3 text-sm">One-time retry receipt:
     {confirmed??initial.authorizationId}. Status: {initial.stage}.
     No additional approval is available.</p>}
  <button type="button" className="mt-3 min-h-11 rounded border px-3 py-2 text-sm"
   onClick={onRefresh} disabled={pending}>Refresh saved retry status</button>
  {error&&<p role="alert" className="mt-2 text-sm">{error}</p>}
 </aside>;
}

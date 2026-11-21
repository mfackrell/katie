"use client";

import {useRef,useState} from "react";
import {ownerSessionBearer} from "@/lib/tools/browser-owner-session";
import type {Mission82WatchdogOffer} from "@/lib/projects/mission82-watchdog";

export function Mission82WatchdogRecoveryControl({initial,onRefresh}:{
 initial:Mission82WatchdogOffer;onRefresh:()=>void;
}){
 const submitting=useRef(false);
 const [pending,setPending]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const [confirmed,setConfirmed]=useState<string|null>(null);
 const expired=Date.now()>=Date.parse(initial.cutoff)-300000;
 const eligible=initial.stage==='recover_watchdog'&&!expired&&!confirmed;
 async function approve(){
  if(submitting.current||pending||!eligible)return;
  submitting.current=true;setPending(true);setError(null);
  try{
   const bearer=await ownerSessionBearer();
   if(!bearer)throw Error('Authenticated Katie owner sign-in is required.');
   const authorizationId=crypto.randomUUID();
   const response=await fetch('/api/projects/organization',{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},
    body:JSON.stringify({
     trialAction:'authorize_mission82_watchdog_recovery',
     projectId:initial.projectId,missionId:initial.missionId,
     assignmentId:initial.assignmentId,releaseSha:initial.releaseSha,
     releaseGeneration:initial.releaseGeneration,deploymentId:initial.deploymentId,
     authorizationId,cutoff:initial.cutoff,stateHash:initial.stateHash
    })
   });
   const result=await response.json();
   if(!response.ok){
    if(response.status===409)onRefresh();
    throw Error(typeof result.error==='string'?result.error:'Mission82 recovery authorization was rejected.');
   }
   if(result.projectId!==initial.projectId||result.stage!=='recovered'||result.existing!==false
     ||result.authorizationId!==authorizationId||result.releaseSha!==initial.releaseSha
     ||result.releaseGeneration!==initial.releaseGeneration
     ||result.deploymentId!==initial.deploymentId
     ||result.missionId!==initial.missionId||result.assignmentId!==initial.assignmentId
     ||result.scopeHash!==initial.scopeHash||Date.parse(result.cutoff)!==Date.parse(initial.cutoff)
     ||result.currentAttempts!==0||result.historicalMissions!==82||result.maxMissions!==96
     ||result.tokenAllowance!==600000||result.nodeCount!==13
     ||typeof result.authorizedAt!=='string'||!Number.isFinite(Date.parse(result.authorizedAt)))
    throw Error('Immutable owner recovery receipt could not be verified. Refresh without resubmitting automatically.');
   setConfirmed(authorizationId);
   onRefresh();
  }catch(e){setError(e instanceof Error?e.message:'Owner recovery was not confirmed.');}
  finally{setPending(false);submitting.current=false;}
 }
 return <aside aria-label="Mission 82 owner watchdog recovery"
  className="mx-3 my-3 rounded-xl border border-white/20 p-4">
  <h3 className="font-semibold">Original Developer Orchestrator — Mission 82 recovery</h3>
  <p className="mt-2 text-sm">
   The original Mission 82 assignment remains queued at zero attempts. Its prior Game Delivery management session failed SMART validation, and the original scheduler correctly escalated to the Project Director. The 45-minute
   inactivity watchdog blocked the project while the independently valid continuation was being repaired.
   This authenticated approval restores only that original project under the current verified
   release and refreshes its normal watchdog grace period. It grants no third Mission 79
   attempt, extra resources, or deadline extension.
  </p>
  <p className="mt-2 text-sm">Existing cutoff: {new Date(initial.cutoff).toLocaleString()}.
   After approval the ordinary scheduler may make a paid model call for Mission 82.
   Subsequent missions must independently meet the approved project and release controls.</p>
  {eligible?<button type="button" onClick={()=>void approve()} disabled={pending}
    className="mt-3 min-h-11 rounded border px-3 py-2 font-semibold">
    {pending?'Recording authenticated recovery…':'Authorize recovery of original Mission 82'}
   </button>:
   <p className="mt-3 text-sm" role="status">{expired&&initial.stage==='recover_watchdog'
    ?'The existing owner cutoff is too near or expired. Recovery is unavailable.'
    :`Recovery status: ${initial.stage}. Owner receipt: ${confirmed??initial.authorizationId??'not recorded'}.`}</p>}
  <button type="button" className="mt-3 min-h-11 rounded border px-3 py-2 text-sm"
    onClick={onRefresh} disabled={pending}>Refresh saved Mission 82 status</button>
  {error&&<p role="alert" className="mt-2 text-sm">{error}</p>}
 </aside>;
}

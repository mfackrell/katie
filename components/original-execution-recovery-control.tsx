"use client";
import {useRef,useState} from "react";
import {ownerSessionBearer} from "@/lib/tools/browser-owner-session";
import type {OriginalExecutionRecoveryOffer} from "@/lib/projects/original-execution-recovery";

export function OriginalExecutionRecoveryControl({initial,onRefresh}:{
 initial:OriginalExecutionRecoveryOffer;onRefresh:()=>void;
}){
 const submitting=useRef(false);
 const [pending,setPending]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const [confirmed,setConfirmed]=useState(false);
 const [cutoffInput,setCutoffInput]=useState("");
 const [missionCeiling,setMissionCeiling]=useState(96);
 const eligible=initial.stage==='authorize'&&!confirmed;
 const chosenCutoff=cutoffInput?Date.parse(cutoffInput):NaN;
 const valid=Number.isFinite(chosenCutoff)&&chosenCutoff>Date.now()+30*60*1000
  &&chosenCutoff<=Date.now()+7*24*60*60*1000
  &&Number.isSafeInteger(missionCeiling)&&missionCeiling>=84&&missionCeiling<=96;
 async function authorize(){
  if(submitting.current||pending||!eligible||!valid)return;
  submitting.current=true;setPending(true);setError(null);
  try{
   const bearer=await ownerSessionBearer();
   if(!bearer)throw Error('Authenticated original project owner sign-in required.');
   const authorizationId=crypto.randomUUID();
   const cutoff=new Date(chosenCutoff).toISOString();
   const response=await fetch('/api/projects/organization',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},
    body:JSON.stringify({
     trialAction:'authorize_original_project_recovery',
     projectId:initial.projectId,releaseSha:initial.releaseSha,
     releaseGeneration:initial.releaseGeneration,deploymentId:initial.deploymentId,
     missionId:initial.missionId,assignmentId:initial.assignmentId,
     authorizationId,cutoff,missionCeiling,tokenCeiling:600000,
     initialAttemptsPerAssignment:1,priorFailureRetryAllowance:0,
     stateHash:initial.stateHash
    })
   });
   const result=await response.json();
   if(!response.ok){if(response.status===409)onRefresh();
    throw Error(typeof result.error==='string'?result.error:'Original owner approval was rejected.');}
   if(result.projectId!==initial.projectId||result.stage!=='recovered'
    ||result.existing!==false||result.authorizationId!==authorizationId
    ||result.releaseSha!==initial.releaseSha
    ||result.releaseGeneration!==initial.releaseGeneration
    ||result.deploymentId!==initial.deploymentId
    ||result.scopeHash!==initial.scopeHash||result.missionId!==initial.missionId
    ||result.assignmentId!==initial.assignmentId
    ||Date.parse(result.cutoff)!==Date.parse(cutoff)
    ||result.missionCeiling!==missionCeiling||result.tokenAllowance!==600000
    ||result.initialAttemptsPerAssignment!==1||result.priorFailureRetryAllowance!==0
    ||result.currentAttempts!==0||result.historicalMissions!==84
    ||result.maxMissions!==96||result.nodeCount!==13
    ||!Number.isFinite(Date.parse(result.authorizedAt)))
    throw Error('Authenticated recovery receipt did not match approved terms; refresh without reapproving.');
   setConfirmed(true);onRefresh();
  }catch(e){setError(e instanceof Error?e.message:'Owner authorization not confirmed.');}
  finally{setPending(false);submitting.current=false;}
 }
 return <aside aria-label="Original Developer Orchestrator bounded execution window"
  className="mx-3 my-3 rounded-xl border border-white/20 p-4">
  <h3 className="font-semibold">Original tic-tac-toe project — recover execution</h3>
  <p className="mt-2 text-sm">
   Original project {initial.projectId}. All 84 historical missions, the failed
   Mission 83 evidence, 13 organization nodes and completed decisions remain
   unchanged. The old deadline expired on {new Date(initial.priorCutoff).toLocaleString()}.
  </p>
  <p className="mt-2 text-sm">
   This approval starts a NEW owner-selected window and restores only existing
   queued Mission 84 ({initial.missionId}, assignment {initial.assignmentId}).
   No attempt or provider charge has yet occurred for this assignment.
  </p>
  <p className="mt-2 text-sm">
   Existing ceilings remain: 96 total missions (84 used), 600,000 total model tokens,
   original approved game scope, original 13-node organization and current spending
   controls. Every new assignment receives at most ONE initial inference attempt.
   Prior failed assignments, including Mission 83, receive ZERO additional attempts.
   Paid work can start automatically through the existing scheduler after approval.
  </p>
  <p className="mt-2 text-xs break-all">
   Exact binding: SHA {initial.releaseSha}; deployment {initial.deploymentId};
   release generation {initial.releaseGeneration}.
  </p>
  {eligible?<div className="mt-3 space-y-3">
   <label className="block text-sm">Choose new cutoff (your local time)
    <input type="datetime-local" value={cutoffInput}
     onChange={e=>setCutoffInput(e.target.value)} disabled={pending}
     className="mt-1 block max-w-full rounded border bg-transparent p-2"/>
   </label>
   <p className="text-xs">Choose a future time from 30 minutes to 7 days ahead. No cutoff is selected for you.</p>
   <label className="block text-sm">Maximum cumulative missions under this window (84 already recorded)
    <input type="number" min={84} max={96} step={1} value={missionCeiling}
     onChange={e=>setMissionCeiling(Number(e.target.value))} disabled={pending}
     className="mt-1 block w-28 rounded border bg-transparent p-2"/>
   </label>
   <button type="button" className="min-h-11 rounded border px-3 py-2 font-semibold"
    disabled={pending||!valid} onClick={()=>void authorize()}>
    {pending?'Recording authenticated approval…':'Approve this cutoff and restore original Mission 84'}
   </button>
  </div>:<p role="status" className="mt-3 text-sm">
   Status: {confirmed?'Owner approval recorded':initial.stage}.
   {initial.cutoff?' Authorized until '+new Date(initial.cutoff).toLocaleString():''}
  </p>}
  <button type="button" className="mt-3 min-h-11 rounded border px-3 py-2 text-sm"
   disabled={pending} onClick={onRefresh}>Refresh original project recovery</button>
  {error&&<p role="alert" className="mt-2 text-sm">{error}</p>}
 </aside>;
}

"use client";
import {useRef,useState} from "react";
import {ownerSessionBearer} from "@/lib/tools/browser-owner-session";
import type {ManagementContextRetestOffer} from "@/lib/projects/management-context-retest";
import type {ManagementFailureRetestOffer} from "@/lib/projects/management-failure-retest";

export function ManagementContextRetestControl({initial,onRefresh,trialAction='authorize_management_context_one_retest'}:{
 initial:ManagementContextRetestOffer|ManagementFailureRetestOffer;
 onRefresh:()=>void;
 trialAction?:'authorize_management_context_one_retest'|'authorize_management_failure_retest';
}){
 const submitting=useRef(false);
 const [pending,setPending]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const [receipt,setReceipt]=useState<string|null>(null);
 const expired=Date.now()>=Date.parse(initial.cutoff)-300000;
 const eligible=initial.stage==='authorize'&&!receipt&&!expired;
 async function authorize(){
  if(submitting.current||pending||!eligible)return;
  submitting.current=true;setPending(true);setError(null);
  try{
   const bearer=await ownerSessionBearer();
   if(!bearer)throw Error("Sign in to Katie as the verified project owner.");
   if(!initial.contextHash||!initial.contextChars||!initial.stateHash)
    throw Error("Current management evidence preflight missing; refresh before approval.");
   const authorizationId=crypto.randomUUID();
   const response=await fetch('/api/projects/organization',{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},
    body:JSON.stringify({
     trialAction,
     projectId:initial.projectId,releaseSha:initial.releaseSha,
     releaseGeneration:initial.releaseGeneration,deploymentId:initial.deploymentId,
     scopeHash:initial.scopeHash,stateHash:initial.stateHash,
     contextHash:initial.contextHash,contextChars:initial.contextChars,
     missionId:initial.missionId,assignmentId:initial.assignmentId,
     authorizationId,cutoff:initial.cutoff,historicalMissions:initial.historicalMissions,
     originalAttempts:1,additionalAttempts:1
    })
   });
   const result=await response.json();
   if(!response.ok){
    if(response.status===409)onRefresh();
    throw Error(typeof result.error==='string'?result.error:'One-time signed approval rejected.');
   }
   if(result.stage!=='authorized'||result.existing!==false
    ||result.projectId!==initial.projectId||result.authorizationId!==authorizationId
    ||result.releaseSha!==initial.releaseSha
    ||result.releaseGeneration!==initial.releaseGeneration
    ||result.deploymentId!==initial.deploymentId
    ||result.scopeHash!==initial.scopeHash
    ||result.missionId!==initial.missionId||result.assignmentId!==initial.assignmentId
    ||result.historicalMissions!==initial.historicalMissions
    ||result.maxMissions!==96||result.tokenAllowance!==600000||result.nodeCount!==13
    ||result.originalAttempts!==1||result.additionalAttempts!==1
    ||result.contextHash!==initial.contextHash||result.contextChars!==initial.contextChars
    ||Date.parse(result.cutoff)!==Date.parse(initial.cutoff))
    throw Error('Signed retry receipt is not verified. Refresh status without resubmitting.');
   setReceipt(authorizationId);onRefresh();
  }catch(e){setError(e instanceof Error?e.message:'Owner approval failed closed.');}
  finally{setPending(false);submitting.current=false;}
 }
 return <aside aria-label="One live management-context retest" className="mx-3 my-3 rounded-xl border border-white/20 p-4">
  <h3 className="font-semibold">Original Developer Orchestrator — one source-bound management retest</h3>
  <p className="mt-2 text-sm">The latest management assignment failed before provider inference. Its original failure, mission identity and attempted execution remain recorded. The full current management context was verified without truncation; no previous retry receipt is reused.</p>
  <ul className="mt-2 list-disc pl-5 text-sm">
   <li>Original project: {initial.projectId}</li>
   <li>Historical missions: {initial.historicalMissions} of 96, unchanged</li>
   <li>Mission: {initial.missionId}; assignment: {initial.assignmentId}</li>
   <li>Current context: {initial.contextChars?.toLocaleString()??'Verified previously'} of 48,000 characters</li>
   <li>Original attempted execution: 1, with zero provider calls; exactly 1 further attempt to authorize</li>
   <li>Execution may include one paid provider inference within existing per-call limits</li>
   <li>Existing cutoff: {new Date(initial.cutoff).toLocaleString()}</li>
   <li>Original 600,000-token budget, spending controls, SMART and the 13-node hierarchy unchanged</li>
   <li>Current release: {initial.releaseSha.slice(0,12)} · generation {initial.releaseGeneration} · {initial.deploymentId}</li>
  </ul>
  {eligible?<button type="button" className="mt-3 min-h-11 rounded border px-3 py-2 font-semibold"
   disabled={pending} onClick={()=>void authorize()}>
   {pending?'Recording signed one-attempt recovery…':'Authorize one corrected-context management attempt'}
  </button>:
   <p role="status" className="mt-3 text-sm">{initial.stage==='authorized'
    ?'Owner approval recorded: '+initial.authorizationId:
    expired?'The approved project cutoff has expired or is too near.':
    'Owner authorization: '+(receipt??'unavailable')}</p>}
  <button type="button" className="mt-3 min-h-11 rounded border px-3 py-2 text-sm"
   disabled={pending} onClick={onRefresh}>Refresh saved management recovery</button>
  {error&&<p role="alert" className="mt-2 text-sm">{error}</p>}
 </aside>;
}

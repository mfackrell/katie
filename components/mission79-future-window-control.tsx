"use client";

import {useRef,useState} from "react";
import {ownerSessionBearer} from "@/lib/tools/browser-owner-session";
import type {Mission79FutureWindowOffer} from "@/lib/projects/mission79-future-window";

export function Mission79FutureWindowControl({
 initial,onRefresh
}:{initial:Mission79FutureWindowOffer;onRefresh:()=>void}){
 const [cutoffInput,setCutoffInput]=useState("");
 const [pending,setPending]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const [confirmed,setConfirmed]=useState<{authorizationId:string;cutoff:string;authorizedAt:string}|null>(null);
 const submitting=useRef(false);

 async function authorize(){
  if(submitting.current||pending||confirmed||initial.stage!=='authorize'||!cutoffInput)return;
  submitting.current=true;setPending(true);setError(null);
  try{
   const chosen=new Date(cutoffInput).getTime();
   if(!Number.isFinite(chosen)||chosen<=Date.now()+300000||chosen>Date.now()+86400000
    ||chosen<=Date.parse(initial.priorCutoff))
    throw Error("Choose an explicit future cutoff more than five minutes ahead and within 24 hours.");
   const bearer=await ownerSessionBearer();
   if(!bearer)throw Error("Sign in as the existing Katie owner to approve the new window.");
   const authorizationId=crypto.randomUUID();
   const cutoff=new Date(chosen).toISOString();
   const response=await fetch("/api/projects/organization",{
    method:"POST",
    headers:{"Content-Type":"application/json",Authorization:"Bearer "+bearer},
    body:JSON.stringify({
     trialAction:"authorize_mission79_future_window",
     projectId:initial.projectId,releaseSha:initial.releaseSha,
     missionId:initial.missionId,assignmentId:initial.assignmentId,
     authorizationId,cutoff,stateHash:initial.stateHash
    }),
   });
   const result=await response.json();
   if(!response.ok)throw Error(typeof result.error==="string"?result.error:"Owner window authorization was rejected.");
   if(result.projectId!==initial.projectId||result.stage!=="authorized"
    ||result.authorizationId!==authorizationId||result.releaseSha!==initial.releaseSha
    ||result.sourceMissionId!==initial.sourceMissionId
    ||result.missionId!==initial.missionId||result.assignmentId!==initial.assignmentId
    ||result.scopeHash!==initial.scopeHash
    ||Date.parse(result.priorCutoff)!==Date.parse(initial.priorCutoff)
    ||Date.parse(result.cutoff)!==chosen
    ||result.historicalMissions!==79||result.maxMissions!==96
    ||result.tokenAllowance!==600000||result.status!=="blocked"
    ||result.missionStatus!=="blocked"||result.existing!==false
    ||typeof result.authorizedAt!=="string"||!Number.isFinite(Date.parse(result.authorizedAt)))
    throw Error("The saved owner-window receipt could not be verified. Refresh; do not authorize again automatically.");
   setConfirmed({authorizationId,cutoff,authorizedAt:result.authorizedAt});
   onRefresh();
  }catch(e){setError(e instanceof Error?e.message:"Owner authorization could not be confirmed.");}
  finally{setPending(false);submitting.current=false;}
 }
 const approved=initial.stage!=="authorize"||!!confirmed;
 const effectiveCutoff=confirmed?.cutoff??initial.cutoff;
 return <aside className="mx-3 my-3 rounded-xl border border-white/20 p-4" aria-label="Original mission 79 future window">
  <h3 className="font-semibold">Original DO — Mission 79 execution window</h3>
  <p className="mt-2 text-sm">The previous approved window expired at
   {" "}{new Date(initial.priorCutoff).toLocaleString()}.
   The original 79 of 96 missions, 600,000-token ceiling, project scope,
   organization contracts and saved costs remain unchanged.</p>
  <p className="mt-2 text-sm">Choose and explicitly approve a new deadline.
   This records one owner authorization only. It does not start a worker,
   commission coding, invoke an LLM, or bind the production release.</p>
  {approved
   ?<div role="status" className="mt-3 text-sm">
     <p>Owner window recorded. Normal execution remains blocked pending release-binding verification.</p>
     <p>Approved cutoff: {effectiveCutoff?new Date(effectiveCutoff).toLocaleString():"Unavailable"}</p>
     <p>Authorization: {confirmed?.authorizationId??initial.authorizationId}</p>
    </div>
   :<div className="mt-3">
     <label className="block text-sm" htmlFor="mission79-cutoff">New execution cutoff (your local time)</label>
     <input id="mission79-cutoff" type="datetime-local" className="mt-1 rounded border px-3 py-2"
      value={cutoffInput} onChange={e=>setCutoffInput(e.target.value)} disabled={pending}/>
     <button type="button" className="mt-3 block min-h-11 rounded border px-3 py-2 font-semibold"
      disabled={pending||!cutoffInput} onClick={()=>void authorize()}>
      {pending?"Recording owner authorization…":"Approve new execution window"}</button>
    </div>}
  <button type="button" className="mt-3 min-h-11 rounded border px-3 py-2 text-sm"
   onClick={onRefresh} disabled={pending}>Refresh saved project status</button>
  {error&&<p role="alert" className="mt-2 text-sm">{error}</p>}
 </aside>;
}

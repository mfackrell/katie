"use client";
import {useState,useRef} from "react";
import {ownerSessionBearer} from "@/lib/tools/browser-owner-session";
import type {CodingCapacityOffer} from "@/lib/projects/coding-capacity-recovery";
export function CodingCapacityRecoveryControl({initial,onRefresh}:{initial:CodingCapacityOffer;onRefresh:()=>void}){
 const [selected,setSelected]=useState('');
 const [paid,setPaid]=useState(false);
 const [pending,setPending]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const [receipt,setReceipt]=useState<string|null>(null);
 const resumed=initial.historicalMissions!==96,identityRecovery=initial.historicalMissions===99;
 const submitting=useRef(false),count=resumed?3:Number(selected);
 const eligible=initial.stage==='authorize'&&!receipt&&!pending&&Number.isInteger(count)&&count>=1&&count<=8&&paid&&Date.now()<Date.parse(initial.cutoff)-300000;
 async function authorize(){
  if(!eligible||submitting.current)return;
  submitting.current=true;setPending(true);setError(null);
  try{
   const bearer=await ownerSessionBearer();if(!bearer)throw Error('Sign in as the verified Katie owner.');
   const authorizationId=crypto.randomUUID();
   const response=await fetch('/api/projects/organization',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},
    body:JSON.stringify({trialAction:'authorize_coding_capacity',projectId:initial.projectId,authorizationId,
     releaseSha:initial.releaseSha,releaseGeneration:initial.releaseGeneration,deploymentId:initial.deploymentId,scopeHash:initial.scopeHash,
     stateHash:initial.stateHash,cutoff:initial.cutoff,historicalMissions:initial.historicalMissions,additionalMissions:count,maxMissions:initial.historicalMissions+count,
     ...(resumed?{priorAuthorizationId:initial.priorAuthorizationId,sourceMissionId:initial.sourceMissionId,sourceAssignmentId:initial.sourceAssignmentId}:{}),
     paidInferenceLimit:count,paidInferenceConsent:true,retryLimit:0,tokenAllowance:600000,remainingRecordedTokens:initial.remainingRecordedTokens,
     additionalTokens:0,additionalSpendingAuthority:0})});
   const result=await response.json();
   if(!response.ok){if(response.status===409)onRefresh();throw Error(typeof result.error==='string'?result.error:'Owner recovery rejected');}
   if(result.stage!=='authorized'||result.authorizationId!==authorizationId||result.projectId!==initial.projectId
     ||result.releaseSha!==initial.releaseSha||result.releaseGeneration!==initial.releaseGeneration||result.deploymentId!==initial.deploymentId
     ||result.scopeHash!==initial.scopeHash||result.historicalMissions!==initial.historicalMissions||result.maxMissions!==initial.historicalMissions+count||result.additionalMissions!==count
     ||(resumed&&(result.priorAuthorizationId!==initial.priorAuthorizationId||result.sourceMissionId!==initial.sourceMissionId||result.sourceAssignmentId!==initial.sourceAssignmentId))
     ||result.paidInferenceLimit!==count||result.retryLimit!==0||result.tokenAllowance!==600000||result.status!=='running')
    throw Error('Owner receipt is not verified. Refresh without resubmitting.');
   setReceipt(authorizationId);onRefresh();
  }catch(e){setError(e instanceof Error?e.message:'Approval failed closed');}
  finally{setPending(false);submitting.current=false;}
 }
 return <aside aria-label="One-time coding commissioning recovery" className="mx-3 my-3 rounded-xl border border-white/20 p-4">
  <h3 className="font-semibold">{resumed?'Original Developer Orchestrator — Mission '+initial.historicalMissions+' three-mission recovery':'Original Developer Orchestrator — authorize coding commissioning'}</h3>
  <p className="mt-2 text-sm">Preserve all {initial.historicalMissions} consumed missions, original 13-node hierarchy and approved objective. {resumed?'The Delivery Manager will appoint workers, delegate scope to the committed coder, then commission one development package in three distinct turns. The prior failed management mission will not be retried.':'Continue through the existing Game Delivery director and manager to the first real development package.'} Stop at package creation, the selected mission ceiling, expiry or a failed assignment. No historical retry or automatic extension.</p>
  <ul className="mt-2 list-disc pl-5 text-sm">
   <li>Project: {initial.projectId}</li><li>Prior ceiling: {initial.priorMaxMissions}; historical missions: {initial.historicalMissions}</li>
   {resumed&&<><li>Preserved failed mission: {initial.sourceMissionId}; assignment: {initial.sourceAssignmentId}</li><li>{identityRecovery?'Mission 99 failure: duplicate agent identity (23505). Project Research is already assigned to the Repository Scope Analyst.':'Mission 98 failure: Grant only newly appointed direct workers their approved scope (P0001).'} Original paid call and failed attempt are retained.</li><li>Exactly three fresh missions and up to three paid management calls; ceiling {initial.priorMaxMissions} → {initial.historicalMissions+3} (two unused slots plus one new slot). Zero automatic retries. Prior approval is spent.</li></>}
   <li>Existing cutoff: {initial.cutoff} (UTC)</li>
   <li>Token ceiling unchanged: 600,000; recorded charged/reserved: {initial.recordedTokens.toLocaleString()}; recorded remaining: {initial.remainingRecordedTokens.toLocaleString()}. Provider-account usage is not represented by this project token ledger; actual remaining provider allowance is not verified.</li>
   <li>No additional token or spending ceiling; existing provider controls remain. Paid inference still incurs charges.</li>
   <li>Approved paths: {initial.paths.join(', ')}</li>
   <li>Release: {initial.releaseSha} · generation {initial.releaseGeneration} · {initial.deploymentId}</li>
   {initial.stage==='authorize'&&<li>Current decision evidence: {!resumed&&<>{initial.directorContextChars} / 48,000 (director), </>}{initial.managerContextChars} / 48,000 (manager).</li>}
  </ul>
  {initial.stage==='authorize'&&!receipt?<div className="mt-3 space-y-3">
   {!resumed&&<label className="block text-sm">Additional missions (select explicitly; four proven in isolated qualification)
    <select className="ml-2 rounded border p-1 text-black" value={selected} disabled={pending} onChange={e=>{setSelected(e.target.value);setPaid(false);}}>
     <option value="">Select allowance</option>
     {Array.from({length:8},(_,i)=>i+1).map(n=><option key={n} value={n}>{n}{n===4?' (qualified path)':''} — ceiling {96+n}</option>)}
    </select>
   </label>}
   <label className="block text-sm"><input type="checkbox" checked={paid} disabled={(!resumed&&!selected)||pending} onChange={e=>setPaid(e.target.checked)}/> {resumed?'I explicitly approve increasing the total mission ceiling from '+initial.priorMaxMissions+' to '+(initial.historicalMissions+3)+', three fresh management missions and up to three additional paid inference calls.':'I explicitly authorize up to '+(selected||'the selected number of')+' additional paid management inference calls,'} At most one per new mission, under the existing provider controls. Zero retries. No additional token, spending, deadline or scope authority. No paid coding dispatch after package creation.</label>
   <button type="button" className="min-h-11 rounded border px-3 py-2 font-semibold disabled:opacity-50" disabled={!eligible} onClick={()=>void authorize()}>
    {pending?'Recording signed approval…':resumed?'Authorize three commissioning missions (ceiling '+(initial.historicalMissions+3)+')':'Authorize bounded coding commissioning'}
   </button>
  </div>:<div className="mt-3 text-sm" role="status">Owner approval: {receipt??initial.authorizationId}; {initial.maxMissions?'approved ceiling '+initial.maxMissions+'; remaining '+initial.remainingMissions+'; ':''}status {initial.status}. {initial.packageId?'Queued development package: '+initial.packageId+'; further execution stopped.':''}</div>}
  <button type="button" className="mt-3 min-h-11 rounded border px-3 py-2 text-sm" disabled={pending} onClick={onRefresh}>Refresh commissioning recovery</button>
  {error&&<p role="alert" className="mt-2 text-sm">{error}</p>}
 </aside>;
}

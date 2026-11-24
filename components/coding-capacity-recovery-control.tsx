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
 const submitting=useRef(false),count=Number(selected);
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
     stateHash:initial.stateHash,cutoff:initial.cutoff,historicalMissions:96,additionalMissions:count,maxMissions:96+count,
     paidInferenceLimit:count,paidInferenceConsent:true,retryLimit:0,tokenAllowance:600000,remainingRecordedTokens:initial.remainingRecordedTokens,
     additionalTokens:0,additionalSpendingAuthority:0})});
   const result=await response.json();
   if(!response.ok){if(response.status===409)onRefresh();throw Error(typeof result.error==='string'?result.error:'Owner recovery rejected');}
   if(result.stage!=='authorized'||result.authorizationId!==authorizationId||result.projectId!==initial.projectId
     ||result.releaseSha!==initial.releaseSha||result.releaseGeneration!==initial.releaseGeneration||result.deploymentId!==initial.deploymentId
     ||result.scopeHash!==initial.scopeHash||result.historicalMissions!==96||result.maxMissions!==96+count||result.additionalMissions!==count
     ||result.paidInferenceLimit!==count||result.retryLimit!==0||result.tokenAllowance!==600000||result.status!=='running')
    throw Error('Owner receipt is not verified. Refresh without resubmitting.');
   setReceipt(authorizationId);onRefresh();
  }catch(e){setError(e instanceof Error?e.message:'Approval failed closed');}
  finally{setPending(false);submitting.current=false;}
 }
 return <aside aria-label="One-time coding commissioning recovery" className="mx-3 my-3 rounded-xl border border-white/20 p-4">
  <h3 className="font-semibold">Original Developer Orchestrator — authorize coding commissioning</h3>
  <p className="mt-2 text-sm">Preserve all 96 consumed missions, original 13-node hierarchy and approved objective. Continue through the existing Game Delivery director and manager to the first real development package. Stop at package creation, the selected mission ceiling, expiry or a failed assignment. No historical retry or automatic extension.</p>
  <ul className="mt-2 list-disc pl-5 text-sm">
   <li>Project: {initial.projectId}</li><li>Prior ceiling: 96; historical missions: 96</li>
   <li>Existing cutoff: {initial.cutoff} (UTC)</li>
   <li>Token ceiling unchanged: 600,000; recorded charged/reserved: {initial.recordedTokens.toLocaleString()}; recorded remaining: {initial.remainingRecordedTokens.toLocaleString()}. Provider-account usage is not represented by this project token ledger; actual remaining provider allowance is not verified.</li>
   <li>No additional token or spending ceiling; existing provider controls remain. Paid inference still incurs charges.</li>
   <li>Approved paths: {initial.paths.join(', ')}</li>
   <li>Release: {initial.releaseSha} · generation {initial.releaseGeneration} · {initial.deploymentId}</li>
   {initial.stage==='authorize'&&<li>Current decision evidence: {initial.directorContextChars} / 48,000 (director), {initial.managerContextChars} / 48,000 (manager).</li>}
  </ul>
  {initial.stage==='authorize'&&!receipt?<div className="mt-3 space-y-3">
   <label className="block text-sm">Additional missions (select explicitly; four proven in isolated qualification)
    <select className="ml-2 rounded border p-1 text-black" value={selected} disabled={pending} onChange={e=>{setSelected(e.target.value);setPaid(false);}}>
     <option value="">Select allowance</option>
     {Array.from({length:8},(_,i)=>i+1).map(n=><option key={n} value={n}>{n}{n===4?' (qualified path)':''} — ceiling {96+n}</option>)}
    </select>
   </label>
   <label className="block text-sm"><input type="checkbox" checked={paid} disabled={!selected||pending} onChange={e=>setPaid(e.target.checked)}/> I explicitly authorize up to {selected||'the selected number of'} additional paid management inference calls, at most one per new mission, under the existing provider controls. Zero retries. No paid coding dispatch after package creation.</label>
   <button type="button" className="min-h-11 rounded border px-3 py-2 font-semibold disabled:opacity-50" disabled={!eligible} onClick={()=>void authorize()}>
    {pending?'Recording signed approval…':'Authorize bounded coding commissioning'}
   </button>
  </div>:<div className="mt-3 text-sm" role="status">Owner approval: {receipt??initial.authorizationId}; {initial.maxMissions?'approved ceiling '+initial.maxMissions+'; remaining '+initial.remainingMissions+'; ':''}status {initial.status}. {initial.packageId?'Queued development package: '+initial.packageId+'; further execution stopped.':''}</div>}
  <button type="button" className="mt-3 min-h-11 rounded border px-3 py-2 text-sm" disabled={pending} onClick={onRefresh}>Refresh commissioning recovery</button>
  {error&&<p role="alert" className="mt-2 text-sm">{error}</p>}
 </aside>;
}

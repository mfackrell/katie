'use client';

import {useCallback,useEffect,useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';

const ORIGINAL_CHAT='e53defeb-16eb-457e-aa07-435141165ee8';
type Proposal={
 projectId:string;historicalTokens:number;historicalCalls:number;
 incrementalTokens:number;incrementalCalls:number;
 incrementalDollarCeilingMicrousd:number;
 assessReserveTokens:number;completionReserveTokens:number;
 assessReserveCalls:number;completionReserveCalls:number;
 durationSeconds:number;models:string[];pricingEvidence:unknown[];
 scopeApprovalStillRequired:boolean;noProductionRelease:boolean;
};
type ResponseBody={
 chatId?:string;status?:string;
 continuation?:{ready:boolean;digest?:string;proposal?:Proposal;reason?:string}|null;
 error?:string;
};
export function Task4aContinuationOwnerApproval({chatId}:{chatId:string}){
 const [state,setState]=useState<ResponseBody|null>(null);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const eligible=chatId===ORIGINAL_CHAT;
 const refresh=useCallback(async()=>{
  if(!eligible)return;
  const bearer=await ownerSessionBearer();
  if(!bearer){setState({error:'Owner sign-in required'});return;}
  try{
   const response=await fetch('/api/projects/task4a-continuation',{
    headers:{Authorization:'Bearer '+bearer},cache:'no-store'
   });
   const payload=await response.json() as ResponseBody;
   setState(response.ok?payload:{error:payload.error??'Owner continuation unavailable'});
  }catch{setState({error:'Task 4A continuation status unavailable'});}
 },[eligible]);
 useEffect(()=>{void refresh();},[refresh]);
 const consent=state?.continuation;
 if(!eligible||!consent||!consent.ready||!consent.proposal||!consent.digest)return null;
 const p=consent.proposal;
 const approve=async()=>{
  if(loading)return;
  setLoading(true);setError(null);
  try{
   const bearer=await ownerSessionBearer();
   if(!bearer)throw Error('Sign in as the Katie owner before approving spending.');
   const response=await fetch('/api/projects/task4a-continuation',{
    method:'POST',headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},
    body:JSON.stringify({approve:true,proposalDigest:consent.digest})
   });
   const body=await response.json() as {accepted?:boolean;error?:string};
   if(!response.ok||body.accepted!==true)throw Error(body.error??'Authorization was not accepted.');
   await refresh();
  }catch(e){setError(e instanceof Error?e.message:'Owner authorization failed.');}
  finally{setLoading(false);}
 };
 return <section aria-label="Task 4A original project continuation authorization" className="rounded-xl border p-4 text-sm space-y-2">
  <h3 className="font-semibold">Task 4A — one owner approval for the saved project</h3>
  <p>Original project: <code>{p.projectId}</code>. Previously consumed: {p.historicalTokens.toLocaleString()} tokens, {p.historicalCalls} calls. Nothing is reset or billed again.</p>
  <p>Additional authorization: <strong>{p.incrementalTokens.toLocaleString()} tokens</strong>, at most <strong>{p.incrementalCalls} calls</strong>, and at most <strong>{'$'+(p.incrementalDollarCeilingMicrousd/1_000_000).toFixed(2)}</strong> over {p.durationSeconds/3600} hours.</p>
  <p>Protected: {p.assessReserveTokens.toLocaleString()} assessment tokens, {p.completionReserveTokens.toLocaleString()} completion tokens, {p.assessReserveCalls+p.completionReserveCalls} reserved calls.</p>
  <p>Permitted model IDs: {p.models.join(', ')}. Models without freshly verified source pricing cannot execute.</p>
  <p className="text-xs opacity-70">Authorizes recovery of the existing expired research, then scoped planning and independent checks. Coding scope still needs its separate exact-specification approval. No production publication.</p>
  {error?<p role="alert">{error}</p>:null}
  <button type="button" disabled={loading} onClick={()=>{void approve();}} className="rounded-md border px-3 py-2 font-semibold disabled:opacity-50">
   {loading?'Authorizing…':'Approve this exact bounded continuation'}
  </button>
 </section>;
}

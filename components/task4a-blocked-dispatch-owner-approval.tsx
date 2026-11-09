'use client';
import {useCallback,useEffect,useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';

const CHAT='e53defeb-16eb-457e-aa07-435141165ee8';
type Limits={deadline:string;tokens:number;calls:number;dollarsCents:number};
type Proposal={
 newDeadline:string;incrementalTokens:number;incrementalCalls:number;incrementalMicrousd:number;
 previousContinuationId:string;previousNativeApprovalId:string;originalFailedClaimId:string;
 productionReleaseSha:string;nativeLimits:{cumulativeTokens:number;ceilingMicrousd:number};
};
type Offer={ready?:boolean;digest?:string;proposal?:Proposal;reason?:string;error?:string;
 alreadyAuthorized?:boolean;receiptId?:string;newContinuationId?:string;newNativeApprovalId?:string;
 readyForOwnerProposal?:boolean;productionSha?:string};
type Draft={limits:Limits;digest:string;proposal:Proposal};
const endpoint='/api/projects/task4a-blocked-dispatch';
export function Task4aBlockedDispatchOwnerApproval({chatId}:{chatId:string}){
 const enabled=chatId===CHAT;
 const [state,setState]=useState<Offer|null>(null);
 const [hours,setHours]=useState('4'),[tokens,setTokens]=useState('240000');
 const [calls,setCalls]=useState('24'),[dollars,setDollars]=useState('9.00');
 const [draft,setDraft]=useState<Draft|null>(null);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const refresh=useCallback(async()=>{
  if(!enabled)return;
  const token=await ownerSessionBearer();if(!token)return;
  try{
   const r=await fetch(endpoint,{headers:{Authorization:'Bearer '+token},cache:'no-store'});
   const o=await r.json() as Offer;
   if(r.ok)setState(o);
  }catch{/* Original state is never inferred from a failed read. */}
 },[enabled]);
 useEffect(()=>{void refresh();},[refresh]);
 const clear=()=>{setDraft(null);setMessage('');};
 if(!enabled||!state)return null;
 const submit=async(action:'propose'|'approve')=>{
  if(busy)return;
  let limits:Limits;
  if(action==='approve'){
   if(!draft)return;
   limits=draft.limits;
  }else{
   const h=Number(hours),t=Number(tokens),c=Number(calls),usd=Number(dollars);
   if(!Number.isInteger(h)||h<1||h>48||
      !Number.isSafeInteger(t)||t<180000||t>240000||
      !Number.isSafeInteger(c)||c<20||c>24||
      !Number.isFinite(usd)||usd<2.52||usd>9||
      Math.abs(Math.round(usd*100)-usd*100)>0.00001){
    setMessage('Enter 1–48 hours, 180,000–240,000 tokens, 20–24 calls, and $2.52–$9.00.');
    return;
   }
   limits={deadline:new Date(Date.now()+h*3600000).toISOString(),
    tokens:t,calls:c,dollarsCents:Math.round(usd*100)};
  }
  setBusy(true);setMessage('');
  try{
   const token=await ownerSessionBearer();if(!token)throw Error('Original owner sign-in required.');
   const body=action==='propose'?{action,limits}:{action,limits,digest:draft?.digest};
   const response=await fetch(endpoint,{
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify(body),cache:'no-store'
   });
   const result=await response.json() as Offer&{accepted?:boolean};
   if(!response.ok)throw Error(result.reason??result.error??'Exact owner proposal rejected');
   if(action==='propose'){
    if(!result.ready||!result.digest||!result.proposal)throw Error('No valid owner proposal available');
    setDraft({limits,digest:result.digest,proposal:result.proposal});
   }else{
    if(!result.accepted||!result.receiptId)throw Error('Owner recovery receipt not committed');
    setDraft(null);
    setMessage('Deadline and authority consent saved. Paid execution and workflow dispatch are NOT approved.');
    await refresh();
   }
  }catch(e){setMessage(e instanceof Error?e.message:'Owner recovery unavailable');if(action==='approve')setDraft(null);}
  finally{setBusy(false);}
 };
 if(state.alreadyAuthorized)return <section aria-label="Task 4A blocked-dispatch owner recovery" className="rounded-xl border p-4 text-sm space-y-2">
  <h3 className="font-semibold">Task 4A — owner-governed recovery</h3>
  <p>Owner deadline and authority approval recorded: <code className="break-all">{state.receiptId}</code>.</p>
  <p>Separate signed consent is required before the original GitHub dispatch can start paid inference.</p>
  {message?<p role="status">{message}</p>:null}
 </section>;
 return <section aria-label="Task 4A blocked-dispatch owner recovery" className="rounded-xl border p-4 text-sm space-y-3">
  <h3 className="font-semibold">Task 4A — Restore the original blocked dispatch</h3>
  <p>Original project, mission, task and GitHub issue #969 are retained. The old deadline and spending approvals remain historical. This decision issues a bounded successor and restores the waiting assignment but <strong>does not dispatch or bill</strong>.</p>
  <p>Original native account: 180,000 tokens, maximum $2.52, previously unspent. New continuation must stay within the expired 240,000-token, 24-call, $9.00 ceiling. These are ceilings, not commitments.</p>
  <div className="grid grid-cols-2 gap-3">
   <label className="space-y-1">Additional hours (1–48)<input aria-label="New deadline in hours" type="number" min="1" max="48" step="1" value={hours} onChange={e=>{setHours(e.target.value);clear();}} className="w-full rounded-md border p-2 text-base"/></label>
   <label className="space-y-1">Token ceiling<input aria-label="Continuation token ceiling" type="number" min="180000" max="240000" value={tokens} onChange={e=>{setTokens(e.target.value);clear();}} className="w-full rounded-md border p-2 text-base"/></label>
   <label className="space-y-1">Call ceiling<input aria-label="Continuation call ceiling" type="number" min="20" max="24" value={calls} onChange={e=>{setCalls(e.target.value);clear();}} className="w-full rounded-md border p-2 text-base"/></label>
   <label className="space-y-1">USD ceiling<input aria-label="Continuation dollar ceiling" type="number" min="2.52" max="9" step="0.01" value={dollars} onChange={e=>{setDollars(e.target.value);clear();}} className="w-full rounded-md border p-2 text-base"/></label>
  </div>
  <button type="button" disabled={busy} onClick={()=>{void submit('propose');}} className="rounded-md border px-3 py-2 font-semibold disabled:opacity-50">{busy?'Checking…':'Preview exact renewal (no charges)'}</button>
  {draft?<div className="space-y-2">
   <p><strong>Exact owner decision:</strong> deadline {new Date(draft.proposal.newDeadline).toLocaleString()}, {draft.proposal.incrementalTokens.toLocaleString()} tokens, {draft.proposal.incrementalCalls} calls, {'$'}{(draft.proposal.incrementalMicrousd/1000000).toFixed(2)} ceiling.</p>
   <p>Original claim <code className="break-all">{draft.proposal.originalFailedClaimId}</code> remains immutable. One new authority chain will be recorded. GitHub dispatch and paid inference still require another explicit approval.</p>
   <p className="break-all text-xs opacity-80">SHA-256 owner decision: {draft.digest}</p>
   <button type="button" disabled={busy} onClick={()=>{void submit('approve');}} className="rounded-md border px-3 py-2 font-semibold disabled:opacity-50">{busy?'Recording…':'Approve exact deadline and renewed authority'}</button>
  </div>:null}
  {message?<p role="status" className="break-words">{message}</p>:null}
 </section>;
}

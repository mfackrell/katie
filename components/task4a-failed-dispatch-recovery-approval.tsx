'use client';
import {useCallback,useEffect,useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';

const CHAT='e53defeb-16eb-457e-aa07-435141165ee8';
type Offer={ready?:boolean;reason?:string;digest?:string;proposal?:{
 issueNumber:number;model:string;approvalId:string;continuationId:string;
 originalClaimId:string;expiresAt:string;nativeLimits:{
 cumulativeTokens:number;developmentCalls:number;assessmentCalls:number;
 completionCalls:number;ceilingMicrousd:number;
 }};alreadyAuthorized?:boolean;ownerAuthorizationReceiptId?:string|null;
 claimReceiptId?:string|null;githubAcceptedReceiptId?:string|null;error?:string};
export function Task4aFailedDispatchRecoveryApproval({chatId}:{chatId:string}){
 const enabled=chatId===CHAT;
 const [offer,setOffer]=useState<Offer|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const refresh=useCallback(async()=>{
  if(!enabled)return;
  const token=await ownerSessionBearer();if(!token)return;
  try{
   const res=await fetch('/api/projects/task4a-failed-dispatch',{
    headers:{Authorization:'Bearer '+token},cache:'no-store'});
   const data=await res.json() as Offer;
   setOffer(data.alreadyAuthorized||res.ok?data:null);
  }catch{setOffer(null);}
 },[enabled]);
 useEffect(()=>{void refresh();},[refresh]);
 if(!enabled||(!offer?.ready&&!offer?.alreadyAuthorized&&!message))return null;
 const approve=async()=>{
  if(!offer?.digest||busy)return;
  setBusy(true);setMessage('');
  try{
   const token=await ownerSessionBearer();
   if(!token)throw Error('Original owner sign-in required');
   const response=await fetch('/api/projects/task4a-failed-dispatch',{
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({confirm:true,digest:offer.digest})
   });
   const data=await response.json() as {accepted?:boolean;dispatchAccepted?:boolean;dispatchStatus?:string;error?:string};
   if(!response.ok||!data.accepted)throw Error(data.error??'Exact owner consent rejected');
   setMessage(data.dispatchAccepted
    ?'GitHub accepted one original issue #969 workflow dispatch. Development and protected Preview acceptance remain pending.'
    :'Owner consent saved. Dispatch not yet confirmed; the original claim is preserved. No automatic retry is permitted if GitHub acceptance is uncertain.');
   await refresh();
  }catch(e){setMessage(e instanceof Error?e.message:'Recovery unavailable');}
  finally{setBusy(false);}
 };
 const p=offer?.proposal;
 return <section aria-label="Task 4A original claimed dispatch recovery" className="rounded-xl border p-4 text-sm space-y-3">
  <h3 className="font-semibold">Task 4A — Recover original failed GitHub dispatch</h3>
  {offer?.alreadyAuthorized?<p role="status" className="break-words">
   Owner consent recorded: {offer.ownerAuthorizationReceiptId}.
   {offer.githubAcceptedReceiptId?' GitHub dispatch acceptance receipt: '+offer.githubAcceptedReceiptId:
    offer.claimReceiptId?' Recovery claimed; GitHub acceptance must be reconciled before any retry.':
    ' Awaiting the one authorized native workflow dispatch.'}</p>:null}
  {p&&offer?.ready&&!offer?.alreadyAuthorized?<div className="space-y-2">
   <p>Original issue <strong>#{p.issueNumber}</strong>; signed Task 4A account and model <strong>{p.model}</strong>.
    The failed historical claim stays immutable. This permits only ONE replacement workflow dispatch through Katie, not another project or authorization.</p>
   <p>Existing native ceiling: <strong>{p.nativeLimits.cumulativeTokens.toLocaleString()} tokens</strong>,
    {p.nativeLimits.developmentCalls} development calls, {p.nativeLimits.assessmentCalls} assessment calls,
    {p.nativeLimits.completionCalls} completion calls, and
    <strong> {'$'+(p.nativeLimits.ceilingMicrousd/1_000_000).toFixed(2)} maximum</strong>.
    Expires by {new Date(p.expiresAt).toLocaleString()}.</p>
   <p><strong>Paid-execution decision:</strong> the single recovered GitHub workflow may start billable inference
    within these existing limits. No new financial grant or larger budget is created. The application can only be released to protected Preview.</p>
   <p className="break-all text-xs opacity-80">Exact SHA-256 owner proposal: {offer.digest}</p>
   <button type="button" disabled={busy} className="rounded-md border px-3 py-2 font-semibold disabled:opacity-50"
    onClick={()=>{void approve();}}>{busy?'Verifying…':'Authorize ONE recovered dispatch and bounded paid execution'}</button>
  </div>:null}
  {message?<p role="status" className="break-words whitespace-normal">{message}</p>:null}
 </section>;
}

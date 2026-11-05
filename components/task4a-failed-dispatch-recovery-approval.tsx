'use client';
import {useCallback,useEffect,useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';

const CHAT='e53defeb-16eb-457e-aa07-435141165ee8';
type Action='approveRecovery'|'approvePaidExecution';
type Offer={ready?:boolean;reason?:string;digest?:string;nextAction?:Action;proposal?:{
 issueNumber:number;model:string;approvalId:string;continuationId:string;
 originalClaimId:string;recoveryReceiptId?:string;recoveryDigest?:string;
 expiresAt:string;nativeLimits:{
 cumulativeTokens:number;developmentCalls:number;assessmentCalls:number;
 completionCalls:number;ceilingMicrousd:number;
 }};alreadyPaidAuthorized?:boolean;ownerAuthorizationReceiptId?:string|null;
 paidExecutionReceiptId?:string|null;claimReceiptId?:string|null;
 githubAcceptedReceiptId?:string|null;error?:string};
const endpoint='/api/projects/task4a-failed-dispatch';
export function Task4aFailedDispatchRecoveryApproval({chatId}:{chatId:string}){
 const enabled=chatId===CHAT;
 const [offer,setOffer]=useState<Offer|null>(null);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const refresh=useCallback(async()=>{
  if(!enabled)return;
  const token=await ownerSessionBearer();if(!token)return;
  try{
   const res=await fetch(endpoint,{headers:{Authorization:'Bearer '+token},cache:'no-store'});
   const data=await res.json() as Offer;
   setOffer(res.ok?data:null);
  }catch{setOffer(null);}
 },[enabled]);
 useEffect(()=>{void refresh();},[refresh]);
 if(!enabled||(!offer?.ready&&!offer?.alreadyPaidAuthorized&&!message))return null;
 const approve=async(action:Action)=>{
  if(!offer?.digest||offer.nextAction!==action||busy)return;
  setBusy(true);setMessage('');
  try{
   const token=await ownerSessionBearer();
   if(!token)throw Error('Original owner sign-in required');
   const response=await fetch(endpoint,{
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({action,confirm:true,digest:offer.digest}),cache:'no-store'
   });
   const data=await response.json() as {accepted?:boolean;phase?:string;
    dispatched?:boolean;dispatchAccepted?:boolean;dispatchStatus?:string;error?:string};
   if(!response.ok||!data.accepted)throw Error(data.error??'Exact owner decision rejected');
   if(action==='approveRecovery'){
    if(data.phase!=='recovery'||data.dispatched!==false)
     throw Error('Recovery-only receipt not independently verified');
    setMessage('Recovery approved and recorded. No dispatch, execution grant or paid call created. A SECOND owner decision is required below.');
   }else{
    if(data.phase!=='paidExecution')throw Error('Separate paid consent receipt unavailable');
    setMessage(data.dispatchAccepted
     ?'Paid execution separately authorized. GitHub accepted ONE original issue #969 dispatch; protected Preview acceptance is still pending.'
     :data.dispatchStatus==='dispatch_status_uncertain_reconcile_claim_and_github_runs'
     ?'Paid approval recorded; GitHub acceptance uncertain. Reconcile the saved claim and GitHub runs. No automatic retry.'
     :'Paid approval recorded. Native dispatch is pending; no acceptance or paid inference is assumed.');
   }
   await refresh();
  }catch(e){setMessage(e instanceof Error?e.message:'Authorization unavailable');await refresh();}
  finally{setBusy(false);}
 };
 const p=offer?.proposal,action=offer?.nextAction;
 return <section aria-label="Task 4A separate recovery and paid-execution authorizations" className="rounded-xl border p-4 text-sm space-y-3">
  <h3 className="font-semibold">Task 4A — two independent owner decisions</h3>
  {offer?.ownerAuthorizationReceiptId?<p className="break-words">
   Recovery-only receipt: <code>{offer.ownerAuthorizationReceiptId}</code>.
   This receipt cannot dispatch a workflow or create paid execution authority.</p>:null}
  {offer?.paidExecutionReceiptId?<p className="break-words" role="status">
   Separately authorized bounded paid execution: <code>{offer.paidExecutionReceiptId}</code>.
   {offer.githubAcceptedReceiptId?' GitHub accepted dispatch: '+offer.githubAcceptedReceiptId:
    offer.claimReceiptId?' Dispatch claimed; external acceptance requires reconciliation.':
    ' Native dispatch not confirmed; do not infer execution.'}</p>:null}
  {p&&offer?.ready&&action?<div className="space-y-2">
   <p>Original signed issue <strong>#{p.issueNumber}</strong>, model <strong>{p.model}</strong>.
    Original failed claim and historical accounting are preserved.</p>
   <p>Unchanged native ceiling: <strong>{p.nativeLimits.cumulativeTokens.toLocaleString()} tokens</strong>,
    {p.nativeLimits.developmentCalls} development calls, {p.nativeLimits.assessmentCalls} assessment calls,
    {p.nativeLimits.completionCalls} completion calls,
    <strong>{' $'+(p.nativeLimits.ceilingMicrousd/1_000_000).toFixed(2)}</strong>.
    Authority expires {new Date(p.expiresAt).toLocaleString()}.</p>
   {action==='approveRecovery'?<>
    <p><strong>Decision 1 — recovery only.</strong> Records one-time failed-dispatch recovery consent.
     No GitHub workflow, paid inference, execution grant or additional spending authority starts.</p>
    <p className="break-all text-xs opacity-80">Recovery digest: {offer.digest}</p>
    <button type="button" disabled={busy} className="rounded-md border px-3 py-2 font-semibold disabled:opacity-50"
     onClick={()=>{void approve('approveRecovery');}}>
     {busy?'Recording…':'Approve failed-dispatch recovery ONLY (no execution)'}
    </button>
   </>:<>
    <p><strong>Decision 2 — bounded paid execution.</strong> This is independent of recovery approval.
     It permits exactly ONE signed GitHub workflow dispatch that may incur paid inference
     under the unchanged existing account, with live deadline, model-pricing and capacity checks.
     Publishing is limited to protected Preview.</p>
    <p className="break-all text-xs opacity-80">Independent paid-execution digest: {offer.digest}</p>
    <button type="button" disabled={busy} className="rounded-md border px-3 py-2 font-semibold disabled:opacity-50"
     onClick={()=>{void approve('approvePaidExecution');}}>
     {busy?'Verifying…':'Separately authorize bounded PAID development and one dispatch'}
    </button>
   </>}
  </div>:null}
  {message?<p role="status" className="break-words whitespace-normal">{message}</p>:null}
 </section>;
}

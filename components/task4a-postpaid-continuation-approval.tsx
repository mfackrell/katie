'use client';
import {useCallback,useEffect,useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';

const CHAT='e53defeb-16eb-457e-aa07-435141165ee8';
const endpoint='/api/projects/task4a-postpaid-continuation';
type Status={state?:string;ready?:boolean;reason?:string;error?:string;
 digest?:string;proposal?:Record<string,unknown>;evidence?:Record<string,unknown>;
 nextAction?:'approveRedispatch'|'approvePaidInference';authorityReceiptId?:string;
 redispatchReceiptId?:string;paidReceiptId?:string;claimReceiptId?:string;
 submittedReceiptId?:string;checkpointSha?:string};
type Limits={cumulativeTokens:number;developmentTokens:number;assessmentTokens:60000;
 completionTokens:60000;developmentCalls:number;assessmentCalls:4;completionCalls:4;
 perCallMicrousd:1680000;ceilingMicrousd:number;durationSeconds:number};
type Reply={accepted?:boolean;ready?:boolean;digest?:string;proposal?:Record<string,unknown>;
 error?:string;reason?:string;dispatchStatus?:string;dispatchAccepted?:boolean};
// Previously agreed Task 4A ceiling, NOT a payment or dispatch authorization.
// The authenticated server recomputes a fresh, evidence-bound quote and digest.
const REQUESTED_LIMITS:Limits={
 cumulativeTokens:289620,developmentTokens:229620,developmentCalls:16,
 assessmentTokens:60000,completionTokens:60000,assessmentCalls:4,completionCalls:4,
 perCallMicrousd:1680000,ceilingMicrousd:9000000,durationSeconds:14400
};
const quoteMatchesRequestedLimits=(proposal:Record<string,unknown>|undefined)=>{
 const actual=proposal?.nativeLimits;
 if(!actual||typeof actual!=='object'||Array.isArray(actual))return false;
 return (Object.keys(REQUESTED_LIMITS) as (keyof Limits)[]).every(
  key=>(actual as Record<string,unknown>)[key]===REQUESTED_LIMITS[key]);
};
export function Task4aPostpaidContinuationApproval({chatId}:{chatId:string}){
 const enabled=chatId===CHAT;
 const [status,setStatus]=useState<Status|null>(null),[quote,setQuote]=useState<Reply|null>(null);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const refresh=useCallback(async(clearPriorError=false)=>{
  if(!enabled)return;
  // A user-triggered refresh clears stale approval errors even if the prior
  // request failed before any receipt was written. It never replays a consent.
  if(clearPriorError)setMessage('');
  const token=await ownerSessionBearer();
  if(!token){setStatus({state:'owner_sign_in_required',reason:'Sign in as original owner to authorize Task 4A.'});setQuote(null);return;}
  try{
   const result=await fetch(endpoint+'?chatId='+CHAT,{
    headers:{Authorization:'Bearer '+token},cache:'no-store',signal:AbortSignal.timeout(20000)});
   const data=await result.json() as Status;
   if(!result.ok)throw Error(data.error??'Original owner evidence unavailable');
   setStatus(data);
   setQuote(null);
   // Prepare the established limits automatically. PREVIEW ONLY: no owner consent,
   // paid API call, GitHub dispatch or new financial authority can occur here.
   if(!data.authorityReceiptId&&data.state==='requires_owner_limits'&&
      data.reason==='explicit_owner_limits_required'){
    const previewResponse=await fetch(endpoint,{method:'POST',cache:'no-store',
     headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
     body:JSON.stringify({action:'previewAuthority',limits:REQUESTED_LIMITS}),
     signal:AbortSignal.timeout(25000)});
    const preview=await previewResponse.json() as Reply;
    if(!previewResponse.ok||!preview.ready||!preview.digest||
       !quoteMatchesRequestedLimits(preview.proposal))
     throw Error(preview.error??preview.reason??'Exact preapproved limits could not be quoted safely');
    setQuote(preview);
   }
  }catch(error){
   setQuote(null);
   setStatus({state:'evidence_required',error:error instanceof Error?error.message:'Owner evidence lookup unavailable'});
  }
 },[enabled]);
 useEffect(()=>{void refresh();},[refresh]);
 const numbers=():Limits=>REQUESTED_LIMITS;
 const submit=async(action:'previewAuthority'|'approveAuthority'|'approveRedispatch'|'approvePaidInference')=>{
  if(busy)return;
  setBusy(true);setMessage('');
  try{
   const token=await ownerSessionBearer();if(!token)throw Error('Original owner sign-in required');
   const isAuthority=action==='previewAuthority'||action==='approveAuthority';
   const body=isAuthority?{action,limits:numbers(),
    ...(action==='approveAuthority'?{confirm:true,digest:quote?.digest}:{} )
   }:{action,confirm:true,digest:status?.digest};
   if(isAuthority&&action==='approveAuthority'&&!quote?.digest)
    throw Error('Preview and review an exact immutable proposal first.');
   const response=await fetch(endpoint,{method:'POST',cache:'no-store',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
   const data=await response.json() as Reply;
   if(!response.ok)throw Error(data.error??data.reason??'Authorization denied');
   if(action==='previewAuthority'){
    if(!data.ready||!data.digest)throw Error('Exact proposal was not generated.');
    setQuote(data);setMessage('Proposal generated, not authorized. Review the exact limits and digest below.');
   }else{
    if(!data.accepted)throw Error('The decision was not committed.');
    setQuote(null);
    setMessage(action==='approveAuthority'
     ?'Continuation approved. No dispatch or paid inference is authorized. Review separate redispatch consent.'
     :action==='approveRedispatch'
     ?'Redispatch-only consent recorded. No paid inference or GitHub dispatch occurred.'
     :data.dispatchAccepted
     ?'Separate paid consent recorded and one original issue #969 dispatch accepted. Protected Preview acceptance remains pending.'
     :data.dispatchStatus==='github_status_uncertain_one_shot_claim_must_be_reconciled'
     ?'Paid consent recorded; GitHub acceptance uncertain. The one-shot claim must be reconciled, not retried.'
     :'Paid consent recorded; dispatch not confirmed. Never infer acceptance or retry without reconciliation.');
    await refresh();
   }
  }catch(e){setMessage(e instanceof Error?e.message:'Owner decision could not be verified.');await refresh();}
  finally{setBusy(false);}
 };
 if(!enabled||!status||status.state==='not_for_this_chat')return null;
 return <section aria-label="Task 4A postpaid same-task continuation" className="my-3 rounded-xl border p-4 text-sm space-y-3">
  <h3 className="font-semibold">Task 4A — continue the original task after paid inference</h3>
  <p>Original issue <strong>#969</strong>. Checkpoint <code className="break-all">8e53ce016933</code>.
   Four settled calls and 49,620 tokens remain historical charges. No new project or duplicate run is permitted.</p>
  {status.state==='claimed_once'?<p role="status">Original dispatch was already claimed.
   {status.submittedReceiptId?' GitHub acceptance is recorded.':' External acceptance requires reconciliation.'}
   No automatic retry is permitted.</p>:null}
  {!status.authorityReceiptId?<div className="space-y-2">
   <p>Before a new owner approval, **both protected token reserves remain 60,000 each**.
    Native protected calls stay 4 assessment / 4 completion; project-level reserves stay 6 / 6.</p>
   <p>Confirmed next-call shortfall: <strong>11,484 tokens</strong>.
    Additional native call minimum: <strong>4</strong>. Future development, review, repair,
    completion and Preview costs and duration are not yet estimable. The limits below are ceilings, not forecasts.</p>
   <div className="rounded-lg border p-3 space-y-1" aria-label="Katie-prepared exact continuation limits">
    <p className="font-semibold">Katie-prepared limits — no data entry</p>
    <p><strong>240,000 additional tokens</strong> (289,620 cumulative including 49,620 already consumed)</p>
    <p>Development tokens including completion: <strong>229,620</strong>; development calls: <strong>16</strong></p>
    <p>Cumulative spending ceiling: <strong>$9.00</strong>; execution window: <strong>4 hours from consent</strong></p>
    <p>Protected assessment and completion reserves: <strong>60,000 tokens each</strong> (4 native calls each)</p>
    <p className="text-xs">These are maximum authorizations, not cost or completion forecasts. No authority is created until you explicitly approve.</p>
   </div>
   {status.reason&&status.reason!=='explicit_owner_limits_required'?<p role="status">Preflight: {status.reason}.</p>:null}
   {status.error?<p role="alert">{status.error}</p>:null}
   {quote?.ready&&quote.digest?<div className="space-y-2">
    <p role="status">Katie verified the exact limits and saved work. This is a read-only quote, not an authorization.</p>
    <details><summary>Owner consent digest</summary><code className="break-all">{quote.digest}</code></details>
    <details><summary>Review the complete evidence-bound authority</summary>
     <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(quote.proposal,null,2)}</pre></details>
    <button type="button" disabled={busy} className="rounded border px-3 py-2 font-semibold"
     onClick={()=>void submit('approveAuthority')}>Authorize these exact limits — NO dispatch or paid inference</button>
   </div>:null}
  </div>:<div className="space-y-2">
    <p>Successor owner receipt: <code className="break-all">{status.authorityReceiptId}</code>.
     The original task stays blocked until the next two independent owner decisions.</p>
    {status.ready&&status.digest&&status.nextAction?<div className="space-y-2">
     <p>Consent digest: <code className="break-all">{status.digest}</code></p>
     {status.nextAction==='approveRedispatch'
      ?<button type="button" disabled={busy} className="rounded border px-3 py-2"
        onClick={()=>void submit('approveRedispatch')}>Approve original issue redispatch ONLY (no inference)</button>
      :<button type="button" disabled={busy} className="rounded border px-3 py-2 font-semibold"
        onClick={()=>void submit('approvePaidInference')}>Separately authorize bounded PAID execution and one dispatch</button>}
    </div>:<p role="status">Pending consent: {status.reason??status.state}. No paid admission is authorized by a missing offer.</p>}
   </div>}
  {message?<p role="status">{message}</p>:null}
  <button type="button" className="text-xs underline" disabled={busy} onClick={()=>void refresh(true)}>Refresh owner approval status</button>
 </section>;
}

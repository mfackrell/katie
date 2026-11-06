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
export function Task4aPostpaidContinuationApproval({chatId}:{chatId:string}){
 const enabled=chatId===CHAT;
 const [status,setStatus]=useState<Status|null>(null),[quote,setQuote]=useState<Reply|null>(null);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [tokens,setTokens]=useState(''),[development,setDevelopment]=useState('');
 const [calls,setCalls]=useState(''),[ceiling,setCeiling]=useState(''),[hours,setHours]=useState('');
 const refresh=useCallback(async()=>{
  if(!enabled)return;
  const token=await ownerSessionBearer();if(!token)return;
  try{
   const result=await fetch(endpoint+'?chatId='+CHAT,{
    headers:{Authorization:'Bearer '+token},cache:'no-store',signal:AbortSignal.timeout(20000)});
   const data=await result.json() as Status;
   setStatus(data);
  }catch{setStatus({state:'evidence_required',error:'Owner evidence lookup unavailable'});}
 },[enabled]);
 useEffect(()=>{void refresh();},[refresh]);
 const numbers=():Limits=>{
  if(![tokens,development,calls,ceiling,hours].every(v=>/^\d+(?:\.\d+)?$/.test(v)))
   throw Error('Enter all five exact owner limits before previewing.');
  const usd=Number(ceiling),time=Number(hours),money=Math.round(usd*1_000_000);
  const candidate:Limits={cumulativeTokens:Number(tokens),developmentTokens:Number(development),
   assessmentTokens:60000,completionTokens:60000,developmentCalls:Number(calls),
   assessmentCalls:4,completionCalls:4,perCallMicrousd:1680000,
   ceilingMicrousd:money,durationSeconds:Math.round(time*3600)};
  if(!Number.isSafeInteger(candidate.cumulativeTokens)||!Number.isSafeInteger(candidate.developmentTokens)||
   !Number.isSafeInteger(candidate.developmentCalls)||!Number.isSafeInteger(money)||
   !Number.isSafeInteger(candidate.durationSeconds)||candidate.durationSeconds!==time*3600)
   throw Error('Financial limits must be exact integers and time exact to the second.');
  return candidate;
 };
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
   <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
    {([
      ['Total cumulative tokens',tokens,setTokens,'At least 191484'],
      ['Development tokens including completion',development,setDevelopment,'At least 131484'],
      ['Development calls including completion',calls,setCalls,'At least 16'],
      ['Cumulative dollar ceiling, USD',ceiling,setCeiling,'Exact dollars, e.g. 4.00'],
      ['Execution window, hours from approval',hours,setHours,'Exact hours, maximum 48']
     ] as const).map(([label,value,change,placeholder])=><label key={label} className="space-y-1">
       <span>{label}</span>
       <input type="text" inputMode="decimal" value={value} placeholder={placeholder}
        className="w-full rounded border bg-transparent px-2 py-2"
        onChange={ev=>{change(ev.currentTarget.value);setQuote(null);}}/>
      </label>)}
   </div>
   {status.reason?<p role="status">Preflight: {status.reason}.</p>:null}
   <button type="button" disabled={busy} className="rounded border px-3 py-2"
    onClick={()=>void submit('previewAuthority')}>Preview exact limits — no charges</button>
   {quote?.ready&&quote.digest?<div className="space-y-2">
    <p>Owner consent digest: <code className="break-all">{quote.digest}</code></p>
    <details><summary>Review the complete evidence-bound authority</summary>
     <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(quote.proposal,null,2)}</pre></details>
    <button type="button" disabled={busy} className="rounded border px-3 py-2 font-semibold"
     onClick={()=>void submit('approveAuthority')}>Approve exactly this authority — NO dispatch</button>
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
  <button type="button" className="text-xs underline" disabled={busy} onClick={()=>void refresh()}>Refresh owner approval status</button>
 </section>;
}

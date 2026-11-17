'use client';
import {useCallback,useEffect,useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';
const endpoint='/api/projects/task4a-verifier-recovery';
const labels={authority:'Approve this capacity transfer and deadline decision',replacement:'Authorize verification-first replacement',inference:'Authorize bounded paid review',handoff:'Bind existing approvals to this qualified release',dispatch:'Dispatch this replacement once'};
type Status={state?:string;action?:keyof typeof labels;ready?:boolean;digest?:string;proposal?:unknown;error?:string;reason?:string};
export function Task4aVerifierRecoveryApproval(){
 const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const refresh=useCallback(async()=>{
 const token=await ownerSessionBearer();if(!token)return;
 try{const r=await fetch(endpoint+'?chatId=e53defeb-16eb-457e-aa07-435141165ee8',{headers:{Authorization:'Bearer '+token},cache:'no-store',signal:AbortSignal.timeout(25000)});setStatus(await r.json());}
 catch{setStatus({state:'blocked',error:'Recovery evidence unavailable. Execution remains blocked.'});}
 },[]);
 useEffect(()=>{void refresh();},[refresh]);
 const approve=async()=>{
 if(busy||!status?.ready||!status.digest||!status.action)return;
 setBusy(true);setMessage('');
 try{const token=await ownerSessionBearer();if(!token)throw Error('Original owner sign-in required');
 const r=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({action:status.action,digest:status.digest,confirm:true}),signal:AbortSignal.timeout(55000)});
 const result=await r.json();if(!r.ok)throw Error(result.error??'Decision unavailable');
 setMessage(status.action==='dispatch'?(result.dispatchAccepted?'One replacement accepted. Acceptance gates remain pending.':'Dispatch acceptance requires reconciliation; do not retry.'):'Separate owner decision recorded.');await refresh();
 }catch(e){setMessage(e instanceof Error?e.message:'Decision unavailable');await refresh();}finally{setBusy(false);}
 };
 if(!status)return null;
 return <div className="rounded border p-3 space-y-2" aria-label="Task 4A failed verifier recovery">
 <p className="font-semibold">Finish the existing Task 4A application</p>
 <p>Restore the authenticated application to verification. Independent reviews and protected Preview acceptance remain required.</p>
 <p>The proposed bounded attempt permits at most six native requests of 23,034 tokens each. It transfers the unused allowance without adding tokens, calls or dollars. Both 60,000-token reserves and the $9 ceiling remain protected.</p>
 {status.action==='handoff'?<p>This release handoff preserves the existing deadline and all prior approvals. It adds no tokens, calls or dollars, creates no paid grant, and does not dispatch. A fresh dispatch decision remains separate.</p>:<p>This is a hard spending limit, not a completion estimate. Requests that do not fit stop before inference. An unexpired deadline is preserved. If expired, this decision explicitly renews it for four hours from consent. Replacement, paid inference and dispatch each require their own decision.</p>}
 {status.ready&&status.digest&&status.action?<>
 <details><summary>Review this exact owner decision</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(status.proposal,null,2)}</pre><code className="break-all">{status.digest}</code></details>
 <button type="button" disabled={busy} className="rounded border px-3 py-2" onClick={()=>void approve()}>{labels[status.action]}</button>
 </>:<p role="status">{status.error??status.reason??status.state}. No automatic retry.</p>}
 {message?<p role="status">{message}</p>:null}
 <button type="button" disabled={busy} className="text-xs underline" onClick={()=>void refresh()}>Refresh recovery evidence</button>
 </div>;
}

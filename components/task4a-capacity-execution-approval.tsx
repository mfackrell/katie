'use client';
import {useCallback,useEffect,useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';
const endpoint='/api/projects/task4a-capacity-execution';
const chat='e53defeb-16eb-457e-aa07-435141165ee8';
type Status={state?:string;ready?:boolean;digest?:string;proposal?:Record<string,unknown>;reason?:string;error?:string};
export function Task4aCapacityExecutionApproval(){
 const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const refresh=useCallback(async()=>{
  const token=await ownerSessionBearer();if(!token)return;
  try{
   const r=await fetch(endpoint+'?chatId='+chat,{headers:{Authorization:'Bearer '+token},cache:'no-store',signal:AbortSignal.timeout(25000)});
   setStatus(await r.json() as Status);
  }catch{setStatus({state:'evidence_required',error:'Replacement proof unavailable.'});}
 },[]);
 useEffect(()=>{void refresh();},[refresh]);
 const approve=async()=>{
  if(busy||!status?.ready||!status.digest)return;
  setBusy(true);setMessage('');
  try{
   const token=await ownerSessionBearer();if(!token)throw Error('Original owner sign-in required');
   const r=await fetch(endpoint,{method:'POST',cache:'no-store',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({action:'approveSuccessorExecution',confirm:true,digest:status.digest}),signal:AbortSignal.timeout(55000)});
   const result=await r.json();
   if(!r.ok||!result.accepted)throw Error(result.error??'Replacement decision rejected');
   setMessage(result.dispatchAccepted?'One replacement accepted. Protected Preview acceptance remains pending.':
    'Owner decision recorded. Dispatch acceptance needs reconciliation; do not retry.');
   await refresh();
  }catch(e){setMessage(e instanceof Error?e.message:'Replacement decision unavailable');await refresh();}
  finally{setBusy(false);}
 };
 if(!status)return null;
 return <div className="rounded border p-3 space-y-2" aria-label="Original Task 4A successor execution">
  <p className="font-semibold">Separately authorize one saved-work execution</p>
  <p>Both consumed dispatch claims stay recorded. One replacement resumes the latest saved WIP under the approved 20-call limit and $9 cumulative ceiling,
   gpt-5.3-codex restriction, and two protected reserves of 60,000 tokens each. No financial entry is required.</p>
  {status.ready&&status.digest?<>
   <p>Existing deadline: {String(status.proposal?.deadline??'')}. This decision does not extend it.</p>
   <details><summary>Review the exact replacement decision</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(status.proposal,null,2)}</pre>
    <code className="break-all">{status.digest}</code></details>
   <button type="button" disabled={busy} className="rounded border px-3 py-2 font-semibold" onClick={()=>void approve()}>
    Authorize one replacement dispatch and bounded paid continuation</button>
  </>:<p role="status">{status.error??status.reason??status.state}. No automatic retry is permitted.</p>}
  {message?<p role="status">{message}</p>:null}
  <button type="button" disabled={busy} className="text-xs underline" onClick={()=>void refresh()}>Refresh replacement proof</button>
 </div>;
}

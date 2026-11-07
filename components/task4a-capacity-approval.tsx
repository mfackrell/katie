'use client';
import {useCallback,useEffect,useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';
const endpoint='/api/projects/task4a-capacity';
type Status={state?:string;ready?:boolean;digest?:string;proposal?:unknown;result?:{deadline?:string};error?:string;reason?:string};
export function Task4aCapacityApproval(){
 const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const refresh=useCallback(async()=>{
  const token=await ownerSessionBearer();if(!token)return;
  try{const r=await fetch(endpoint+'?chatId=e53defeb-16eb-457e-aa07-435141165ee8',{headers:{Authorization:'Bearer '+token},cache:'no-store',signal:AbortSignal.timeout(25000)});setStatus(await r.json());}
  catch{setStatus({state:'evidence_required',error:'Capacity evidence unavailable. Execution remains blocked.'});}
 },[]);
 useEffect(()=>{void refresh();},[refresh]);
 const approve=async()=>{
  if(busy||!status?.ready||!status.digest)return;
  setBusy(true);setMessage('');
  try{
   const token=await ownerSessionBearer();if(!token)throw Error('Original owner sign-in required');
   const r=await fetch(endpoint,{method:'POST',cache:'no-store',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({action:'approveCapacityOnly',confirm:true,digest:status.digest}),signal:AbortSignal.timeout(55000)});
   const result=await r.json();if(!r.ok)throw Error(result.error??'Capacity amendment unavailable');
   setMessage('Capacity amendment recorded. Dispatch and paid inference remain blocked.');await refresh();
  }catch(e){setMessage(e instanceof Error?e.message:'Capacity amendment unavailable');await refresh();}
  finally{setBusy(false);}
 };
 if(!status)return null;
 return <div className="rounded border p-3 space-y-2" aria-label="Task 4A capacity amendment">
  <p className="font-semibold">Renew capacity for the original saved work</p>
  <p>Four hours from authenticated consent; cumulative development-call limit 16 → 20.
   The $9 ceiling, token limits, gpt-5.3-codex model and both 60,000-token reserves stay unchanged.</p>
  <p>This decision permits no dispatch or paid inference. Historical approvals, claims and accounting remain recorded.</p>
  {status.ready&&status.digest?<>
   <details><summary>Review the capacity-only decision</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(status.proposal,null,2)}</pre></details>
   <button type="button" disabled={busy} className="rounded border px-3 py-2" onClick={()=>void approve()}>Approve capacity amendment only</button>
  </>:<p role="status">{status.error??status.reason??(status.state==='capacity_authorized_execution_blocked'?'Capacity approved. Execution remains blocked.':status.state)} {status.result?.deadline?`Deadline: ${status.result.deadline}`:''}</p>}
  {message?<p role="status">{message}</p>:null}
  <button type="button" disabled={busy} className="text-xs underline" onClick={()=>void refresh()}>Refresh capacity evidence</button>
 </div>;
}

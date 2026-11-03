'use client';
import {useCallback,useEffect,useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';
import {TASK4A_ORIGINAL_CHAT} from '@/lib/projects/task4a-saved-specification-recovery';

type Status={ready?:boolean;sourceHash?:string;correction?:{before:string;after:string};
 existingAuthorityExpiresAt?:string;error?:string};

export function Task4aSavedSpecificationRecovery({chatId}:{chatId:string}){
 const [state,setState]=useState<Status|null>(null);
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 const eligible=chatId===TASK4A_ORIGINAL_CHAT;
 const refresh=useCallback(async()=>{
  if(!eligible)return;
  const token=await ownerSessionBearer();
  if(!token){setState({error:'Owner sign-in required for saved specification repair'});return;}
  try{
   const response=await fetch('/api/projects/task4a-specification-recovery',{
    headers:{Authorization:'Bearer '+token},cache:'no-store'
   });
   const value=await response.json() as Status;
   setState(response.ok?value:{error:value.error??'Recovery is unavailable'});
  }catch{setState({error:'Saved specification recovery unavailable'});}
 },[eligible]);
 useEffect(()=>{void refresh();},[refresh]);
 if(!eligible||!state)return null;
 if(!state.ready||!state.sourceHash)return <section className="rounded-xl border p-3 text-sm" aria-label="Task 4A saved specification recovery">
  <p>{state.error??'The saved specification recovery is not currently eligible.'}</p>
  <button type="button" className="underline" onClick={()=>{void refresh();}}>Refresh saved recovery</button>
 </section>;
 const repair=async()=>{
  if(busy)return;
  setBusy(true);setMessage('');
  try{
   const token=await ownerSessionBearer();
   if(!token)throw Error('Sign in as the Katie owner first.');
   const response=await fetch('/api/projects/task4a-specification-recovery',{
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({confirm:true,sourceHash:state.sourceHash})
   });
   const result=await response.json() as {recovered?:boolean;error?:string};
   if(!response.ok||result.recovered!==true)throw Error(result.error??'Recovery not committed.');
   setMessage('Saved specification recovered; refresh this conversation to review its separate scope-approval request.');
   await refresh();
  }catch(e){setMessage(e instanceof Error?e.message:'Recovery unavailable');}
  finally{setBusy(false);}
 };
 return <section className="rounded-xl border p-4 text-sm space-y-2" aria-label="Task 4A saved specification recovery">
  <h3 className="font-semibold">Task 4A — repair saved specification only</h3>
  <p>Only <code>{state.correction?.before}</code> becomes <code>{state.correction?.after}</code>. Reviewed requirements and browser scenarios are preserved.</p>
  <p className="text-xs opacity-70">This nonbillable recovery is separate from spending authorization and application scope approval. No development is dispatched.</p>
  {message?<p role="status">{message}</p>:null}
  <button type="button" className="rounded-md border px-3 py-2 font-semibold disabled:opacity-50" disabled={busy} onClick={()=>{void repair();}}>
   {busy?'Recovering…':'Recover saved specification (no spending)'}
  </button>
 </section>;
}

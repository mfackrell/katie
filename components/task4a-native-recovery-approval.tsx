'use client';
import {useCallback,useEffect,useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';

const ORIGINAL_CHAT='e53defeb-16eb-457e-aa07-435141165ee8';
type Proposal={ready?:boolean;digest?:string;proposal?:{
 taskId:string;oldApprovalId:string;continuationId:string;model:string;
 limits:{cumulativeTokens:number;developmentCalls:number;assessmentCalls:number;
 completionCalls:number;ceilingMicrousd:number};
 replacementDeadline:string;originalNativeDeadline:string;
};error?:string};
export function Task4aNativeRecoveryApproval({chatId}:{chatId:string}){
 const [offer,setOffer]=useState<Proposal|null>(null);
 const [busy,setBusy]=useState(false),[result,setResult]=useState('');
 const enabled=chatId===ORIGINAL_CHAT;
 const refresh=useCallback(async()=>{
  if(!enabled)return;
  const token=await ownerSessionBearer();
  if(!token){setOffer(null);return;}
  try{
   const response=await fetch('/api/projects/task4a-native-recovery',{
    headers:{Authorization:'Bearer '+token},cache:'no-store'
   });
   const data=await response.json() as Proposal;
   setOffer(response.ok?data:null);
  }catch{setOffer(null);}
 },[enabled]);
 useEffect(()=>{void refresh();},[refresh]);
 if(!enabled||!offer?.ready||!offer.proposal||!offer.digest)return null;
 const p=offer.proposal;
 const approve=async()=>{
  if(busy)return;
  setBusy(true);setResult('');
  try{
   const token=await ownerSessionBearer();
   if(!token)throw Error('Owner sign-in required');
   const response=await fetch('/api/projects/task4a-native-recovery',{
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({confirm:true,proposalDigest:offer.digest})
   });
   const data=await response.json() as {accepted?:boolean;error?:string};
   if(!response.ok||data.accepted!==true)throw Error(data.error??'Owner confirmation rejected');
   setResult('Original issue #969 recovered under a new, continuation-bound approval; no new spending has been recorded.');
   await refresh();
  }catch(e){setResult(e instanceof Error?e.message:'Recovery unavailable');}
  finally{setBusy(false);}
 };
 return <section className="rounded-xl border p-4 space-y-2 text-sm" aria-label="Task 4A native authority recovery">
  <h3 className="font-semibold">Task 4A — Original native authorization recovery</h3>
  <p>The prior native handoff failed before inference. This action explicitly revokes the unusable approval and records a new continuation-bound approval for the <strong>same original task and account</strong>, with no increase in limits.</p>
  <p>Limit: {p.limits.cumulativeTokens.toLocaleString()} tokens, {p.limits.developmentCalls} development calls, {p.limits.assessmentCalls} assessment and {p.limits.completionCalls} completion calls, ${(p.limits.ceilingMicrousd/1_000_000).toFixed(2)} maximum. New authority expires no later than {new Date(p.replacementDeadline).toLocaleString()}.</p>
  <p className="text-xs opacity-80">Separate owner consent required. Confirmation permits the original development issue to be redispatched through native admission. It does not publish the application to production.</p>
  {result?<p role="status">{result}</p>:null}
  <button type="button" disabled={busy} className="rounded-md border px-3 py-2 font-semibold disabled:opacity-50" onClick={()=>{void approve();}}>
   {busy?'Verifying…':'Approve exact bounded Task 4A native recovery'}
  </button>
 </section>;
}

'use client';
import {useCallback,useEffect,useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';
import {SelfToolsOwnerSession} from '@/components/self-tools-owner-session';
type Status={canRetry:boolean;deploymentChanged:boolean;consent:null|{id:string;expires_at:string;dispatch_error:string|null};qualification:null|{deadline:string;revoked_at:string|null};execution:null|{status:string;conclusion:string|null}};
export function BenchmarkOwnerApproval(){
 const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[signedIn,setSignedIn]=useState(false);
 const refresh=useCallback(async()=>{
  const token=await ownerSessionBearer();setSignedIn(Boolean(token));if(!token)return;
  const r=await fetch('/api/benchmark/715/dashboard',{headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(10000)});
  const data=await r.json();if(!r.ok)throw Error(data.error||'Could not check benchmark approval.');setStatus(data);setError('');
 },[]);
 useEffect(()=>{let active=true;const check=()=>{if(active&&!document.hidden)void refresh().catch(e=>{if(active)setError(e.message)})};check();const timer=setInterval(check,15000);window.addEventListener('focus',check);return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',check)}},[refresh]);
 async function approve(action?:string){
  if(busy)return;setBusy(true);setError('');
  try{
   const token=await ownerSessionBearer();if(!token)throw Error('Sign in to Katie as the owner first.');
   const r=await fetch('/api/benchmark/715/dashboard',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({approve:true,authorization:'production-715-30usd-350000tokens-4hours',previousConsentId:status?.consent?.id??null,action}),signal:AbortSignal.timeout(25000)});
   const data=await r.json();if(!r.ok)throw Error(data.error||'Approval could not be recorded.');await refresh();
  }catch(e){setError(e instanceof Error?e.message:'Approval failed.')}finally{setBusy(false)}
 }
 const finished=status?.qualification;
 const failed=status?.execution?.status==='completed'&&status.execution.conclusion!=='success';
 return <section aria-label='Take Eleven benchmark approval' className='my-4 rounded-xl border border-amber-400/60 bg-zinc-900 p-5 text-zinc-100'>
  <h3 className='text-lg font-semibold'>Take Eleven benchmark</h3>
  <p className='mt-2 text-sm'>Compare Native Codex, Thin Katie, and Full Katie against the original Take Eleven requirements.</p>
  <p className='mt-2 text-sm font-semibold'>$30 total maximum · $10 and 350,000 tokens per arm</p>
  <p className='mt-2 text-sm text-zinc-300'>Approve moving the unused benchmark allowance to production. Execution has a fixed four-hour window starting when qualification transfers the allowance. Unused funds cannot move between arms. Project scope and development tasks still require their own approvals. The game remains a private Preview.</p>
  {!signedIn&&<div className='mt-3'><p className='mb-2 text-sm'>Sign in with your existing Katie owner account to approve.</p><SelfToolsOwnerSession /></div>}
  {finished?<p role='status' className='mt-3 text-emerald-300'>{finished.revoked_at?'Benchmark authorization revoked.':Date.parse(finished.deadline)<=Date.now()?'Benchmark authorization expired; spending is stopped.':'Benchmark allowance qualified. Katie can continue with project scope approval.'}</p>:
   status?.consent?<p role='status' className='mt-3'>{failed||status.consent.dispatch_error?'Qualification needs attention. Your approval is saved; no replacement budget has been created.':Date.parse(status.consent.expires_at)<=Date.now()?'Qualification approval expired before completion. Existing records are preserved.':'Approval saved. Katie is running the nonbillable qualification checks.'}</p>:
   <button type='button' onClick={()=>void approve()} disabled={busy||!signedIn||!status} className='mt-4 min-h-11 rounded-lg bg-amber-400 px-5 py-2 font-semibold text-zinc-950 disabled:opacity-50'>{busy?'Saving approval…':'Approve $30 benchmark'}</button>}
  {!finished&&status?.canRetry&&<button type='button' disabled={busy} onClick={()=>void approve()} className='mt-3 min-h-11 rounded bg-amber-400 px-4 py-2 font-semibold text-zinc-950'>{status.deploymentChanged?'Approve corrected execution; preserve budget':'Resume qualification; preserve budget'}</button>}
  {!finished&&status?.execution?.status==='waiting'&&<button type='button' disabled={busy} onClick={()=>void approve('approveExecutionGate')} className='mt-3 min-h-11 rounded bg-amber-400 px-4 py-2 font-semibold text-zinc-950'>Approve protected execution</button>}
  {error&&<p role='alert' className='mt-3 text-amber-200'>{error}</p>}
  <button type='button' className='mt-3 block text-sm underline' onClick={()=>void refresh().catch(e=>setError(e.message))}>Refresh status</button>
 </section>;
}

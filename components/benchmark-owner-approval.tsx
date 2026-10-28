'use client';
import {useCallback,useEffect,useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';
import {SelfToolsOwnerSession} from '@/components/self-tools-owner-session';
type Status={canRetry:boolean;deploymentChanged:boolean;consent:null|{id:string;expires_at:string;dispatch_error:string|null};qualification:null|{deadline:string;revoked_at:string|null};execution:null|{status:string;conclusion:string|null}};
type DevelopmentTask={taskId:string;projectId:string;chatId:string;scopeHash:string;request:string;model:string;deadline:string;spentTokens:number;approved:boolean;approvalState:string;taskStatus:string};
export function BenchmarkOwnerApproval(){
 const [task,setTask]=useState<DevelopmentTask|null>(null);

 const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[signedIn,setSignedIn]=useState(false);
 const refresh=useCallback(async()=>{
  const token=await ownerSessionBearer();setSignedIn(Boolean(token));if(!token){setTask(null);setStatus(null);return;}
  const r=await fetch('/api/benchmark/715/dashboard',{headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(10000)});
  const data=await r.json();if(!r.ok)throw Error(data.error||'Could not check benchmark approval.');setStatus(data);setError('');
  if(data.qualification&&!data.qualification.revoked_at&&Date.parse(data.qualification.deadline)>Date.now()){
   const taskResponse=await fetch('/api/benchmark/715/development',{headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(10000)});
   const taskData=await taskResponse.json();if(!taskResponse.ok)throw Error(taskData.error||'Task approval status unavailable.');setTask(taskData.task);
  }else setTask(null);

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
 async function approveTask(){
  if(busy||!task)return;setBusy(true);setError('');
  try{
   const token=await ownerSessionBearer();if(!token)throw Error('Sign in to Katie as the owner first.');
   const response=await fetch('/api/benchmark/715/development',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({approve:true,authorization:'full-task-existing-10usd-350000tokens',taskId:task.taskId,scopeHash:task.scopeHash}),signal:AbortSignal.timeout(15000)});
   const data=await response.json();if(!response.ok)throw Error(data.error||'Task approval failed.');setTask(data.task);
  }catch(e){setError(e instanceof Error?e.message:'Task approval failed.')}finally{setBusy(false)}
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
  {task&&<div className='mt-4 rounded border border-zinc-600 p-3'>
   <h4 className='font-semibold'>Full Katie development approval</h4>
   <p className='mt-2 text-sm'>Authorize this saved development task using the existing Full allowance only: $10 and 350,000 tokens total, including specification and review. {task.spentTokens.toLocaleString()} tokens already charged. Deadline: {new Date(task.deadline).toLocaleString()}. Model: {task.model}. Private Preview only; no merge or production publication.</p>
   <p className='mt-2 break-all text-xs'>Task: {task.taskId}<br/>Approved scope: {task.scopeHash}</p>
   <details className='mt-2'><summary className='cursor-pointer'>Review the exact development request</summary><pre className='mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-sm'>{task.request}</pre></details>
   <a href={`/conversations/${task.chatId}`} className='mt-2 block underline'>Open project and approved scope</a>
   {task.approved?<p role='status' className='mt-3 text-emerald-300'>{task.approvalState==='approved'?'Task approval saved. Katie can continue within its remaining allowance.':task.approvalState==='consumed'?'Task approval consumed by the trusted execution host. Follow the project for execution results.':`Task approval ${task.approvalState}. Execution authority has not been renewed.`}</p>:<button type='button' onClick={()=>void approveTask()} disabled={busy||!signedIn||task.taskStatus!=='dispatching'||Date.parse(task.deadline)<=Date.now()} className='mt-3 min-h-11 rounded bg-amber-400 px-4 py-2 font-semibold text-zinc-950 disabled:opacity-50'>Approve this development task</button>}
  </div>}
  {error&&<p role='alert' className='mt-3 text-amber-200'>{error}</p>}
  <button type='button' className='mt-3 block text-sm underline' onClick={()=>void refresh().catch(e=>setError(e.message))}>Refresh status</button>
 </section>;
}

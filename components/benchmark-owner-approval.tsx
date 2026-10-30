'use client';
import {useCallback,useEffect,useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';
import {SelfToolsOwnerSession} from '@/components/self-tools-owner-session';
type Status={canRetry:boolean;deploymentChanged:boolean;consent:null|{id:string;expires_at:string;dispatch_error:string|null};qualification:null|{deadline:string;revoked_at:string|null};execution:null|{status:string;conclusion:string|null}};
type DevelopmentTask={taskId:string;projectId:string;chatId:string;scopeHash:string;request:string;model:string;deadline:string;spentTokens:number;approved:boolean;approvalState:string;taskStatus:string};
type Continuation={id:string|null;projectId:string;trialId:string;accountId:string;approved:boolean;live:boolean;deadline:string|null;planHash:string;sourceSnapshotHash:string;spentTokens:number;plan:Record<string,unknown>&{additionalTokenCap:number;specificationTokens:number;developmentTokens:number;assessmentTokens:number;kind?:string;resourceAmendment?:boolean;deadline?:string;allocationIncreaseTokens?:number;callsUsed?:number;maxCalls?:number;callsRemaining?:number;unallocatedAccountTokens?:number;developmentRemainingTokens?:number;regenerateSpecification?:boolean}};
export function BenchmarkOwnerApproval(){
 const [continuation,setContinuation]=useState<Continuation|null>(null);
 const [task,setTask]=useState<DevelopmentTask|null>(null);

 const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[signedIn,setSignedIn]=useState(false);
 const refresh=useCallback(async()=>{
  const token=await ownerSessionBearer();setSignedIn(Boolean(token));if(!token){setTask(null);setStatus(null);setContinuation(null);return;}
  const r=await fetch('/api/benchmark/715/dashboard',{headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(10000)});
  const data=await r.json();if(!r.ok)throw Error(data.error||'Could not check benchmark approval.');setStatus(data);setError('');
  const continuationResponse=await fetch('/api/benchmark/715/continuation',{headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(10000)});
  const continuationData=await continuationResponse.json();
  if(!continuationResponse.ok){setContinuation(null);throw Error(continuationData.error||'Continuation status unavailable.');}
  setContinuation(continuationData.continuation);
  if((data.qualification&&!data.qualification.revoked_at&&Date.parse(data.qualification.deadline)>Date.now())||continuationData.continuation?.live){
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
 async function approveContinuation(){
  if(busy||!continuation||continuation.approved)return;setBusy(true);setError('');
  try{
   const token=await ownerSessionBearer();if(!token)throw Error('Sign in to Katie as the owner first.');
   const response=await fetch('/api/benchmark/715/continuation',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({approve:true,authorization:continuation.plan.resourceAmendment?'full-development-resource-amendment-550000tokens-10usd-4hours':'full-continuation-displayed-plan-existing-budget-4hours',projectId:continuation.projectId,planHash:continuation.planHash}),signal:AbortSignal.timeout(15000)});
   const data=await response.json();if(!response.ok)throw Error(data.error||'Continuation approval failed.');await refresh();
  }catch(e){setError(e instanceof Error?e.message:'Continuation approval failed.')}finally{setBusy(false)}
 }
 const finished=status?.qualification;
 const failed=status?.execution?.status==='completed'&&status.execution.conclusion!=='success';
 return <section aria-label='Take Eleven benchmark approval' className='my-4 rounded-xl border border-amber-400/60 bg-zinc-900 p-5 text-zinc-100'>
  <h3 className='text-lg font-semibold'>Take Eleven benchmark</h3>
  <p className='mt-2 text-sm'>Compare Native Codex, Thin Katie, and Full Katie against the original Take Eleven requirements.</p>
  <p className='mt-2 text-sm font-semibold'>$30 total maximum · $10 and 350,000 tokens per arm</p>
  <p className='mt-2 text-sm text-zinc-300'>Approve moving the unused benchmark allowance to production. Execution has a fixed four-hour window starting when qualification transfers the allowance. Unused funds cannot move between arms. Project scope and development tasks still require their own approvals. The game remains a private Preview.</p>
  {!signedIn&&<div className='mt-3'><p className='mb-2 text-sm'>Sign in with your existing Katie owner account to approve.</p><SelfToolsOwnerSession /></div>}
  {finished?<p role='status' className='mt-3 text-emerald-300'>{finished.revoked_at?'Benchmark authorization revoked.':Date.parse(finished.deadline)<=Date.now()?continuation?.live?'Original benchmark window expired. The separately approved continuation is active.':'Benchmark authorization expired; spending is stopped.':'Benchmark allowance qualified. Katie can continue with project scope approval.'}</p>:
   status?.consent?<p role='status' className='mt-3'>{failed||status.consent.dispatch_error?'Qualification needs attention. Your approval is saved; no replacement budget has been created.':Date.parse(status.consent.expires_at)<=Date.now()?'Qualification approval expired before completion. Existing records are preserved.':'Approval saved. Katie is running the nonbillable qualification checks.'}</p>:
   <button type='button' onClick={()=>void approve()} disabled={busy||!signedIn||!status} className='mt-4 min-h-11 rounded-lg bg-amber-400 px-5 py-2 font-semibold text-zinc-950 disabled:opacity-50'>{busy?'Saving approval…':'Approve $30 benchmark'}</button>}
  {!finished&&status?.canRetry&&<button type='button' disabled={busy} onClick={()=>void approve()} className='mt-3 min-h-11 rounded bg-amber-400 px-4 py-2 font-semibold text-zinc-950'>{status.deploymentChanged?'Approve corrected execution; preserve budget':'Resume qualification; preserve budget'}</button>}
  {!finished&&status?.execution?.status==='waiting'&&<button type='button' disabled={busy} onClick={()=>void approve('approveExecutionGate')} className='mt-3 min-h-11 rounded bg-amber-400 px-4 py-2 font-semibold text-zinc-950'>Approve protected execution</button>}
  {continuation&&<div className='mt-4 rounded border border-amber-400 p-3'>
   <h4 className='font-semibold'>{continuation.plan.resourceAmendment?'Full Katie resource amendment':'Full Katie continuation approval'}</h4>
   <p className='mt-2 text-sm'>The original benchmark failure remains recorded. Authorize one continuation in the same project and Full account: at most {continuation.plan.additionalTokenCap.toLocaleString()} additional tokens, within a cumulative $10 model/API ceiling and {continuation.plan.resourceAmendment?'550,000':'350,000'} cumulative tokens. No spending reset or allowance transfer. {continuation.spentTokens.toLocaleString()} tokens already charged.</p>
   {continuation.plan.resourceAmendment?<p className='mt-2 text-sm'>Amend the same saved task: raise its cumulative development limit from 120,000 to {continuation.plan.developmentTokens.toLocaleString()} tokens and call limit from 12 to {continuation.plan.maxCalls}. {continuation.plan.callsUsed} calls are already charged; at most {continuation.plan.callsRemaining} more calls. Development remaining: {continuation.plan.developmentRemainingTokens?.toLocaleString()} tokens. Assessment retains {continuation.plan.assessmentTokens.toLocaleString()} tokens. Increase the Full token ceiling by 200,000, from 350,000 to 550,000 cumulative tokens. The $10 ceiling includes all historical charges and conservative reservations. Historical dollar exposure is ${Number(continuation.plan.historicalExposureMicrousd??0)/1000000}; this is a conservative provision, not a verified invoice. Four hours start when you approve. Up to eleven native coding/review calls leave four calls and 60,000 development tokens for DO completion; the separate assessment keeps its 60,000 tokens. Prior calls, failed attempts, approvals, project identity and original limits stay recorded. One new execution only, with no automatic successor. No research or specification restart; private Preview only.</p>:continuation.plan.kind==='development-renewal'?<p className='mt-2 text-sm'>Renew the same approved development task for four hours. Development: {continuation.plan.developmentRemainingTokens?.toLocaleString()} tokens remaining within its existing 120,000-token ceiling; assessment: {continuation.plan.assessmentTokens.toLocaleString()}. Approved requirements, scope, task identity, prior calls, failed attempts and expired authorizations remain recorded. No research or specification restart. Private Preview only.</p>:<p className='mt-2 text-sm'>Four hours from this approval. Specification {continuation.plan.specificationTokens.toLocaleString()} tokens; development {continuation.plan.developmentTokens.toLocaleString()}; assessment {continuation.plan.assessmentTokens.toLocaleString()}. {continuation.plan.regenerateSpecification===false?'Reuse the retained specification and saved research; no paid composition. Independent review and at most one bounded revision followed by re-review.':'Reuse saved research and available draft evidence; generate a new specification only if no complete candidate survived.'} Formal scope and task approvals remain required. Private Preview only.</p>}
   <p className='mt-2 break-all text-xs'>Project: {continuation.projectId}<br/>Trial: {continuation.trialId}<br/>Account: {continuation.accountId}<br/>Plan: {continuation.planHash}<br/>Failed checkpoint: {continuation.sourceSnapshotHash}</p>
   <details className='mt-2'><summary className='cursor-pointer'>Review the exact continuation plan</summary><pre className='mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-sm'>{JSON.stringify(continuation.plan,null,2)}</pre></details>
   {continuation.approved?<p role='status' className='mt-3'>{continuation.live?`Continuation approved until ${new Date(continuation.deadline!).toLocaleString()}. Existing charges and original outcome preserved.`:'Continuation expired or unavailable. Its authorization has not been renewed.'}</p>:<button type='button' onClick={()=>void approveContinuation()} disabled={busy||!signedIn} className='mt-3 min-h-11 rounded bg-amber-400 px-4 py-2 font-semibold text-zinc-950 disabled:opacity-50'>{continuation.plan.resourceAmendment?'Approve 550,000 cumulative Full tokens, $10 total, and four hours':'Approve this continuation using remaining Full allowance'}</button>}
  </div>}
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



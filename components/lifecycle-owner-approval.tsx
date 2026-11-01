'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';

type Position={cumulativeTokens:number;developmentTokens:number;developmentCalls:number;completionCalls:number;completionTokens:number;assessmentTokens:number;assessmentCalls:number|null;expiresAt:number|null;ceilingMicrousd:string;accountEncumberedTokens?:number;developmentConsumedCalls?:number;developmentEncumberedTokens?:number;committedMicrousd?:string;outstandingMicrousd?:string;durationSeconds?:number|null};
type Proposal={id:string;binding:{taskId:string;projectId:string;scopeHash:string};checkpointSha:string;scope:unknown;acceptance:unknown;currentPhase:string;completed:string[];remaining:string[];shortages:string[];uncertainties:string[];evidence:unknown;current:Position;proposed:Position;additions:{tokens:number;nativeCalls:number;developmentTokens:number;completionCalls:number;assessmentTokens:number;assessmentCalls:number};estimatedIncrementalMicrousd:string|null;conservativeIncrementalMicrousd:string|null;expiresAt:number};
type Result={state:string;taskId?:string;proposal?:Proposal;error?:string;reasons?:string[]};
const dollars=(v:string|null|undefined)=>v==null?'Unknown':(Number(v)/1000000).toLocaleString('en-US',{style:'currency',currency:'USD'});
const number=(v:number|null|undefined)=>v==null?'Unknown':v.toLocaleString();
const date=(v:number|null)=>v==null?'At authenticated approval':new Date(v).toLocaleString();
const statuses:Record<string,string>={pending:'Awaiting owner approval',approved:'Amendment authorized; continuation queued',rejected:'Owner rejected; saved work remains recoverable',expired:'Proposal expired; refresh to review current requirements',stale:'Proposal stale; task or accounting changed',resumed:'Same-task continuation resumed',continuation_failed:'Continuation needs engineering recovery; approved history and saved work retained',evidence_required:'More reliable evidence is required',admission_denied:'Existing admission controls deny continuation',not_required:'No additional resource authority required'};

export function LifecycleOwnerApproval(){
 const [result,setResult]=useState<Result|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const epoch=useRef(0),submitting=useRef(false);
 const cancelPending=useCallback(()=>{epoch.current++},[]);
 const refresh=useCallback(async(explicit=false)=>{
  const version=++epoch.current,token=await ownerSessionBearer();
  if(!token){if(version===epoch.current)setResult(null);return;}
  const response=await fetch('/api/projects/lifecycle-approval'+(explicit?'?refresh=true':''),{headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(20000)});
  const data:Result=await response.json();
  if(version!==epoch.current||submitting.current)return;
  setResult(data);setError(response.ok?'':data.error??'Approval status unavailable');
 },[]);
 useEffect(()=>{let active=true;const check=()=>{if(active&&!document.hidden&&!submitting.current)void refresh().catch(()=>{if(active)setError('Could not refresh approval status.')})};check();const timer=setInterval(check,15000);return()=>{active=false;cancelPending();clearInterval(timer)}},[refresh,cancelPending]);
 async function decide(decision:'approved'|'rejected'){
  const proposal=result?.proposal;if(!proposal||result?.state!=='pending'||submitting.current)return;
  submitting.current=true;epoch.current++;setBusy(true);setError('');
  try{
   const token=await ownerSessionBearer();if(!token)throw Error('Sign in as the owner before deciding.');
   const response=await fetch('/api/projects/lifecycle-approval',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({taskId:proposal.binding.taskId,proposalId:proposal.id,decision}),signal:AbortSignal.timeout(25000)});
   const data=await response.json();if(!response.ok)throw Error(data.error??'Decision not committed. Refresh before retrying.');
   setResult({...result,state:data.state});submitting.current=false;await refresh();
  }catch(e){setError(e instanceof Error?e.message:'Decision could not be confirmed. Refresh before retrying.');}
  finally{submitting.current=false;setBusy(false)}
 }
 if(!result||result.state==='none'||(!result.proposal&&!error))return null;
 const p=result.proposal;
 const rows=p?[
  ['Cumulative token ceiling',number(p.current.cumulativeTokens),number(p.proposed.cumulativeTokens)],
  ['Development token ceiling',number(p.current.developmentTokens),number(p.proposed.developmentTokens)],
  ['Development call ceiling (includes completion)',number(p.current.developmentCalls),number(p.proposed.developmentCalls)],
  ['Protected completion calls / tokens',`${number(p.current.completionCalls)} / ${number(p.current.completionTokens)}`,`${number(p.proposed.completionCalls)} / ${number(p.proposed.completionTokens)}`],
  ['Protected assessment calls / tokens',`${number(p.current.assessmentCalls)} / ${number(p.current.assessmentTokens)}`,`${number(p.proposed.assessmentCalls)} / ${number(p.proposed.assessmentTokens)}`],
  ['Cumulative dollar ceiling',dollars(p.current.ceilingMicrousd),dollars(p.proposed.ceilingMicrousd)],
  ['Execution expiration',date(p.current.expiresAt),p.proposed.durationSeconds?`${number(p.proposed.durationSeconds/3600)} hours from authenticated commit; exact expiration recorded at commit`:date(p.proposed.expiresAt)],
 ]:[];
 return <section aria-label="Development resource approval" className="my-4 rounded-xl border border-amber-400/60 bg-zinc-900 p-5 text-zinc-100">
  <h3 className="text-lg font-semibold">Continue the original development task</h3>
  <p role="status" className="mt-2">{statuses[result.state]??result.state}</p>
  {p&&<>
   <p className="mt-3 break-all text-sm">Task: {p.binding.taskId}<br/>Project: {p.binding.projectId}<br/>Phase: {p.currentPhase}<br/>Checkpoint: {p.checkpointSha}</p>
   <p className="mt-2 text-sm">Completed: {p.completed.join(', ')||'None verified'}. Remaining: {p.remaining.join(', ')}.</p>
   <p className="mt-2 font-semibold">Confirmed shortages: {p.shortages.join(', ')}. Request: {number(p.additions.nativeCalls)} additional native calls and {number(p.additions.tokens)} additional cumulative tokens.</p>
   <div className="mt-3 overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th>Resource</th><th>Current authority</th><th>Proposed authority</th></tr></thead><tbody>{rows.map(([label,current,proposed])=><tr key={label}><th className="py-2 pr-3 font-normal">{label}</th><td className="pr-3">{current}</td><td>{proposed}</td></tr>)}</tbody></table></div>
   <p className="mt-2 text-sm">Remaining cumulative tokens: {number(p.current.cumulativeTokens-(p.current.accountEncumberedTokens??NaN))}. Remaining native calls outside completion: {number(p.current.developmentCalls-(p.current.developmentConsumedCalls??NaN)-p.current.completionCalls)}. Historical committed spending: {dollars(p.current.committedMicrousd)}. Outstanding conservative exposure: {dollars(p.current.outstandingMicrousd)}.</p>
   <p className="mt-2 text-sm">Estimated incremental API spending: {dollars(p.estimatedIncrementalMicrousd)}; conservative estimate: {dollars(p.conservativeIncrementalMicrousd)}. Expected spending is separate from the replacement cumulative dollar ceiling above. Estimates do not guarantee completion. Protected reserves remain unavailable for ordinary repair.</p>
   <p className="mt-2 text-sm">Uncertainty: {p.uncertainties.join('; ')||'No additional uncertainty reported'}. Proposal expires: {date(p.expiresAt)}.</p>
   <details className="mt-3"><summary>Review frozen scope, acceptance and estimate evidence</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({scope:p.scope,acceptance:p.acceptance,evidence:p.evidence,exactProposal:p},null,2)}</pre></details>
   {result.state==='pending'&&<div className="mt-4 flex flex-wrap gap-3"><button type="button" disabled={busy} onClick={()=>void decide('approved')} className="min-h-11 rounded bg-amber-400 px-4 py-2 font-semibold text-zinc-950 disabled:opacity-50">{busy?'Recording decision…':'Approve exactly this amendment'}</button><button type="button" disabled={busy} onClick={()=>void decide('rejected')} className="min-h-11 rounded border px-4 py-2 disabled:opacity-50">Reject amendment</button></div>}
  </>}
  {error&&<p role="alert" className="mt-3 text-amber-200">{error}</p>}
  <button type="button" disabled={busy} className="mt-3 underline" onClick={()=>void refresh(true).catch(()=>setError('Could not refresh approval status.'))}>Refresh proposal and status</button>
 </section>;
}

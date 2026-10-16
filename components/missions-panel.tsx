'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useCallback,useEffect,useRef,useState } from 'react';
import type { ManagedAgent } from '@/lib/agents/policy';
import type { Mission,Assignment } from '@/lib/missions/types';
const button='rounded-lg border border-white/20 px-3 py-2 hover:bg-white/10 disabled:opacity-40';
const field='w-full rounded-lg border border-white/20 bg-zinc-900 p-3 text-white';
async function api(url:string,body?:unknown){const r=await fetch(url,{...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error??'Mission request failed');return d;}
export function MissionsPanel({agents,repos}:{agents:ManagedAgent[];repos:Array<{id:string;full_name:string}>}){
 const [objective,setObjective]=useState(''),[team,setTeam]=useState<string[]>([]),[minutes,setMinutes]=useState(20),[repo,setRepo]=useState('');
 const [missions,setMissions]=useState<Mission[]>([]),[current,setCurrent]=useState<{mission:Mission;jobs:Assignment[]}|null>(null);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const busyRef=useRef(false),creation=useRef<string|null>(null),selected=useRef<string|null>(null),lastStatus=useRef<string|null>(null);
 const refresh=useCallback(async()=>{
  const list=await api('/api/missions');setMissions(list.missions);
  if(selected.current){const id=selected.current;const d=await api('/api/missions?id='+encodeURIComponent(id));if(selected.current!==id)return;setCurrent(d);
   if(lastStatus.current&&lastStatus.current!==d.mission.status&&['completed','blocked','awaiting_approval'].includes(d.mission.status))setNotice('Mission '+d.mission.status+'. Open its results or required decision below.');
   lastStatus.current=d.mission.status;
  }
 },[]);
 useEffect(()=>{let active=true;selected.current=new URLSearchParams(window.location.search).get('mission');void refresh().catch(e=>{if(active)setError(e.message);});const timer=setInterval(()=>{if(!document.hidden&&!busyRef.current)void refresh().catch(e=>{if(active)setError(e.message);});},15000);return()=>{active=false;clearInterval(timer);};},[refresh]);
 async function work(action:()=>Promise<void>){if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');try{await action();}catch(e){setError(e instanceof Error?e.message:'Mission operation failed');}finally{busyRef.current=false;setBusy(false);}}
 async function inspect(id:string){selected.current=id;lastStatus.current=null;window.history.replaceState(null,'','/agents?mission='+encodeURIComponent(id));await refresh();}
 async function control(action:string,jobId?:string){if(!current)return;await api('/api/missions',{action,id:current.mission.id,...(jobId?{jobId}:{})});await refresh();}
 return <section className='space-y-4 rounded-xl border border-sky-500/30 p-4' aria-labelledby='missions-title'>
  <h2 id='missions-title' className='text-xl font-semibold'>Autonomous missions</h2>
  <p className='text-sm text-zinc-300'>Give Katie an objective and a saved team. She assigns the work, manages handoffs, and delivers an independently checked result. Work continues after you close this page.</p>
  {error&&<p role='alert' className='text-red-300'>{error}</p>}
  {notice&&<p role='status' className='text-sky-200'>{notice}</p>}
  <form className='space-y-3' onSubmit={e=>{e.preventDefault();void work(async()=>{const id=creation.current??=crypto.randomUUID();const d=await api('/api/missions',{action:'create',id,objective,agents:team,minutes,...(repo?{repositoryId:repo}:{})});creation.current=null;await inspect(d.mission.id);});}}>
   <label className='block'>Mission objective<textarea className={field} rows={4} required maxLength={12000} value={objective} onChange={e=>{setObjective(e.target.value);creation.current=null;}} placeholder='Describe the outcome, required evidence, assumptions, and what a successful result must contain.'/></label>
   <fieldset className='space-y-2'><legend>Team (choose up to three saved agents)</legend>{agents.filter(a=>!a.archived).map(a=><label key={a.id} className='flex gap-2'><input type='checkbox' checked={team.includes(a.id)} disabled={!team.includes(a.id)&&team.length>=3} onChange={e=>{creation.current=null;setTeam(e.target.checked?[...team,a.id]:team.filter(id=>id!==a.id));}}/>{a.config.name}</label>)}{!agents.some(a=>!a.archived)&&<p className='text-sm text-zinc-400'>Create your agents below, then select them for a mission.</p>}</fieldset>
   <label className='block'>Time allowance (minutes)<input className={field} type='number' min={5} max={120} value={minutes} onChange={e=>{setMinutes(Number(e.target.value));creation.current=null;}}/></label>
   <label className='block'>Repository for approved development (optional)<select aria-label='Mission repository' className={field} value={repo} onChange={e=>{setRepo(e.target.value);creation.current=null;}}><option value=''>No development submission</option>{repos.map(r=><option key={r.id} value={r.id}>{r.full_name}</option>)}</select></label>
   <p className='text-xs text-zinc-400'>Up to three workers, six assignments, twelve model calls, and one substantive revision. 60,000 tokens reserved conservatively for dispatch; actual usage is shown separately. Planning estimate: roughly $1–$2 in model/search charges at the configured rates, excluding hosting. Search has additional metering; this is not a hard dollar cap. No email, purchase, merge, or deployment actions. Background work starts on the next scheduled tick, normally within a minute.</p>
   <button className={button} disabled={busy||team.length===0}>Save mission for approval</button>
  </form>
  <div className='flex flex-wrap gap-2'><button className={button} disabled={busy} onClick={()=>void work(refresh)}>Refresh missions</button>{missions.map(m=><button key={m.id} className={button} onClick={()=>void work(()=>inspect(m.id))}>{m.objective.slice(0,65)} · {m.status}</button>)}</div>
  {current&&<article className='space-y-3 border-t border-white/20 pt-4'>
   <h3 className='text-lg'>Mission · {current.mission.status}</h3><p className='whitespace-pre-wrap'>{current.mission.objective}</p>
   <p className='text-sm text-zinc-400'>Calls {current.mission.calls}/{current.mission.max_calls} · Actual tokens {current.mission.actual_tokens} · Reserved {current.mission.reserved_tokens}/{current.mission.token_allowance}</p>
   {current.mission.detail&&<p role='status'>{current.mission.detail}</p>}
   <div className='flex gap-2'>{current.mission.status==='draft'&&<button className={button} disabled={busy} onClick={()=>void work(()=>control('start'))}>Start background mission</button>}{['draft','running','awaiting_approval'].includes(current.mission.status)&&<button className={button} disabled={busy} onClick={()=>void work(()=>control('stop'))}>Stop mission</button>}</div>
   {current.jobs.map(j=><details key={j.id} className='rounded-lg border border-white/10 p-3' open={j.status==='awaiting_approval'}><summary>{current.mission.team.find(a=>a.id===j.agent_id)?.config.name} · {j.role} · {j.status}</summary><p className='mt-2 whitespace-pre-wrap'>{j.instruction}</p><p className='text-xs text-zinc-400'>Dependencies: {j.dependencies.join(', ')||'None'} · Attempts {j.attempts}</p>{j.detail&&<p>{j.detail}</p>}{j.result&&<pre className='max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs'>{JSON.stringify(j.result,null,2)}</pre>}{j.status==='awaiting_approval'&&<button className={button} disabled={busy} onClick={()=>void work(()=>control('approve',j.id))}>Approve this coding assignment for a draft PR</button>}</details>)}
   {current.mission.result&&<div className='prose prose-invert max-w-none rounded-lg bg-white/5 p-4' aria-label='Mission deliverable'><ReactMarkdown remarkPlugins={[remarkGfm]}>{current.mission.result}</ReactMarkdown></div>}
  </article>}
 </section>;
}

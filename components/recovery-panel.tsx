"use client";
import {useEffect,useState} from 'react';

type RecoveryCase={
 id:string;sourceType:string;sourceId:string;actorId:string;chatId:string|null;
 status:string;category:string|null;strategy:string|null;attempt:number;
 details:string;issueUrl:string|null;prUrl:string|null;updatedAt:string;
};
function safeGithubLink(url:string|null):url is string{
 return typeof url==='string'&&/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9][0-9]*$/.test(url);
}
export function RecoveryPanel(){
 const [cases,setCases]=useState<RecoveryCase[]>([]);
 const [error,setError]=useState('');
 const [loading,setLoading]=useState(true);
 useEffect(()=>{
  let active=true,busy=false;
  const load=async()=>{
   if(!active||busy||document.visibilityState==='hidden')return;
   busy=true;
   try{
    const res=await fetch('/api/recovery',{cache:'no-store'});
    if(!res.ok)throw Error('Could not load recovery history');
    const data=await res.json() as {cases?:RecoveryCase[]};
    if(active){setCases(data.cases??[]);setError('');}
   }catch(e){if(active)setError(e instanceof Error?e.message:'Recovery status unavailable');}
   finally{busy=false;if(active)setLoading(false);}
  };
  const id=window.setInterval(()=>void load(),15000);
  const refresh=()=>void load();
  window.addEventListener('focus',refresh);
  void load();
  return()=>{active=false;window.clearInterval(id);window.removeEventListener('focus',refresh);};
 },[]);
 return <section className="space-y-3 rounded-xl border border-emerald-500/25 bg-white/[0.03] p-4" aria-label="Autonomous recovery">
  <h2 className="text-xl font-semibold">Self-healing &amp; recovery</h2>
  <p className="text-sm text-zinc-400">Durable diagnosis, authorized specialist repairs, independent verification and release gates. A repair PR is never silently merged or deployed.</p>
  {error&&<p className="rounded-md border border-red-500/40 p-2 text-red-200" role="alert">{error}</p>}
  {loading&&<p className="text-zinc-400 text-sm">Checking recovery cases…</p>}
  {!loading&&!error&&!cases.length&&<p className="text-zinc-400 text-sm">No recovery cases recorded.</p>}
  <ul className="space-y-2">{cases.slice(0,15).map(c=><li key={c.id} className="rounded-xl border border-white/10 p-3">
   <div className="flex flex-wrap items-center gap-2">
    <strong className="text-sm">{c.sourceType} recovery</strong>
    <span className={`rounded-full px-2 py-0.5 text-xs ${c.status==='resolved'?'bg-emerald-500/20 text-emerald-200':c.status==='requires_owner'||c.status==='blocked'?'bg-red-500/20 text-red-200':c.status==='awaiting_release'?'bg-amber-400/20 text-amber-200':'bg-sky-500/20 text-sky-200'}`}>{c.status.replaceAll('_',' ')}</span>
    <span className="text-xs text-zinc-500">{c.category?.replaceAll('_',' ')??'diagnosing'}</span>
   </div>
   <p className="mt-2 whitespace-pre-wrap break-words text-sm text-zinc-300">{c.details}</p>
   <p className="mt-1 text-xs text-zinc-500">Diagnosis attempt {c.attempt}/2 · {new Date(c.updatedAt).toLocaleString()}</p>
   <div className="mt-2 flex gap-4 text-sm">
    {safeGithubLink(c.issueUrl)&&<a href={c.issueUrl} target="_blank" rel="noreferrer" className="text-sky-300 underline">Repair assignment</a>}
    {safeGithubLink(c.prUrl)&&<a href={c.prUrl} target="_blank" rel="noreferrer" className="text-sky-300 underline">Reviewed draft PR</a>}
   </div>
  </li>)}</ul>
 </section>;
}

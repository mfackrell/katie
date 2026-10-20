'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

type PendingApproval = {
  missionId: string;
  jobId: string;
  objective: string;
  instruction: string;
  codingInput: string;
  createdAt: string;
};

export function PendingMissionApprovals({missionId,missionIds}:{missionId?:string;missionIds?:string[]} = {}) {
  const [approvals,setApprovals] = useState<PendingApproval[]>([]);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState<string | null>(null);
  const [notice,setNotice] = useState('');

  const refresh = useCallback(async()=>{
    const response = await fetch('/api/missions/pending',{cache:'no-store'});
    if (!response.ok) throw Error('Could not load mission approvals');
    const payload = await response.json() as { approvals?: PendingApproval[] };
    setApprovals(payload.approvals ?? []);
    setError('');
  },[]);

  useEffect(()=>{
    let active=true;
    let fetching=false;
    const poll=async()=>{
      if(!active||fetching||document.hidden)return;
      fetching=true;
      try { await refresh(); }
      catch { if(active)setError('Unable to check pending mission approvals. Refresh Katie to retry.'); }
      finally { fetching=false; }
    };
    void poll();
    const timer=window.setInterval(()=>void poll(),15000);
    const focused=()=>void poll();
    window.addEventListener('focus',focused);
    document.addEventListener('visibilitychange',focused);
    return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',focused);document.removeEventListener('visibilitychange',focused);};
  },[refresh]);

  const approve = async(approval:PendingApproval)=>{
    if(busy)return;
    setBusy(approval.jobId);setError('');setNotice('');
    try{
      // Existing mission control RPC authorizes only this saved coding assignment.
      const response = await fetch('/api/missions',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'approve',id:approval.missionId,jobId:approval.jobId}),
        cache:'no-store',
      });
      if(!response.ok){
        const body=await response.json().catch(()=>({error:'Approval failed'})) as {error?:string};
        throw Error(body.error??'Approval failed');
      }
      setNotice('Approved for draft PR only. Katie can begin coding; merging and deployment are not authorized.');
      await refresh();
    }catch(e){
      setError(e instanceof Error?e.message:'Approval failed');
    }finally{setBusy(null);}
  };

  const visible=approvals.filter(a=>(!missionId||a.missionId===missionId)&&(!missionIds||missionIds.includes(a.missionId)));
  if(!visible.length&&!error&&!notice)return null;
  return <section aria-label='Development approvals' className='mx-3 mt-2 shrink-0 space-y-3 sm:mx-6' data-testid='home-development-approvals'>
    {visible.map(approval=>(
      <article key={approval.jobId} className='rounded-xl border-2 border-amber-400 bg-amber-950/95 p-4 text-amber-50 shadow-lg'>
        <p className='text-xs font-bold uppercase tracking-wider text-amber-300'>Action required · Katie is waiting for your approval</p>
        <h2 className='mt-1 text-lg font-semibold'>Approve development work</h2>
        <p className='mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap text-sm text-amber-50'>{approval.instruction}</p>
        <details className='mt-3 rounded-lg border border-amber-400/40 p-3 text-sm'>
          <summary className='cursor-pointer font-semibold'>Review exact coding assignment and limits</summary>
          <pre className='mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs'>{approval.codingInput}</pre>
        </details>
        <p className='mt-2 text-xs text-amber-200'>Approval authorizes only this saved assignment to create a draft GitHub pull request. It does not authorize merging or deployment.</p>
        <div className='mt-3 flex flex-wrap items-center gap-3'>
          <button type='button' disabled={busy!==null} onClick={()=>void approve(approval)}
            className='min-h-11 rounded-lg bg-amber-400 px-5 py-2 font-bold text-zinc-950 hover:bg-amber-300 disabled:opacity-50'>
            {busy===approval.jobId?'Approving…':'Approve coding for draft PR'}
          </button>
          <Link className='rounded-lg border border-amber-300/60 px-4 py-2 text-sm underline underline-offset-2' href={'/work/'+encodeURIComponent('mission:'+approval.missionId)}>Open full mission</Link>
        </div>
      </article>
    ))}
    {notice&&<p role='status' className='rounded-lg border border-emerald-400/50 bg-emerald-950 p-3 text-sm text-emerald-100'>{notice}</p>}
    {error&&<p role='alert' className='rounded-lg border border-red-400/50 bg-red-950 p-3 text-sm text-red-100'>{error}</p>}
  </section>;
}

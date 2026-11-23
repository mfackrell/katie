"use client";

import { useRef, useState } from "react";
import { ownerSessionBearer } from "@/lib/tools/browser-owner-session";

import type {ManagementActivationOffer} from "@/lib/projects/management-activation";
import type {BlockedOwnerOffer} from "@/lib/projects/blocked-owner-recovery";
import type {BlockedManagementRetestOffer} from "@/lib/projects/blocked-management-retest";
import type {Mission79FutureWindowOffer} from "@/lib/projects/mission79-future-window";
import type {Mission79RetryOffer} from "@/lib/projects/mission79-retry";
import type {Mission80WatchdogOffer} from "@/lib/projects/mission80-watchdog";
import type {Mission82WatchdogOffer} from "@/lib/projects/mission82-watchdog";
import type {OriginalRecoveryOffer} from "@/lib/projects/original-execution-recovery";
import {Mission80WatchdogRecoveryControl} from "./mission80-watchdog-recovery-control";
import {Mission82WatchdogRecoveryControl} from "./mission82-watchdog-recovery-control";
import {OriginalExecutionRecoveryControl} from "./original-execution-recovery-control";
import {Mission79RetryControl} from "./mission79-retry-control";
import {Mission79FutureWindowControl} from "./mission79-future-window-control";

export type DirectorRecoveryReceipt = {
  projectId: string;
  missionId: string;
  assignmentId: string;
  cutoff: string;
  existing: boolean;
};

export type DirectorRecoveryOffer = {
  projectId: string;
  releaseSha: string;
  cutoff: string;
  priorCutoff: string;
  receipt: DirectorRecoveryReceipt | null;
  continuation?: {decisionId:string;admittedAt:string|null;maxCutoff?:string;authorizationId?:string;authorizedAt?:string};
  managementActivation?:ManagementActivationOffer;
  blockedOwnerRecovery?:BlockedOwnerOffer;
  managementRetest?:BlockedManagementRetestOffer;
  mission79FutureWindow?:Mission79FutureWindowOffer;
  mission79Retry?:Mission79RetryOffer;
  mission80Recovery?:Mission80WatchdogOffer;
  mission82Recovery?:Mission82WatchdogOffer;
  originalExecutionRecovery?:OriginalRecoveryOffer;
  managementActivationError?:string;
  hierarchyRecovery?: {decisionId:string;priorCutoff:string;directorCutoff:string;stateHash:string;
    nodeCount:number;maxHours:number;activeMissionId:string|null};
};

function LegacyDirectorRecoveryControl({
  recovery,
  onRefresh,
}: {
  recovery: DirectorRecoveryOffer;
  onRefresh: () => void;
}) {
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<DirectorRecoveryReceipt | null>(null);
  const [continued, setContinued] = useState<string | null>(null);
  const [windowReceipt,setWindowReceipt] = useState<{authorizationId:string;authorizedAt:string}|null>(null);
  const [newCutoff, setNewCutoff] = useState("");
  const [authorizedCutoff,setAuthorizedCutoff] = useState<string|null>(null);
  const receipt = confirmed ?? recovery.receipt;
  const visibleCutoff=authorizedCutoff&&Date.parse(authorizedCutoff)>Date.parse(recovery.cutoff)?authorizedCutoff:recovery.cutoff;
  const expired = Date.now() >= Date.parse(visibleCutoff);

  async function recover(continuation=false,renewal=false) {
    if (submitting.current || (!continuation&&receipt) || (continuation&&!recovery.continuation)
      || (!renewal&&((continuation&&(continued||recovery.continuation?.admittedAt))||Date.now()>=Date.parse(recovery.cutoff)))) return;
    const hierarchy=renewal&&!!recovery.hierarchyRecovery;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      const cutoff=renewal?new Date(newCutoff).toISOString():recovery.cutoff;
      if(renewal&&(Date.parse(cutoff)<=Date.now()||Date.parse(cutoff)<=Date.parse(recovery.cutoff)
        ||(hierarchy&&(Date.parse(cutoff)<=Date.parse(recovery.hierarchyRecovery!.directorCutoff)
          ||Date.parse(cutoff)>Date.now()+recovery.hierarchyRecovery!.maxHours*3600000))))
        throw Error("Choose an explicit future cutoff within the authorized recovery window and later than the expired hierarchy.");
      const authorizationId=renewal?crypto.randomUUID():null;
      const bearer = await ownerSessionBearer();
      if (!bearer) throw Error("Sign in as Katie owner to recover the Project Director.");
      const response = await fetch("/api/projects/organization", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
        body: JSON.stringify(hierarchy?{
          trialAction:'recover_hierarchy',projectId:recovery.projectId,releaseSha:recovery.releaseSha,
          decisionId:recovery.hierarchyRecovery!.decisionId,
          priorCutoff:recovery.hierarchyRecovery!.priorCutoff,
          directorCutoff:recovery.hierarchyRecovery!.directorCutoff,
          stateHash:recovery.hierarchyRecovery!.stateHash,cutoff,authorizationId,
        }:continuation?{
          trialAction:renewal?'renew_continue':'continue',projectId:recovery.projectId,releaseSha:recovery.releaseSha,
          cutoff,decisionId:recovery.continuation!.decisionId,
          ...(renewal?{priorCutoff:recovery.cutoff,authorizationId}:{}),
        }:{
          trialAction: "recover_director_once",
          projectId: recovery.projectId,
          releaseSha: recovery.releaseSha,
          cutoff: recovery.cutoff,
          priorCutoff: recovery.priorCutoff,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(typeof result.error === "string" ? result.error : `Recovery request failed (HTTP ${response.status}).`);
      if(continuation){
        if(hierarchy){
          const proposal=recovery.hierarchyRecovery!;
          if(!result||result.projectId!==recovery.projectId||result.decisionId!==proposal.decisionId
             ||result.releaseSha!==recovery.releaseSha||result.authorizationId!==authorizationId
             ||result.stateHash!==proposal.stateHash||result.activeMissionId!==proposal.activeMissionId
             ||Date.parse(result.cutoff)!==Date.parse(cutoff)
             ||Date.parse(result.priorCutoff)!==Date.parse(proposal.priorCutoff)
             ||Date.parse(result.priorDirectorCutoff)!==Date.parse(proposal.directorCutoff)
             ||typeof result.authorizedAt!=='string'||!Number.isFinite(Date.parse(result.authorizedAt))
             ||result.existing!==false||!Array.isArray(result.renewedNodeIds)
             ||result.renewedNodeIds.length<1||result.renewedNodeIds.length>proposal.nodeCount)
            throw Error('Hierarchy recovery receipt was not confirmed. Refresh the project before continuing.');
          setAuthorizedCutoff(result.cutoff);
          setWindowReceipt({authorizationId:result.authorizationId,authorizedAt:result.authorizedAt});
          setContinued(result.authorizedAt);onRefresh();return;
        }
        if(!result||result.projectId!==recovery.projectId||result.decisionId!==recovery.continuation!.decisionId
          ||result.releaseSha!==recovery.releaseSha||Date.parse(result.cutoff)!==Date.parse(cutoff)
          ||typeof result.existing!=='boolean'||typeof result.admittedAt!=='string'||!Number.isFinite(Date.parse(result.admittedAt)))
          throw Error('Project continuation receipt was not confirmed. Refresh the project before continuing.');
        if(renewal&&(result.authorizationId!==authorizationId||Date.parse(result.priorCutoff)!==Date.parse(recovery.cutoff)
          ||typeof result.authorizedAt!=='string'||!Number.isFinite(Date.parse(result.authorizedAt))))
          throw Error('Deadline authorization receipt was not confirmed. Refresh the project before continuing.');
        if(renewal){setAuthorizedCutoff(result.cutoff);setWindowReceipt({authorizationId:result.authorizationId,authorizedAt:result.authorizedAt});}
        setContinued(result.admittedAt);onRefresh();return;
      }
      if (!result || result.projectId !== recovery.projectId
        || Date.parse(result.cutoff) !== Date.parse(recovery.cutoff)
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.missionId ?? "") || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.assignmentId ?? "")
        || typeof result.existing !== "boolean") {
        throw Error("Recovery admission receipt was not confirmed. Refresh the project before continuing.");
      }
      setConfirmed(result as DirectorRecoveryReceipt);
      onRefresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Recovery admission could not be confirmed.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <aside className="mx-3 my-2 rounded-xl border border-white/20 p-3" aria-label="Project Director recovery">
      <p>{recovery.continuation?'Continue the accepted organization within the existing approved scope and cutoff.':'One Project Director decision. Downstream execution stays paused.'}</p>
      {receipt ? (
        <div role="status">
          <p>Director recovery admitted{receipt.existing ? " previously" : ""}.</p>
          <dl>
            <dt>Project</dt><dd>{receipt.projectId}</dd>
            <dt>Mission</dt><dd>{receipt.missionId}</dd>
            <dt>Assignment</dt><dd>{receipt.assignmentId}</dd>
            <dt>Cutoff</dt><dd>{receipt.cutoff}</dd>
          </dl>
        </div>
      ) : recovery.continuation ? null : expired ? (
        <p>The authorized Director recovery cutoff has expired.</p>
      ) : (
        <button type="button" className="min-h-11 font-semibold" disabled={pending} onClick={() => void recover()}>
          {pending ? "Submitting Director recovery…" : "Recover Project Director"}
        </button>
      )}
      {recovery.continuation&&(
        expired?
          <div>
            <p>{recovery.hierarchyRecovery
              ? "Both the project window and Project Director authority have expired. An authenticated owner can renew the exact existing appointments, with no new capabilities, coding dispatch, scope approval, or provider spending."
              : "The execution window has expired. Enter a new cutoff to explicitly authorize renewal of inherited management deadlines and continuation. The Project Director's existing authority remains the ceiling."}</p>
            {recovery.hierarchyRecovery
              ?<p>Expired Director deadline: {new Date(recovery.hierarchyRecovery.directorCutoff).toLocaleString()}. Preserved appointments: {recovery.hierarchyRecovery.nodeCount}. New cutoff must be within {recovery.hierarchyRecovery.maxHours} hours.</p>
              :recovery.continuation.maxCutoff&&<p>Project Director deadline: {new Date(recovery.continuation.maxCutoff).toLocaleString()}.</p>}
            <label>New project cutoff (your local time)<input type="datetime-local" aria-label="New project cutoff (your local time)" value={newCutoff} onChange={event=>setNewCutoff(event.target.value)} disabled={pending}/></label>
            <button type="button" className="min-h-11 font-semibold" disabled={pending||!newCutoff} onClick={()=>void recover(true,true)}>
              {pending?'Submitting deadline authorization…':recovery.hierarchyRecovery?'Authorize existing hierarchy recovery':'Authorize deadline and continue project'}
            </button>
          </div>:
        continued||recovery.continuation.admittedAt?
          <div role="status"><p>{recovery.hierarchyRecovery?'Existing hierarchy recovered; scope approval and paid work remain separate.':'Project continuation admitted.'} Decision {recovery.continuation.decisionId}. Admission {windowReceipt?.authorizedAt??recovery.continuation.authorizedAt??continued??recovery.continuation.admittedAt}. Cutoff {visibleCutoff}.</p>
            {(windowReceipt?.authorizationId??recovery.continuation.authorizationId)&&<p>Deadline authorization {windowReceipt?.authorizationId??recovery.continuation.authorizationId}.</p>}</div>:
          !expired&&<button type="button" className="min-h-11 font-semibold" disabled={pending} onClick={()=>void recover(true)}>
            {pending?'Submitting project continuation…':'Continue approved project'}
          </button>
      )}
      {error && <p role="alert">{error}</p>}
    </aside>
  );
}


export function DirectorRecoveryControl(props:{recovery:DirectorRecoveryOffer;onRefresh:()=>void}){
 if(props.recovery.originalExecutionRecovery)
  return <OriginalExecutionRecoveryControl key={props.recovery.projectId+':'+props.recovery.releaseSha}
   initial={props.recovery.originalExecutionRecovery} onRefresh={props.onRefresh}/>;
 if(props.recovery.mission82Recovery)
  return <Mission82WatchdogRecoveryControl key={props.recovery.projectId+':'+props.recovery.releaseSha}
   initial={props.recovery.mission82Recovery} onRefresh={props.onRefresh}/>;
 if(props.recovery.mission80Recovery)
  return <Mission80WatchdogRecoveryControl key={props.recovery.projectId+':'+props.recovery.releaseSha}
   initial={props.recovery.mission80Recovery} onRefresh={props.onRefresh}/>;
 if(props.recovery.mission79Retry)
  return <Mission79RetryControl key={props.recovery.projectId+':'+props.recovery.releaseSha}
   initial={props.recovery.mission79Retry} onRefresh={props.onRefresh}/>;
 if(props.recovery.mission79FutureWindow)
  return <Mission79FutureWindowControl key={props.recovery.projectId+':'+props.recovery.releaseSha}
   initial={props.recovery.mission79FutureWindow} onRefresh={props.onRefresh}/>;
 if(props.recovery.managementRetest)
  return <BlockedManagementRetestControl key={props.recovery.projectId+':'+props.recovery.releaseSha}
   initial={props.recovery.managementRetest} onRefresh={props.onRefresh}/>;
 if(props.recovery.managementActivationError)return <aside className="mx-3 my-2 rounded-xl border border-white/20 p-3" aria-label="Approved project recovery">
  <p role="alert">{props.recovery.managementActivationError}</p>
  <button type="button" className="min-h-11 rounded border px-3 py-2" onClick={props.onRefresh}>Refresh project status</button>
 </aside>;
 if(props.recovery.blockedOwnerRecovery)
  return <BlockedOwnerRecoveryControl key={props.recovery.projectId+':'+props.recovery.releaseSha}
   initial={props.recovery.blockedOwnerRecovery} onRefresh={props.onRefresh}/>;
 return props.recovery.managementActivation
  ?<ManagementActivationControl key={props.recovery.projectId+':'+props.recovery.releaseSha} initial={props.recovery.managementActivation} onRefresh={props.onRefresh}/>
  :<LegacyDirectorRecoveryControl {...props}/>;
}


function BlockedManagementRetestControl({initial,onRefresh}:{initial:BlockedManagementRetestOffer;onRefresh:()=>void}){
 const [pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
 const [receipt,setReceipt]=useState<string|null>(null);
 const submitting=useRef(false);
 const expired=Date.now()>=Date.parse(initial.cutoff)-300000;
 async function authorize(){
  if(submitting.current||pending||receipt||initial.stage!=='retest'||expired)return;
  submitting.current=true;setPending(true);setError(null);
  try{
   const bearer=await ownerSessionBearer();
   if(!bearer)throw Error('Sign in as Katie owner to authorize the single management retest.');
   const request={
    trialAction:'retest_blocked_management',projectId:initial.projectId,
    releaseSha:initial.releaseSha,sourceMissionId:initial.sourceMissionId,
    windowId:initial.windowId,cutoff:initial.cutoff,stateHash:initial.stateHash,
   };
   const response=await fetch('/api/projects/organization',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},
    body:JSON.stringify(request),
   });
   const result=await response.json();
   if(!response.ok)throw Error(result.error??'Owner management retest rejected; refresh saved state.');
   if(result.projectId!==initial.projectId||result.stage!=='admitted'||result.status!=='running'
    ||result.existing!==false||result.sourceMissionId!==initial.sourceMissionId
    ||result.windowId!==initial.windowId||result.releaseSha!==initial.releaseSha
    ||result.scopeHash!==initial.scopeHash
    ||Date.parse(result.cutoff)!==Date.parse(initial.cutoff)
    ||result.historicalMissions!==78||result.maxMissions!==96||result.tokenAllowance!==600000
    ||typeof result.authorizedAt!=='string'||!Number.isFinite(Date.parse(result.authorizedAt)))
    throw Error('Retest receipt could not be verified. Refresh saved state; do not resubmit automatically.');
   setReceipt(result.authorizedAt);
   onRefresh();
  }catch(cause){setError(cause instanceof Error?cause.message:'Management retest request failed.');}
  finally{setPending(false);submitting.current=false;}
 }
 const admitted=initial.stage==='admitted'||Boolean(receipt);
 const eligible=initial.stage==='retest'&&!receipt&&!expired;
 return <aside aria-label="One-time blocked management retest"
   className="mx-3 my-3 min-w-0 overflow-hidden rounded-2xl border border-white/15 bg-zinc-900/70 shadow-sm">
  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-5">
   <div className="min-w-0">
    <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-zinc-400">Milestone 3 · Developer Orchestrator</p>
    <h3 className="mt-1 text-base font-semibold text-white">One management retest</h3>
   </div>
   <span className={'inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium '+
    (admitted?'bg-emerald-500/15 text-emerald-300':expired?'bg-zinc-700/50 text-zinc-300':'bg-amber-500/15 text-amber-200')}>
    {admitted?'Authorized':expired?'Window closed':'Action required'}
   </span>
  </div>
  <div className="space-y-3 px-4 py-4 sm:px-5">
   <p className="max-w-2xl text-sm leading-relaxed text-zinc-300">
    Resume one normal LLM management decision on the original tic-tac-toe project.
    This does not manually commission code or extend its approval window.
   </p>
   <dl className="grid gap-2 sm:grid-cols-3">
    <div className="rounded-lg border border-white/10 bg-zinc-950/50 px-3 py-2">
     <dt className="text-xs text-zinc-400">Missions used</dt>
     <dd className="mt-0.5 text-sm font-semibold text-white">{initial.historicalMissions}
      <span className="font-normal text-zinc-400"> / {initial.maxMissions}</span></dd>
    </div>
    <div className="rounded-lg border border-white/10 bg-zinc-950/50 px-3 py-2">
     <dt className="text-xs text-zinc-400">Approved until</dt>
     <dd className="mt-0.5 text-sm font-semibold text-white">
      {new Date(initial.cutoff).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'})}
     </dd>
    </div>
    <div className="rounded-lg border border-white/10 bg-zinc-950/50 px-3 py-2">
     <dt className="text-xs text-zinc-400">Organization contracts</dt>
     <dd className="mt-0.5 text-sm font-semibold text-white">{initial.nodeCount}
      <span className="font-normal text-zinc-400"> · preserved</span></dd>
    </div>
   </dl>
   <p className="text-xs text-zinc-400">Existing project scope, history, and costs remain unchanged.</p>
   <div role="status" aria-live="polite" className="text-sm text-zinc-300">
    {admitted
     ?<p>One-time retest has been recorded. The normal scheduler controls the next management mission.</p>
     :expired?<p>Approved owner window is no longer eligible for a retest.</p>
     :<p>Project blocked. No retest has been authorized yet.</p>}
   </div>
   <div className="flex flex-wrap items-center gap-2 pt-1">
    {eligible&&<button type="button"
     className="min-h-11 rounded-lg bg-emerald-400 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-300 disabled:cursor-wait disabled:opacity-60"
     onClick={()=>void authorize()} disabled={pending}>
     {pending?'Authorizing one retest…':'Authorize one management retest'}
    </button>}
    <button type="button" className="min-h-11 rounded-lg border border-white/20 px-3 py-2 text-sm font-medium text-zinc-200 hover:bg-white/10 disabled:opacity-50"
     disabled={pending} onClick={onRefresh}>Refresh project status</button>
   </div>
   {eligible&&<p className="text-xs leading-relaxed text-zinc-400">
    Owner authentication is required. <a href="#katie-owner-sign-in" className="font-medium text-emerald-300 underline underline-offset-2">Sign in below</a> before authorizing.
   </p>}
   {error&&<p role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p>}
  </div>
 </aside>;
}

function ManagementActivationControl({initial,onRefresh}:{initial:ManagementActivationOffer;onRefresh:()=>void}){
 const [offer,setOffer]=useState(initial);
 const [pending,setPending]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const [notice,setNotice]=useState<string|null>(null);
 const submitting=useRef(false);
 const expired=offer.stage==='expired'||Date.now()>=Date.parse('2026-11-16T18:00:00Z')-300000;
 async function refresh(bearer:string){
  const response=await fetch('/api/projects/organization?projectId='+encodeURIComponent(initial.projectId),{
   headers:{Authorization:'Bearer '+bearer},cache:'no-store',
  });
  const result=await response.json();
  const next=result.managementActivation as ManagementActivationOffer|undefined;
  if(!response.ok||!next||next.projectId!==initial.projectId||next.releaseSha!==initial.releaseSha
   ||next.cutoff!=='2026-11-16T18:00:00Z'||!['renew','resume','resumed','expired'].includes(next.stage))
   throw Error(result.error??'Recovery status could not be verified. Refresh project status.');
  setOffer(next);return next;
 }
 async function act(action:'refresh'|'renew'|'resume'){
  if(submitting.current||(action!=='refresh'&&expired))return;
  submitting.current=true;setPending(true);setError(null);setNotice(null);
  let bearer:string|null=null;
  try{
   bearer=await ownerSessionBearer();
   if(!bearer)throw Error('Sign in with the existing Katie owner account to use this control.');
   if(action==='refresh'){await refresh(bearer);return;}
   if((action==='renew'&&offer.stage!=='renew')||(action==='resume'&&offer.stage!=='resume'))
    throw Error('Refresh project status before continuing.');
   const authorizationId=action==='renew'?crypto.randomUUID():offer.authorizationId;
   const body=action==='renew'?{
    trialAction:'renew_paused_window',projectId:offer.projectId,releaseSha:offer.releaseSha,
    expectedReleaseSha:offer.expectedReleaseSha,scopeHash:offer.scopeHash,sourceMissionId:offer.sourceMissionId,
    priorWindowId:offer.windowId,priorCutoff:'2026-11-15T18:00:00Z',cutoff:'2026-11-16T18:00:00Z',
    authorizationId,stateHash:offer.stateHash,
   }:{trialAction:'resume_management',projectId:offer.projectId,releaseSha:offer.releaseSha,
    authorizationId,stateHash:offer.stateHash,cutoff:'2026-11-16T18:00:00Z'};
   const response=await fetch('/api/projects/organization',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},body:JSON.stringify(body),
   });
   const result=await response.json();
   if(!response.ok)throw Error(result.error??'Recovery request was rejected. Refresh project status.');
   if(result.projectId!==offer.projectId||result.releaseSha!==offer.releaseSha||result.authorizationId!==authorizationId
    ||Date.parse(result.cutoff)!==Date.parse(offer.cutoff)||result.sourceMissionId!==offer.sourceMissionId
    ||result.status!==(action==='renew'?'paused':'running'))
    throw Error('The recovery receipt could not be confirmed. Refresh project status.');
   const next=await refresh(bearer);
   if(next.authorizationId!==authorizationId||(action==='renew'?next.stage!=='resume':next.stage!=='resumed'))
    throw Error('The durable recovery receipt could not be verified. Refresh project status.');
   setNotice(action==='renew'?'Renewal verified. The project remains paused. Resume management separately when ready.':'Management resume verified.');
   onRefresh();
  }catch(failure){
   // A lost response cannot justify repeating a state transition. Read back
   // the durable state and leave the next action as a separate owner click.
   if(bearer){try{await refresh(bearer);}catch{ /* Retain the last verified offer and show the actionable failure. */ }}
   setError(failure instanceof Error?failure.message:'Recovery could not be confirmed. Refresh project status.');
  }finally{submitting.current=false;setPending(false);}
 }
 return <aside className="mx-3 my-2 min-w-0 rounded-xl border border-white/20 p-3" aria-label="Approved project recovery">
  <p className="font-semibold">Original tic-tac-toe project</p>
  <p>Approved cutoff: November 16, 2026, noon Central.</p>
  <p>96-mission cap · 600,000-token allowance · existing scope and organization.</p>
  <div role="status" aria-live="polite">
   {offer.stage==='resumed'?<p>Management resume recorded. Current project status: {offer.status}.</p>
    :expired?<p>The approved cutoff has expired or has less than five minutes remaining. Recovery is unavailable.</p>
    :offer.stage==='resume'?<p>Renewal receipt verified for all 13 contracts. Project paused; management has not resumed.</p>
    :<p>The project is paused. Apply the already-approved renewal first; it will remain paused.</p>}
   {notice&&<p>{notice}</p>}
  </div>
  <div className="mt-2 flex flex-wrap gap-2">
   {!expired&&offer.stage==='renew'&&<button type="button" className="min-h-11 max-w-full rounded border px-3 py-2 font-semibold" disabled={pending} onClick={()=>void act('renew')}>Renew to approved noon Central cutoff</button>}
   {!expired&&offer.stage==='resume'&&<button type="button" className="min-h-11 max-w-full rounded border px-3 py-2 font-semibold" disabled={pending} onClick={()=>void act('resume')}>Resume approved project management</button>}
   <button type="button" className="min-h-11 rounded border px-3 py-2" disabled={pending} onClick={()=>void act('refresh')}>{pending?'Checking recovery…':'Refresh recovery status'}</button>
  </div>
  {error&&<p role="alert">{error} {offer.stage==='resume'?'The renewal is retained; the project remains paused.':''}</p>}
 </aside>;
}

function BlockedOwnerRecoveryControl({initial,onRefresh}:{initial:BlockedOwnerOffer;onRefresh:()=>void}){
 const [offer,setOffer]=useState(initial),[cutoffInput,setCutoffInput]=useState('');
 const [pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
 const [notice,setNotice]=useState<string|null>(null);
 const submitting=useRef(false);
 const expired=offer.stage==='expired'||(offer.stage==='resume'&&(!offer.cutoff||Date.parse(offer.cutoff)<=Date.now()+300000));
 async function refresh(bearer:string){
  const response=await fetch('/api/projects/organization?projectId='+encodeURIComponent(initial.projectId),{
   headers:{Authorization:'Bearer '+bearer},cache:'no-store',
  });
  const body=await response.json();
  const next=body.blockedOwnerRecovery as BlockedOwnerOffer|undefined;
  if(!response.ok||!next||next.projectId!==initial.projectId||next.releaseSha!==initial.releaseSha
   ||next.scopeHash!==initial.scopeHash||next.priorWindowId!==initial.priorWindowId
   ||next.historicalMissions!==76||next.nodeCount!==13
   ||!['authorize','resume','resumed','expired'].includes(next.stage))
   throw Error(body.error??'Blocked recovery status could not be verified. Refresh project status.');
  setOffer(next);return next;
 }
 async function act(action:'refresh'|'authorize'|'resume'){
  if(submitting.current||(action!=='refresh'&&(offer.stage==='resumed'||expired)))return;
  submitting.current=true;setPending(true);setError(null);setNotice(null);
  let bearer:string|null=null;
  try{
   bearer=await ownerSessionBearer();
   if(!bearer)throw Error('Sign in as the existing Katie owner to authorize recovery.');
   if(action==='refresh'){await refresh(bearer);return;}
   if((action==='authorize'&&offer.stage!=='authorize')||(action==='resume'&&offer.stage!=='resume'))
    throw Error('Refresh the exact project state before continuing.');
   let authorizationId:string,cutoff:string;
   if(action==='authorize'){
    if(!cutoffInput)throw Error('Choose a future cutoff explicitly; none is preselected.');
    const target=new Date(cutoffInput).getTime();
    if(!Number.isFinite(target)||target<=Date.now()+300000||target>Date.now()+86400000)
     throw Error('Choose a cutoff more than five minutes and at most 24 hours from now.');
    cutoff=new Date(target).toISOString();authorizationId=crypto.randomUUID();
   }else{
    if(!offer.authorizationId||!offer.cutoff)throw Error('A verified unexpired owner renewal receipt is required.');
    authorizationId=offer.authorizationId;cutoff=offer.cutoff;
   }
   const body=action==='authorize'?{
    trialAction:'authorize_blocked_window',projectId:offer.projectId,releaseSha:offer.releaseSha,
    priorWindowId:offer.priorWindowId,priorCutoff:offer.priorCutoff,cutoff,authorizationId,stateHash:offer.stateHash,
   }:{
    trialAction:'resume_blocked_management',projectId:offer.projectId,releaseSha:offer.releaseSha,
    authorizationId,cutoff,stateHash:offer.stateHash,
   };
   const response=await fetch('/api/projects/organization',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},body:JSON.stringify(body),
   });
   const receipt=await response.json();
   if(!response.ok)throw Error(receipt.error??'Authenticated recovery transition was rejected.');
   if(receipt.projectId!==offer.projectId||receipt.releaseSha!==offer.releaseSha
    ||receipt.authorizationId!==authorizationId||Date.parse(receipt.cutoff)!==Date.parse(cutoff)
    ||receipt.stage!==(action==='authorize'?'resume':'resumed')
    ||receipt.status!==(action==='authorize'?'blocked':'running')
    ||receipt.existing!==false)
    throw Error('Owner transition receipt could not be verified. Refresh the durable state.');
   const verified=await refresh(bearer);
   if(verified.authorizationId!==authorizationId||verified.stage!==receipt.stage)
    throw Error('Durable transition mismatch. Refresh project status; do not resubmit automatically.');
   setNotice(action==='authorize'?'Cutoff recorded; the project remains blocked until a separate owner resume.':
    'Management resume recorded; this action commissioned no workers.');
   onRefresh();
  }catch(failure){
   if(bearer){try{await refresh(bearer);}catch{ /* Owner must explicitly retry status, not a write. */ }}
   setError(failure instanceof Error?failure.message:'Owner recovery could not be confirmed.');
  }finally{submitting.current=false;setPending(false);}
 }
 return <aside className="mx-3 my-2 min-w-0 rounded-xl border border-white/20 p-3" aria-label="Blocked project owner recovery">
  <p className="font-semibold">Original tic-tac-toe project — owner recovery</p>
  <p>The November 16 noon Central cutoff expired. The original 76/96 missions,
   600,000-token allowance, approved scope and 13 contracts remain unchanged.</p>
  <div role="status" aria-live="polite">
   {offer.stage==='authorize'?<p>Project blocked. No new cutoff or resume is authorized.</p>
    :offer.stage==='resume'&&!expired?<p>Owner cutoff recorded: {new Date(offer.cutoff!).toLocaleString()}. Project still blocked.</p>
    :offer.stage==='resumed'?<p>Management resumed under the recorded owner window.</p>
    :<p>Previously authorized window expired; no resume is available.</p>}
   {notice&&<p>{notice}</p>}
  </div>
  {offer.stage==='authorize'&&<div>
   <label>Explicit new cutoff (local time)
    <input type="datetime-local" aria-label="Explicit new cutoff (local time)"
     value={cutoffInput} onChange={event=>setCutoffInput(event.target.value)} disabled={pending}/>
   </label>
   <p>At most 24 hours; window authorization does not resume work or increase allowances.</p>
   <button type="button" className="min-h-11 rounded border px-3 py-2 font-semibold" disabled={pending||!cutoffInput}
    onClick={()=>void act('authorize')}>{pending?'Authorizing window…':'Authorize new cutoff only'}</button>
  </div>}
  {offer.stage==='resume'&&!expired&&<button type="button" className="min-h-11 rounded border px-3 py-2 font-semibold"
   disabled={pending} onClick={()=>void act('resume')}>{pending?'Confirming resume…':'Resume original management separately'}</button>}
  <button type="button" className="min-h-11 rounded border px-3 py-2" disabled={pending}
   onClick={()=>void act('refresh')}>{pending?'Checking state…':'Refresh owner recovery status'}</button>
  {error&&<p role="alert">{error}</p>}
 </aside>;
}

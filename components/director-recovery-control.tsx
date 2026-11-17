"use client";

import { useRef, useState } from "react";
import { ownerSessionBearer } from "@/lib/tools/browser-owner-session";

import type {ManagementActivationOffer} from "@/lib/projects/management-activation";

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
 if(props.recovery.managementActivationError)return <aside className="mx-3 my-2 rounded-xl border border-white/20 p-3" aria-label="Approved project recovery">
  <p role="alert">{props.recovery.managementActivationError}</p>
  <button type="button" className="min-h-11 rounded border px-3 py-2" onClick={props.onRefresh}>Refresh project status</button>
 </aside>;
 return props.recovery.managementActivation
  ?<ManagementActivationControl key={props.recovery.projectId+':'+props.recovery.releaseSha} initial={props.recovery.managementActivation} onRefresh={props.onRefresh}/>
  :<LegacyDirectorRecoveryControl {...props}/>;
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

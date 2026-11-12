"use client";

import { useRef, useState } from "react";
import { ownerSessionBearer } from "@/lib/tools/browser-owner-session";

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
};

export function DirectorRecoveryControl({
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
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      const cutoff=renewal?new Date(newCutoff).toISOString():recovery.cutoff;
      if(renewal&&(Date.parse(cutoff)<=Date.now()||Date.parse(cutoff)<=Date.parse(recovery.cutoff)))
        throw Error("Choose an explicit future cutoff later than the current project deadline.");
      const authorizationId=renewal?crypto.randomUUID():null;
      const bearer = await ownerSessionBearer();
      if (!bearer) throw Error("Sign in as Katie owner to recover the Project Director.");
      const response = await fetch("/api/projects/organization", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
        body: JSON.stringify(continuation?{
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
            <p>The execution window has expired. Enter a new cutoff to explicitly authorize renewal of inherited management deadlines and continuation. The Project Director&apos;s existing authority remains the ceiling.</p>
            {recovery.continuation.maxCutoff&&<p>Project Director deadline: {new Date(recovery.continuation.maxCutoff).toLocaleString()}.</p>}
            <label>New project cutoff (your local time)<input type="datetime-local" aria-label="New project cutoff (your local time)" value={newCutoff} onChange={event=>setNewCutoff(event.target.value)} disabled={pending}/></label>
            <button type="button" className="min-h-11 font-semibold" disabled={pending||!newCutoff} onClick={()=>void recover(true,true)}>
              {pending?'Submitting deadline authorization…':'Authorize deadline and continue project'}
            </button>
          </div>:
        continued||recovery.continuation.admittedAt?
          <div role="status"><p>Project continuation admitted. Decision {recovery.continuation.decisionId}. Admission {windowReceipt?.authorizedAt??recovery.continuation.authorizedAt??continued??recovery.continuation.admittedAt}. Cutoff {visibleCutoff}.</p>
            {(windowReceipt?.authorizationId??recovery.continuation.authorizationId)&&<p>Deadline authorization {windowReceipt?.authorizationId??recovery.continuation.authorizationId}.</p>}</div>:
          !expired&&<button type="button" className="min-h-11 font-semibold" disabled={pending} onClick={()=>void recover(true)}>
            {pending?'Submitting project continuation…':'Continue approved project'}
          </button>
      )}
      {error && <p role="alert">{error}</p>}
    </aside>
  );
}

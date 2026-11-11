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
  const receipt = confirmed ?? recovery.receipt;
  const expired = Date.now() >= Date.parse(recovery.cutoff);

  async function recover() {
    if (submitting.current || receipt || Date.now() >= Date.parse(recovery.cutoff)) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      const bearer = await ownerSessionBearer();
      if (!bearer) throw Error("Sign in as Katie owner to recover the Project Director.");
      const response = await fetch("/api/projects/organization", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
        body: JSON.stringify({
          trialAction: "recover_director_once",
          projectId: recovery.projectId,
          releaseSha: recovery.releaseSha,
          cutoff: recovery.cutoff,
          priorCutoff: recovery.priorCutoff,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(typeof result.error === "string" ? result.error : `Recovery request failed (HTTP ${response.status}).`);
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
      <p>One Project Director decision. Downstream execution stays paused.</p>
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
      ) : expired ? (
        <p>The authorized Director recovery cutoff has expired.</p>
      ) : (
        <button type="button" className="min-h-11 font-semibold" disabled={pending} onClick={() => void recover()}>
          {pending ? "Submitting Director recovery…" : "Recover Project Director"}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </aside>
  );
}

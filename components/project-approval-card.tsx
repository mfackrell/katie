"use client";

export type ProjectApproval = {
  hash: string;
  name: string;
  summary: string;
  requirements: string[];
  milestones: string[];
  allowedPaths: string[];
  repository: string | null;
  deadline: string;
  limits: { codingJobs: number; missions: number; modelTokens: number };
  specification: unknown;
};

type Props = {
  approval: ProjectApproval;
  pending: boolean;
  error: string | null;
  onApprove: (hash: string) => void;
  onRequestChanges: () => void;
};

export function ProjectApprovalCard({ approval, pending, error, onApprove, onRequestChanges }: Props) {
  return (
    <aside aria-label="Project approval required" className="mx-3 my-2 max-h-[55dvh] shrink-0 overflow-y-auto rounded-2xl border-2 border-amber-400/70 bg-amber-950/90 p-3 text-amber-50 shadow-[0_12px_40px_rgba(0,0,0,0.35)] sm:mx-6 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="rounded-full bg-amber-400 px-3 py-1 text-xs font-bold uppercase tracking-wide text-zinc-950">
          Action required · Project approval
        </span>
        <span className="text-xs text-amber-100/80">Katie is waiting for your decision</span>
      </div>
      <h3 className="mt-3 text-base font-semibold text-white">{approval.name}</h3>
      <p className="mt-1 text-sm leading-relaxed text-amber-50/90">{approval.summary}</p>
      <p className="mt-2 text-xs text-amber-100/80">
        Target: <span className="font-semibold text-white">{approval.repository ?? "Not selected"}</span>
        {" · "}{approval.milestones.length} milestones
        {" · "}Up to {approval.limits.codingJobs} coding jobs
      </p>
      <details className="mt-3 rounded-lg border border-amber-200/20 bg-black/20 p-3">
        <summary className="cursor-pointer text-sm font-semibold text-amber-100">Review exact scope and acceptance tests</summary>
        <div className="mt-3 space-y-3 text-xs leading-relaxed text-zinc-100">
          <p className="font-medium">Requirements</p>
          <ul className="list-disc space-y-1 pl-4">{approval.requirements.map((r,i)=><li key={i}>{r}</li>)}</ul>
          <p className="font-medium">Milestones</p>
          <ol className="list-decimal space-y-1 pl-4">{approval.milestones.map((m,i)=><li key={i}>{m}</li>)}</ol>
          <p className="font-medium">Permitted paths</p>
          <p className="break-all">{approval.allowedPaths.join(", ")}</p>
          <p>Budget ceilings: {approval.limits.modelTokens.toLocaleString()} model tokens across {approval.limits.missions} missions. GitHub coding model usage is additional and separately limited.</p>
          <p>Deadline: {new Date(approval.deadline).toLocaleString()}</p>
          <details className="rounded-lg border border-white/10 p-2">
            <summary className="cursor-pointer font-medium">Full approved specification and browser tests (JSON)</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px]">{JSON.stringify(approval.specification,null,2)}</pre>
          </details>
        </div>
      </details>
      <p className="mt-3 text-xs leading-relaxed text-amber-100/90">
        Approval authorizes work only within this scope. It does not authorize production merging, purchases, new services, or credential changes.
      </p>
      {error && <p role="alert" className="mt-3 rounded-lg bg-red-800/40 p-2 text-sm text-red-100">{error}</p>}
      <div className="sticky bottom-0 mt-3 flex flex-wrap gap-2 rounded-xl bg-amber-950/95 py-2">
        <button type="button" disabled={pending} onClick={()=>onApprove(approval.hash)}
          className="min-h-11 flex-1 rounded-xl bg-emerald-400 px-4 py-2 text-sm font-bold text-zinc-950 transition hover:bg-emerald-300 disabled:opacity-60">
          {pending ? "Saving approval…" : "Approve & Start"}
        </button>
        <button type="button" disabled={pending} onClick={onRequestChanges}
          className="min-h-11 rounded-xl border border-white/30 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-60">
          Request changes
        </button>
      </div>
    </aside>
  );
}

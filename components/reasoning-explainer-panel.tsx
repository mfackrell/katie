"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ReasoningUiState } from "@/lib/chat/reasoning-stream";

function truncateSnippet(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 120) {
    return compact;
  }
  return `${compact.slice(0, 117)}...`;
}

export function ReasoningExplainerPanel({
  loading,
  state,
  onClose
}: {
  loading: boolean;
  state: ReasoningUiState;
  onClose?: () => void;
}) {
  const explainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loading) {
      return;
    }
    explainerRef.current?.scrollTo({ top: explainerRef.current.scrollHeight, behavior: "smooth" });
  }, [loading, state.liveExplainer]);

  const isWaitingToStart = loading && !state.startedAt;
  const hasFinalAnswer = Boolean(state.finalAnswer);
  const summaryScores = useMemo(() => state.summaryScores, [state.summaryScores]);
  const showFinalAnswer = !loading && hasFinalAnswer;

  return (
    <div className="w-[min(92vw,460px)] max-h-[58vh] overflow-hidden rounded-2xl border border-white/20 bg-zinc-950/95 p-3 shadow-[0_24px_70px_rgba(0,0,0,0.55)] backdrop-blur-md sm:p-3.5">
      <div className="mb-2.5 flex items-center justify-between gap-2 border-b border-white/10 pb-2">
        <div className="min-w-0">
          <h3 className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-200">Thinking</h3>
          <p className="text-[11px] text-zinc-400">{loading ? "Streaming" : hasFinalAnswer ? "Complete" : "Idle"}</p>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/15 bg-white/[0.04] text-sm text-zinc-300 transition hover:border-white/30 hover:bg-white/[0.08] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label="Dismiss live reasoning popup"
          >
            ✕
          </button>
        ) : null}
      </div>

      <div className="max-h-[calc(58vh-54px)] space-y-2.5 overflow-y-auto pr-1">
      {isWaitingToStart ? <p className="text-xs text-zinc-400">Waiting to start…</p> : null}
      {state.error ? (
        <p className="rounded-lg border border-amber-500/35 bg-amber-500/15 px-2.5 py-2 text-xs leading-5 text-amber-100">
          {state.error.message}
        </p>
      ) : null}

      <section className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Live Explainer</p>
        <div
          ref={explainerRef}
          className="max-h-24 overflow-y-auto rounded-lg border border-white/10 bg-zinc-950/70 px-2.5 py-2 text-xs leading-5 text-zinc-100"
        >
          {state.liveExplainer ? state.liveExplainer : <span className="text-zinc-500">Live reasoning updates will appear here.</span>}
        </div>
      </section>

      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Category Ratings</p>
        <div className="grid gap-1.5">
          {state.categories.map((category) => (
            <div key={category.name} className="rounded-lg border border-white/10 bg-zinc-900/60 p-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="truncate text-xs font-medium text-zinc-200">{category.name}</p>
                <p className="shrink-0 text-[10px] text-zinc-400">S {typeof category.score === "number" ? category.score.toFixed(1) : "—"}</p>
              </div>
              <p className="mb-1 text-[10px] text-zinc-500">Confidence {typeof category.confidence === "number" ? `${Math.round(category.confidence * 100)}%` : "—"}</p>
              {typeof category.progress === "number" ? (
                <div className="mb-1.5 h-1 overflow-hidden rounded-full bg-zinc-800">
                  <div className="h-full rounded-full bg-emerald-400" style={{ width: `${Math.max(0, Math.min(100, category.progress))}%` }} />
                </div>
              ) : null}
              <p className="text-[11px] leading-4 text-zinc-400">{category.explanation ? truncateSnippet(category.explanation) : "No explanation yet."}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Final Answer</p>
        {showFinalAnswer ? (
          <div className="rounded-lg border border-white/10 bg-zinc-950/70 px-2.5 py-2">
            <p className="whitespace-pre-wrap text-xs leading-5 text-zinc-100">{state.finalAnswer}</p>
            {summaryScores.length > 0 ? (
              <ul className="mt-2 grid gap-1 text-[10px] text-zinc-400">
                {summaryScores.map((score) => (
                  <li key={score.name}>
                    {score.name}: {typeof score.score === "number" ? score.score.toFixed(1) : "—"}
                    {typeof score.confidence === "number" ? ` (${Math.round(score.confidence * 100)}%)` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : loading ? (
          <p className="text-xs text-zinc-500">Final answer hidden while streaming.</p>
        ) : (
          <p className="text-xs text-zinc-500">Final answer will appear when generation is complete.</p>
        )}
      </section>
      </div>
    </div>
  );
}

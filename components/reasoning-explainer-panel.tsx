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
  state
}: {
  loading: boolean;
  state: ReasoningUiState;
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

  return (
    <div className="mb-4 w-full max-w-4xl rounded-[24px] border border-white/10 bg-white/[0.03] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.2)] backdrop-blur-sm sm:p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-300">Reasoning Explainer</h3>
        <span className="text-[11px] text-zinc-500">{loading ? "Streaming" : hasFinalAnswer ? "Complete" : "Idle"}</span>
      </div>

      {isWaitingToStart ? <p className="text-sm text-zinc-400">Waiting to start…</p> : null}
      {state.error ? (
        <p className="mb-3 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          {state.error.message}
        </p>
      ) : null}

      <section className="mb-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Live Explainer</p>
        <div
          ref={explainerRef}
          className="max-h-40 overflow-y-auto rounded-xl border border-white/10 bg-zinc-950/45 px-3 py-2 text-sm leading-6 text-zinc-100"
        >
          {state.liveExplainer ? state.liveExplainer : <span className="text-zinc-500">Live reasoning updates will appear here.</span>}
        </div>
      </section>

      <section className="mb-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Category Ratings in Progress</p>
        <div className="grid gap-2 md:grid-cols-2">
          {state.categories.map((category) => (
            <div key={category.name} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <div className="mb-1 flex items-center justify-between">
                <p className="text-sm font-medium text-zinc-200">{category.name}</p>
                <p className="text-xs text-zinc-400">Score: {typeof category.score === "number" ? category.score.toFixed(1) : "—"}</p>
              </div>
              <p className="mb-2 text-[11px] text-zinc-500">Confidence: {typeof category.confidence === "number" ? `${Math.round(category.confidence * 100)}%` : "—"}</p>
              {typeof category.progress === "number" ? (
                <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                  <div className="h-full rounded-full bg-emerald-400" style={{ width: `${Math.max(0, Math.min(100, category.progress))}%` }} />
                </div>
              ) : null}
              <p className="text-xs leading-5 text-zinc-400">{category.explanation ? truncateSnippet(category.explanation) : "No explanation yet."}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Final Answer</p>
        {hasFinalAnswer ? (
          <div className="rounded-xl border border-white/10 bg-zinc-950/45 px-3 py-2">
            <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-100">{state.finalAnswer}</p>
            {summaryScores.length > 0 ? (
              <ul className="mt-3 grid gap-1 text-xs text-zinc-400 md:grid-cols-2">
                {summaryScores.map((score) => (
                  <li key={score.name}>
                    {score.name}: {typeof score.score === "number" ? score.score.toFixed(1) : "—"}
                    {typeof score.confidence === "number" ? ` (${Math.round(score.confidence * 100)}%)` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Final answer will appear when generation is complete.</p>
        )}
      </section>
    </div>
  );
}

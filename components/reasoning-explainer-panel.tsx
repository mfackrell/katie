"use client";

import { useMemo } from "react";
import type { ReasoningUiState } from "@/lib/chat/reasoning-stream";

function truncateSnippet(text: string, maxLength = 72): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

function sanitizeLiveExplainer(text: string): string {
  const compact = text
    .replace(/\s+/g, " ")
    .replace(/\s*([,.;:!?])\s*/g, "$1 ")
    .trim();

  if (!compact) {
    return "";
  }

  const sentences = compact
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return compact.slice(-220);
  }

  const recent = sentences.slice(-2).join(" ");
  return recent.length > 260 ? recent.slice(-260) : recent;
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
  const isWaitingToStart = loading && !state.startedAt;
  const hasFinalAnswer = Boolean(state.finalAnswer);
  const cleanLiveExplainer = useMemo(() => sanitizeLiveExplainer(state.liveExplainer ?? ""), [state.liveExplainer]);

  const compactCategories = useMemo(
    () =>
      state.categories
        .filter(
          (category) =>
            typeof category.score === "number" ||
            typeof category.progress === "number" ||
            Boolean(category.explanation?.trim()),
        )
        .slice(0, 5),
    [state.categories],
  );

  return (
    <div className="w-full max-h-[52vh] overflow-hidden rounded-2xl border border-white/12 bg-zinc-950/90 p-3 shadow-[0_18px_48px_rgba(0,0,0,0.5)] backdrop-blur-md sm:p-3.5">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-[12px] font-medium text-zinc-100">Thinking</h3>
          <p className="text-[11px] text-zinc-400">{loading ? "Streaming updates" : hasFinalAnswer ? "Done" : "Idle"}</p>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-sm text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label="Dismiss live reasoning popup"
          >
            ✕
          </button>
        ) : null}
      </div>

      <div className="space-y-2.5 overflow-y-auto pr-1 max-h-[calc(52vh-46px)]">
        {isWaitingToStart ? <p className="text-xs text-zinc-400">Waiting to start…</p> : null}
        {state.error ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs leading-5 text-amber-100">
            {state.error.message}
          </p>
        ) : null}

        <section>
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">Live status</p>
          <div className="max-h-24 overflow-y-auto rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] leading-5 text-zinc-200">
            {cleanLiveExplainer ? (
              <p>{cleanLiveExplainer}</p>
            ) : (
              <p className="text-zinc-500">Reasoning updates will appear here.</p>
            )}
          </div>
        </section>

        {compactCategories.length > 0 ? (
          <section>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">Categories</p>
            <ul className="space-y-1.5">
              {compactCategories.map((category) => {
                const progressValue =
                  typeof category.progress === "number"
                    ? Math.max(0, Math.min(100, category.progress))
                    : typeof category.score === "number"
                      ? Math.max(0, Math.min(100, category.score * 10))
                      : null;

                return (
                  <li key={category.name} className="rounded-md bg-white/[0.02] px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate text-zinc-300">{category.name}</span>
                      <span className="shrink-0 text-[11px] text-zinc-400">
                        {typeof category.score === "number" ? category.score.toFixed(1) : "—"}
                      </span>
                    </div>
                    {progressValue !== null ? (
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800/80">
                        <div className="h-full rounded-full bg-emerald-400/90" style={{ width: `${progressValue}%` }} />
                      </div>
                    ) : null}
                    {category.explanation && category.explanation.trim().length > 25 ? (
                      <p className="mt-1 truncate text-[10px] text-zinc-500">{truncateSnippet(category.explanation)}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {!loading && hasFinalAnswer ? <p className="text-[11px] text-zinc-500">Final answer posted to chat.</p> : null}
      </div>
    </div>
  );
}

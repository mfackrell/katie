"use client";

import { useEffect, useState } from "react";
import type { Actor } from "@/lib/types/chat";
import type { ReviewMode } from "@/lib/collaboration/review-mode";

const REVIEW_DESCRIPTIONS: Record<ReviewMode, string> = {
  adaptive: "Adaptive: review when the task benefits from it.",
  always: "Always: independently review every substantive answer.",
  off: "Off: do not require independent draft review.",
};

function isReviewMode(value: unknown): value is ReviewMode {
  return value === "adaptive" || value === "always" || value === "off";
}

/** Actor-scoped review control. Reads the saved setting; never guesses it
 * or updates the display permanently until the server confirms the write. */
export function ReviewModeControl({
  actorId, actorName, managed = false,
}: {
  actorId: string;
  actorName: string;
  managed?: boolean;
}) {
  const [mode, setMode] = useState<ReviewMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editable, setEditable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setMode(null);
    setEditable(false);
    setError(null);
    async function load() {
      try {
        const response = await fetch("/api/actors", {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error("Could not load review setting.");
        const body = await response.json() as { actors?: Actor[] };
        const actor = body.actors?.find(candidate => candidate.id === actorId);
        if (!actor || !isReviewMode(actor.reviewMode))
          throw new Error("Saved review setting unavailable.");
        if (!active) return;
        setMode(actor.reviewMode);
        setEditable(!managed && !actor.managedAgentId && actor.actorKind !== "executive");
      } catch {
        if (active) setError("Review setting unavailable.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; controller.abort(); };
  }, [actorId, managed]);

  async function changeMode(next: ReviewMode) {
    if (loading || saving || !editable || !mode || next === mode) return;
    const previous = mode;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/actors?id=${encodeURIComponent(actorId)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewMode: next }),
      });
      const body = await response.json().catch(() => ({})) as {
        actor?: Actor; error?: string;
      };
      if (!response.ok) throw new Error(body.error || "Review setting could not be saved.");
      if (body.actor?.id !== actorId || !isReviewMode(body.actor.reviewMode) ||
          body.actor.reviewMode !== next) {
        throw new Error("Review setting was not confirmed.");
      }
      setMode(body.actor.reviewMode);
      window.dispatchEvent(new CustomEvent("katie-actor-review-mode-changed", {
        detail: { actorId, reviewMode: body.actor.reviewMode },
      }));
    } catch (cause) {
      setMode(previous);
      setError(cause instanceof Error ? cause.message : "Review setting could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <label
        className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/[0.08] px-2.5 text-[11px] font-medium text-zinc-200"
        title={mode ? REVIEW_DESCRIPTIONS[mode] : "Review mode for this agent"}
      >
        <span className="whitespace-nowrap text-emerald-200">Review</span>
        <select
          aria-label={`Review mode for ${actorName || "Katie"}`}
          value={mode ?? ""}
          onChange={event => {
            if (isReviewMode(event.target.value)) void changeMode(event.target.value);
          }}
          disabled={loading || saving || !editable}
          className="min-w-[92px] rounded-lg border border-white/10 bg-zinc-950 px-1.5 py-1 text-[12px] font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="" disabled>{loading ? "Loading…" : "Unavailable"}</option>
          <option value="adaptive">Adaptive</option>
          <option value="always">Always</option>
          <option value="off">Off</option>
        </select>
      </label>
      {saving ? <span role="status" className="text-[11px] text-zinc-400">Saving…</span> : null}
      {error ? <span role="alert" className="max-w-52 text-[11px] text-amber-300">{error}</span> : null}
    </div>
  );
}

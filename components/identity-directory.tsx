"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useResource } from "@/components/workspace-data";
import { useSavedState } from "@/components/saved-workspace-state";
import { actorAudience } from "@/lib/ui/work";
import type { Actor } from "@/lib/types/chat";
function IdentityProfile({ actor }: { actor: Actor }) {
  const saved = useSavedState(`actor:${actor.id}`),
    [summary, setSummary] = useState(""),
    [audience, setAudience] = useState("unknown"),
    [reason, setReason] = useState("");
  useEffect(() => {
    if (saved.state) {
      setSummary(
        saved.state.value.summary ?? actor.routingProfile?.summary ?? "",
      );
      setAudience(
        saved.state.value.audience ??
          (actor.managedAgentId ? "worker" : "unknown"),
      );
      setReason(saved.state.value.reason ?? "");
    }
  }, [saved.state, actor.managedAgentId, actor.routingProfile?.summary]);
  return (
    <details className="rounded-xl border border-white/10 p-4">
      <summary className="cursor-pointer">
        {actor.name} ·{" "}
        {actor.managedAgentId
          ? "Internal worker"
          : (saved.state?.value.audience ?? actorAudience(actor))}
        {saved.state?.value.archived ? " · Hidden from daily views" : ""}
      </summary>
      <div className="mt-4 space-y-3 text-sm">
        <p className="text-zinc-400">
          Creator: {saved.state?.value.creator ?? "Unknown"}. Identity{" "}
          {actor.id}.{" "}
          {actor.parentId
            ? `Parent identity ${actor.parentId}.`
            : "No parent identity recorded."}
        </p>
        <label className="block">
          Plain-language purpose
          <input
            aria-label={`Purpose for ${actor.name}`}
            className="mt-1 w-full rounded-lg bg-zinc-900 p-3"
            maxLength={500}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>
        <label className="block">
          Display classification
          <select
            className="ml-2 rounded bg-zinc-900 p-2"
            disabled={!!actor.managedAgentId}
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
          >
            <option value="unknown">Unknown</option>
            <option value="conversation">Conversational specialist</option>
            <option value="worker">Internal worker</option>
            <option value="test">Test identity</option>
          </select>
        </label>
        <label className="block">
          Creation reason (if known)
          <input
            className="mt-1 w-full rounded bg-zinc-900 p-3"
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <p className="text-xs text-zinc-500">
          Classification only affects display. It does not change tools, memory,
          bindings, or active assignments. Similar names do not establish
          duplicates.
        </p>
        <button
          disabled={!saved.state || saved.saving}
          className="min-h-11 rounded border border-white/20 px-4 disabled:opacity-40"
          onClick={() => void saved.save({ summary, audience, reason })}
        >
          Save profile
        </button>
        <button
          disabled={!saved.state || saved.saving}
          className="ml-2 min-h-11 rounded border border-white/20 px-4 disabled:opacity-40"
          onClick={() =>
            void saved.save({ archived: !saved.state?.value.archived })
          }
        >
          {saved.state?.value.archived
            ? "Restore to daily views"
            : "Hide from daily views"}
        </button>
        <Link
          className="ml-3 underline"
          href={`/conversations?internal=1&q=${encodeURIComponent(actor.name)}`}
        >
          Find conversations
        </Link>
        {saved.error && (
          <p role="alert" className="text-amber-200">
            {saved.error}
          </p>
        )}
      </div>
    </details>
  );
}
export function IdentityDirectory() {
  const actors = useResource<{ actors: Actor[] }>("/api/actors");
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">
        Identity inventory & display profiles
      </h2>
      <p className="text-sm text-zinc-400">
        All existing identities remain intact. Managed workers stay out of daily
        chat navigation; possible tests remain unverified until classified.
      </p>
      {actors.error && <p role="alert">{actors.error}</p>}
      {actors.data?.actors.map((a) => (
        <IdentityProfile actor={a} key={a.id} />
      ))}
    </section>
  );
}

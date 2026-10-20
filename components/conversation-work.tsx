"use client";
import { PendingMissionApprovals } from "@/components/pending-mission-approvals";
import Link from "next/link";
import { useResource } from "@/components/workspace-data";
import { topLevelWork, workLabel, type WorkItem } from "@/lib/ui/work";
import { workHref } from "@/lib/ui/links";
export function ConversationWork({ chatId }: { chatId: string }) {
  const resource = useResource<{ items: WorkItem[]; warnings: string[] }>(
    "/api/work",
  );
  const items = topLevelWork(resource.data?.items ?? [])
    .filter((w) => w.chatId === chatId)
    .slice(0, 4);
  if (!items.length)
    return resource.error ? (
      <p className="shrink-0 px-5 py-2 text-xs text-amber-200">
        Linked work status unavailable. Your conversation is still available.
      </p>
    ) : null;
  return (
    <section
      aria-label="Work in this conversation"
      className="max-h-44 shrink-0 overflow-y-auto border-b border-white/10 px-5 py-3"
    >
      {items.map((w) => (
        <Link
          key={w.key}
          href={workHref(w.source, w.id)}
          className="my-1 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 px-3 py-2"
        >
          <div className="min-w-0">
            <h2 className="line-clamp-1 text-sm font-medium">{w.title}</h2>
            <p className="mt-1 text-xs text-zinc-400">
              {workLabel(w)} · {w.phase.replaceAll("_", " ")}
              {w.reviewState === "pass" ? " · Independent review passed" : ""}
            </p>
          </div>
          <span className="text-xs text-emerald-300">Open work →</span>
        </Link>
      ))}
      <PendingMissionApprovals
        missionIds={(resource.data?.items ?? [])
          .filter((w) => w.chatId === chatId && w.source === "mission")
          .map((w) => w.id)}
      />
      {resource.error && (
        <p role="alert" className="text-xs text-amber-200">
          Status unavailable; showing last saved state.
        </p>
      )}
    </section>
  );
}

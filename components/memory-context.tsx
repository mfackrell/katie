"use client";
import { useResource } from "@/components/workspace-data";
export function MemoryContext({
  actorId,
  chatId,
}: {
  actorId: string;
  chatId: string;
}) {
  const memory = useResource<{
    content?: {
      entries?: Array<{
        key: string;
        value: string;
        source?: string;
        lastConfirmedAt?: string;
        evidenceMessageIds?: string[];
      }>;
    };
    documents?: Array<{ id?: string; title?: string; name?: string }>;
  }>(`/api/long-term-memory?actorId=${encodeURIComponent(actorId)}`);
  return (
    <details className="sm:col-span-2">
      <summary className="cursor-pointer py-2">
        Inspect saved memory for this specialist
      </summary>
      <p className="my-3 text-xs text-zinc-500">
        These are saved records within this specialist’s scope. Their presence
        does not imply every record is selected for every response.
      </p>
      {memory.error && (
        <p role="alert" className="text-amber-200">
          {memory.error}
        </p>
      )}
      {memory.data?.content?.entries?.map((entry) => (
        <div key={entry.key} className="border-b border-white/10 py-3">
          <p className="text-sm">{entry.value}</p>
          <p className="mt-1 text-xs text-zinc-500">
            {entry.source ?? "Source unknown"} · Last confirmed:{" "}
            {entry.lastConfirmedAt ?? "Unknown"}
            {entry.evidenceMessageIds?.length
              ? ` · ${entry.evidenceMessageIds.length} source messages`
              : ""}
          </p>
          <button
            className="mt-2 min-h-11 text-xs text-emerald-300 underline"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("katie:compose-correction", {
                  detail: {
                    chatId,
                    text: `Correct my saved memory (${entry.key}) from “${entry.value}” to: `,
                  },
                }),
              )
            }
          >
            Correct this in the conversation
          </button>
        </div>
      ))}
      {!memory.loading && !memory.data?.content?.entries?.length && (
        <p className="my-3 text-zinc-500">
          No structured memory entries found.
        </p>
      )}
      {!!memory.data?.documents?.length && (
        <p className="mt-3 text-xs text-zinc-500">
          {memory.data.documents.length} saved reference documents are scoped to
          this specialist.
        </p>
      )}
    </details>
  );
}

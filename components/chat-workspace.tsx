"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { MemoryContext } from "@/components/memory-context";
import { ConversationWork } from "@/components/conversation-work";
import { ChatPanel } from "@/components/chat-panel";
import { useResource } from "@/components/workspace-data";
import { useSavedState } from "@/components/saved-workspace-state";
import type { Actor, ChatThread } from "@/lib/types/chat";
export default function ChatWorkspace({
  conversationId,
}: {
  conversationId: string;
}) {
  const actors = useResource<{ actors: Actor[] }>("/api/actors"),
    chats = useResource<{ chats: ChatThread[] }>("/api/chats"),
    repos = useResource<{ repos: Array<{ id: string; full_name: string }> }>(
      "/api/admin/repos",
    );
  const saved = useSavedState(`chat:${conversationId}`),
    [repoId, setRepoId] = useState(""),
    [source, setSource] = useState(false),
    [contextReady, setContextReady] = useState(false),
    [error, setError] = useState("");
  const chat = chats.data?.chats.find((c) => c.id === conversationId),
    actor = actors.data?.actors.find((a) => a.id === chat?.actorId);
  useEffect(() => {
    if (!saved.state || contextReady) return;
    setRepoId(saved.state.value.repoId ?? "");
    setSource(saved.state.value.repoSource ?? false);
    setContextReady(true);
  }, [saved.state, contextReady]);
  async function updateContext(id: string, enabled: boolean) {
    setRepoId(id);
    setSource(enabled);
    await saved.save({ repoId: id || null, repoSource: enabled });
  }
  async function rename() {
    const title = window.prompt("Conversation title", chat?.title);
    if (!title?.trim()) return;
    try {
      const response = await fetch("/api/chats", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: conversationId, title: title.trim() }),
      });
      if (!response.ok) throw Error("Rename failed");
      void chats.refresh();
    } catch {
      setError("Could not rename conversation. Retry when connected.");
    }
  }
  if (actors.loading || chats.loading)
    return (
      <p role="status" className="p-8">
        Loading conversation…
      </p>
    );
  if (!chat || !actor)
    return (
      <div className="p-8">
        <h1 className="text-xl">Conversation unavailable</h1>
        <p className="my-4 text-zinc-400">
          {chats.error ||
            actors.error ||
            "This conversation could not be found. No other conversation has been substituted."}
        </p>
        <Link href="/conversations" className="underline">
          Open Conversations
        </Link>
      </div>
    );
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {error && (
        <p role="alert" className="m-4 text-red-200">
          {error}
        </p>
      )}
      <details className="shrink-0 border-b border-white/10 px-5 py-3 text-sm">
        <summary className="cursor-pointer text-zinc-300">
          Context & conversation settings
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <p>
            With {actor.name}. Memory belongs to this specialist; this
            discussion uses its own conversation history. Attachments are shown
            with their messages.
          </p>
          <label>
            Repository
            <select
              aria-label="Conversation repository"
              className="ml-2 max-w-full rounded bg-zinc-900 p-2"
              value={repoId}
              disabled={!contextReady || saved.saving}
              onChange={(e) => void updateContext(e.target.value, source)}
            >
              <option value="">None</option>
              {repos.data?.repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.full_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={source}
              disabled={!contextReady || saved.saving}
              onChange={(e) => void updateContext(repoId, e.target.checked)}
            />{" "}
            Include repository source. This does not authorize code changes.
          </label>
          <button
            className="min-h-11 text-left underline"
            onClick={() => void rename()}
          >
            Rename conversation
          </button>
          <button
            className="min-h-11 text-left underline"
            disabled={!saved.state || saved.saving}
            onClick={() =>
              void saved.save({ pinned: !saved.state?.value.pinned })
            }
          >
            {saved.state?.value.pinned
              ? "Unpin conversation"
              : "Pin conversation"}
          </button>
          <button
            className="min-h-11 text-left underline"
            disabled={!saved.state || saved.saving}
            onClick={() =>
              void saved.save({ archived: !saved.state?.value.archived })
            }
          >
            {saved.state?.value.archived
              ? "Restore conversation"
              : "Archive conversation"}
          </button>
          <Link
            className="min-h-11 underline"
            href={`/work?filter=all&q=${encodeURIComponent(chat.title)}`}
          >
            Related work
          </Link>
          <MemoryContext actorId={actor.id} chatId={chat.id} />
          {(saved.error || repos.error) && (
            <p role="alert" className="text-amber-200">
              {saved.error || repos.error}
            </p>
          )}
        </div>
      </details>
      <ConversationWork chatId={chat.id} />
      <ChatPanel
        key={chat.id}
        actorId={actor.id}
        chatId={chat.id}
        managedAgentId={actor.managedAgentId}
        activeActorName={actor.name}
        activeChatTitle={chat.title}
        activeRepoId={repoId}
        repoInjectionEnabled={source}
      />
    </div>
  );
}

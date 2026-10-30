"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MemoryContext } from "@/components/memory-context";
import { ConversationWork } from "@/components/conversation-work";
import { StandaloneUsage } from "@/components/standalone-usage";
import { ChatPanel } from "@/components/chat-panel";
import { useResource } from "@/components/workspace-data";
import { useSavedState } from "@/components/saved-workspace-state";
import type { Actor, ChatThread } from "@/lib/types/chat";
export default function ChatWorkspace({
  conversationId,
}: {
  conversationId: string;
}) {
  const router = useRouter();
  const deleteInFlight = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [railReady, setRailReady] = useState(false);
  useEffect(() => { try { const stored = window.localStorage.getItem("katie.statusRail.open"); setRailOpen(stored === null ? window.matchMedia("(min-width: 1024px)").matches : stored === "true"); } catch {} setRailReady(true); }, []);
  function toggleRail() { const next = !railOpen; setRailOpen(next); try { window.localStorage.setItem("katie.statusRail.open", String(next)); } catch {} }
  const [deleted, setDeleted] = useState(false);
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
    // Advanced handoff previews must follow the actual modern workspace, not
    // a stale conversation last opened through the legacy interface.
    if (!chat || !actor) return;
    window.localStorage.setItem("katie.activeActorId", actor.id);
    window.localStorage.setItem("katie.activeChatId", chat.id);
  }, [chat?.id, actor?.id]);
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
  async function remove() {
    if (!chat || deleteInFlight.current) return;
    if (!window.confirm(`Permanently delete “${chat.title}” and its messages? This cannot be undone. The specialist and its long-term memory will be kept.`)) return;
    deleteInFlight.current = true;
    setDeleting(true);
    setError("");
    try {
      const response = await fetch(`/api/chats?id=${encodeURIComponent(chat.id)}`, {
        method: "DELETE",
      });
      // Another tab may already have deleted this conversation.
      if (!response.ok && response.status !== 404) throw Error("Delete failed");
    } catch {
      setError("Could not delete this conversation. Please try again.");
      deleteInFlight.current = false;
      setDeleting(false);
      return;
    }
    // Do not leave Advanced handoff pointing at a deleted conversation. A
    // storage restriction must not prevent navigation after a successful delete.
    try {
      if (window.localStorage.getItem("katie.activeChatId") === chat.id) {
        window.localStorage.removeItem("katie.activeChatId");
      }
    } catch {}
    setDeleted(true);
    router.replace("/conversations");
  }
  if (deleted)
    return (
      <div className="p-8">
        <p role="status">Conversation deleted.</p>
        <Link href="/conversations" className="mt-4 inline-block underline">
          Open Conversations
        </Link>
      </div>
    );
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
      <div className="flex shrink-0 items-start border-b border-white/10">
      <details className="min-w-0 flex-1 px-5 py-3 text-sm">
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
      <button
        type="button"
        className="my-1 mr-3 min-h-11 shrink-0 rounded-lg px-3 text-sm text-zinc-400 hover:bg-red-500/10 hover:text-red-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-300 disabled:opacity-40"
        aria-label={`Delete chat: ${chat.title}`}
        disabled={deleting}
        onClick={() => void remove()}
      >
        {deleting ? "Deleting…" : "Delete chat"}
      </button>
      </div>
      <ConversationWork chatId={chat.id} />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {!railOpen && <button type="button" onClick={toggleRail} className="absolute right-3 top-2 z-30 rounded border border-white/20 bg-zinc-950/90 px-2 py-1 text-xs text-zinc-200" aria-expanded={railOpen} aria-controls="katie-status-rail">Status / Usage</button>}
      <ChatPanel
        key={chat.id}
        statusRailOpen={railOpen && railReady}
        spendingApprovalHostedExternally={railOpen && !actor.managedAgentId && actor.actorKind !== 'executive'}
        spendingApprovalEnabled={!actor.managedAgentId && actor.actorKind !== 'executive'}
        actorId={actor.id}
        chatId={chat.id}
        managedAgentId={actor.managedAgentId}
        activeActorName={actor.name}
        activeChatTitle={chat.title}
        activeRepoId={repoId}
        repoInjectionEnabled={source}
      />
        </div>
        {railOpen && <><div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={toggleRail} aria-hidden="true" />
        <aside id="katie-status-rail" aria-label="Katie status rail" className="fixed inset-y-0 right-0 z-50 flex w-[min(370px,90vw)] min-w-0 flex-col border-l border-white/10 bg-zinc-950 lg:static lg:z-10 lg:w-[350px] lg:shrink-0">
          <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3"><strong className="text-sm">Status & usage</strong><button type="button" className="text-xs underline" onClick={toggleRail}>Hide</button></div>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-4">
            <section className="space-y-2"><h3 className="text-sm font-semibold">Live status</h3><div id="katie-live-status" className="min-w-0 break-words text-xs text-zinc-300" /></section>
            {!actor.managedAgentId && actor.actorKind !== "executive" && <StandaloneUsage rail actorId={actor.id} chatId={chat.id} />}
          </div>
        </aside></>}
      </div>
    </div>
  );
}

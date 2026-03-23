"use client";

import type { Actor, ChatThread } from "@/lib/types/chat";

interface SidebarProps {
  actors: Actor[];
  chats: ChatThread[];
  activeActorId: string;
  activeChatId: string;
  onSelectActor: (actorId: string) => void;
  onSelectChat: (chatId: string) => void;
  onCreateChat: (actorId: string) => void | Promise<void>;
  onOpenCreateActor: () => void;
  onOpenCreateSubActor: (actor: Actor) => void;
  onDeleteActor: (actor: Actor) => void;
}

export function Sidebar({
  actors,
  chats,
  activeActorId,
  activeChatId,
  onSelectActor,
  onSelectChat,
  onCreateChat,
  onOpenCreateActor,
  onOpenCreateSubActor,
  onDeleteActor,
}: SidebarProps) {
  const sortedActors = [...actors].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <aside className="relative flex min-h-0 w-full flex-1 flex-col bg-gradient-to-b from-white/[0.03] via-zinc-950/40 to-zinc-950/80 p-4 sm:p-5">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-sky-400/10 to-transparent" />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="mb-5 rounded-3xl border border-white/10 bg-white/[0.035] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.25)] backdrop-blur-sm">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-zinc-500">Control plane</p>
              <h1 className="mt-2 text-xl font-semibold tracking-tight text-white">Actors</h1>
              <p className="mt-1 text-xs text-zinc-400">Curate specialist routes, branches, and active conversations.</p>
            </div>
            <div className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-200">
              {sortedActors.length}
            </div>
          </div>
          <button
            className="inline-flex min-h-11 w-full items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-r from-sky-500 to-emerald-500 px-3 py-2.5 text-sm font-semibold text-white shadow-[0_12px_28px_rgba(16,185,129,0.25)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            onClick={onOpenCreateActor}
          >
            + Create New Actor
          </button>
        </div>

        <nav className="flex-1 space-y-3 overflow-y-auto pr-1 pb-4">
          {sortedActors.map((actor) => {
            const actorChats = chats.filter((chat) => chat.actorId === actor.id);
            const activeActor = actor.id === activeActorId;
            const isSubActor = Boolean(actor.parentId);

            return (
              <div
                key={actor.id}
                className={[
                  "group rounded-3xl border p-3 shadow-[0_14px_40px_rgba(0,0,0,0.18)] transition duration-200",
                  activeActor
                    ? "border-emerald-400/30 bg-gradient-to-br from-emerald-500/12 via-zinc-900/95 to-zinc-950 ring-1 ring-emerald-400/20"
                    : "border-white/8 bg-white/[0.03] hover:border-white/15 hover:bg-white/[0.05]",
                  isSubActor ? "ml-2 sm:ml-4" : "",
                ].join(" ")}
              >
                <div className="flex flex-col gap-3 px-1 py-1 sm:flex-row sm:items-start sm:justify-between">
                  <button className="min-w-0 flex-1 text-left" onClick={() => onSelectActor(actor.id)}>
                    <div className="flex items-center gap-2">
                      {isSubActor ? (
                        <span className="text-xs text-emerald-300/80">↳</span>
                      ) : (
                        <span className="h-2 w-2 rounded-full bg-sky-400/80 shadow-[0_0_16px_rgba(56,189,248,0.55)]" />
                      )}
                      <span className={`break-words text-sm font-semibold tracking-tight ${activeActor ? "text-white" : "text-zinc-200"}`}>
                        {actor.name}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 break-words text-xs leading-5 text-zinc-500">
                      {actor.purpose || "Focused branch inheriting parent behavior."}
                    </p>
                  </button>
                  <div className="grid grid-cols-3 gap-1.5 sm:flex sm:flex-col sm:items-end">
                    <button
                      className="min-h-10 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-emerald-400/30 hover:bg-emerald-400/10 hover:text-white"
                      onClick={() => void onCreateChat(actor.id)}
                      title={`New chat for ${actor.name}`}
                    >
                      New Chat
                    </button>
                    <button
                      className="min-h-10 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-emerald-400/30 hover:bg-emerald-400/10 hover:text-white"
                      onClick={() => onOpenCreateSubActor(actor)}
                      title={`Branch from ${actor.name}`}
                    >
                      Branch
                    </button>
                    <button
                      className="min-h-10 rounded-xl border border-red-500/20 bg-red-500/5 px-2.5 py-1 text-[11px] font-medium text-red-200 transition hover:border-red-400/40 hover:bg-red-500/10 hover:text-white"
                      onClick={() => onDeleteActor(actor)}
                      title={`Delete ${actor.name}`}
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <div className="mt-3 border-t border-white/8 pt-3">
                  <div className="mb-2 flex items-center justify-between px-1">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-zinc-500">Chats</span>
                    <span className="text-[10px] text-zinc-600">{actorChats.length}</span>
                  </div>
                  <div className="space-y-1.5">
                    {actorChats.map((chat) => {
                      const activeChat = chat.id === activeChatId;
                      return (
                        <button
                          key={chat.id}
                          className={[
                            "block w-full rounded-2xl px-3 py-2 text-left text-xs transition",
                            activeChat
                              ? "border border-white/10 bg-white/[0.08] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                              : "border border-transparent text-zinc-400 hover:border-white/8 hover:bg-white/[0.04] hover:text-zinc-200",
                          ].join(" ")}
                          onClick={() => {
                            onSelectActor(actor.id);
                            onSelectChat(chat.id);
                          }}
                        >
                          <span className="block break-words font-medium">{chat.title}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}

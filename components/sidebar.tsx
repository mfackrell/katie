"use client";

import type { Actor, ChatThread } from "@/lib/types/chat";

interface SidebarProps {
  actors: Actor[];
  chats: ChatThread[];
  activeActorId: string;
  activeChatId: string;
  onSelectActor: (actorId: string) => void;
  onSelectChat: (chatId: string) => void;
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
  onOpenCreateActor,
  onOpenCreateSubActor,
  onDeleteActor
}: SidebarProps) {
  const sortedActors = [...actors].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <aside className="w-80 border-r border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Actors</h1>
        <button
          className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500"
          onClick={onOpenCreateActor}
        >
          + Create New Actor
        </button>
      </div>

      <nav className="space-y-2">
        {sortedActors.map((actor) => {
          const actorChats = chats.filter((chat) => chat.actorId === actor.id);
          const activeActor = actor.id === activeActorId;
          const isSubActor = Boolean(actor.parentId);

          return (
            <div
              key={actor.id}
              className={`rounded-lg border border-zinc-800 bg-zinc-900/80 ${isSubActor ? "ml-4 border-l-2 border-l-blue-600" : ""}`}
            >
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <button
                  className={`flex-1 text-left text-sm font-medium ${activeActor ? "text-white" : "text-zinc-300"}`}
                  onClick={() => onSelectActor(actor.id)}
                >
                  {isSubActor ? "↳ " : ""}
                  {actor.name}
                </button>
                <div className="flex items-center gap-1">
                  <button
                    className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                    onClick={() => onOpenCreateSubActor(actor)}
                    title={`Branch from ${actor.name}`}
                  >
                    Branch
                  </button>
                  <button
                    className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950"
                    onClick={() => onDeleteActor(actor)}
                    title={`Delete ${actor.name}`}
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="border-t border-zinc-800 p-2">
                {actorChats.map((chat) => {
                  const activeChat = chat.id === activeChatId;
                  return (
                    <button
                      key={chat.id}
                      className={`mb-1 block w-full rounded px-2 py-1 text-left text-xs ${
                        activeChat ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800"
                      }`}
                      onClick={() => {
                        onSelectActor(actor.id);
                        onSelectChat(chat.id);
                      }}
                    >
                      {chat.title}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

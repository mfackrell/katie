"use client";

import type { Actor, ChatThread } from "@/lib/types/chat";

interface SidebarProps {
  actors: Actor[];
  chats: ChatThread[];
  activeActorId: string;
  activeChatId: string;
  onSelectActor: (actorId: string) => void;
  onSelectChat: (chatId: string) => void;
}

export function Sidebar({
  actors,
  chats,
  activeActorId,
  activeChatId,
  onSelectActor,
  onSelectChat
}: SidebarProps) {
  return (
    <aside className="w-80 border-r border-zinc-800 bg-zinc-900/40 p-3">
      <h1 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-400">Actors</h1>
      <nav className="space-y-2">
        {actors.map((actor) => {
          const actorChats = chats.filter((chat) => chat.actorId === actor.id);
          const activeActor = actor.id === activeActorId;

          return (
            <div key={actor.id} className="rounded-lg border border-zinc-800 bg-zinc-900/80">
              <button
                className={`w-full px-3 py-2 text-left text-sm font-medium ${
                  activeActor ? "text-white" : "text-zinc-300"
                }`}
                onClick={() => onSelectActor(actor.id)}
              >
                {actor.name}
              </button>
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

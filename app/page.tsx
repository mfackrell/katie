"use client";

import { useEffect, useMemo, useState } from "react";
import { ActorFormModal } from "@/components/actor-form-modal";
import { ChatPanel } from "@/components/chat-panel";
import { Sidebar } from "@/components/sidebar";
import { demoActors, demoChats } from "@/lib/data/mock";
import type { Actor, ChatThread } from "@/lib/types/chat";

type ModalState =
  | { type: "primary" }
  | {
      type: "sub";
      parentActor: Actor;
    }
  | null;

function buildChatId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function HomePage() {
  const [actors, setActors] = useState<Actor[]>(demoActors);
  const [chats, setChats] = useState<ChatThread[]>(demoChats);
  const [activeActorId, setActiveActorId] = useState(demoActors[0].id);
  const [activeChatId, setActiveChatId] = useState(demoChats[0].id);
  const [modalState, setModalState] = useState<ModalState>(null);

  useEffect(() => {
    async function fetchActors() {
      const response = await fetch("/api/actors");
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as { actors?: Actor[] };
      if (payload.actors?.length) {
        setActors(payload.actors);
      }
    }

    void fetchActors();
  }, []);

  const filteredChats = useMemo(() => chats, [chats]);

  async function createActor(input: { name: string; purpose?: string; parentId?: string }) {
    const response = await fetch("/api/actors", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    });

    const payload = (await response.json()) as { actor?: Actor; error?: string };

    if (!response.ok || !payload.actor) {
      throw new Error(payload.error ?? "Failed to create actor.");
    }

    const createdActor = payload.actor;
    setActors((current) => [...current, createdActor]);

    const chatId = buildChatId();
    const chat: ChatThread = {
      id: chatId,
      actorId: createdActor.id,
      title: "New Chat"
    };

    setChats((current) => [...current, chat]);
    setActiveActorId(createdActor.id);
    setActiveChatId(chatId);
  }

  async function deleteActor(actor: Actor) {
    const response = await fetch(`/api/actors?id=${encodeURIComponent(actor.id)}`, {
      method: "DELETE"
    });

    const payload = (await response.json()) as { deletedActorIds?: string[]; error?: string };

    if (!response.ok || !payload.deletedActorIds?.length) {
      throw new Error(payload.error ?? "Failed to delete actor.");
    }

    const deletedIds = new Set(payload.deletedActorIds);
    const nextActors = actors.filter((item) => !deletedIds.has(item.id));
    const nextChats = chats.filter((chat) => !deletedIds.has(chat.actorId));

    setActors(nextActors);
    setChats(nextChats);

    if (deletedIds.has(activeActorId)) {
      setActiveActorId(nextActors[0]?.id ?? "");
    }

    if (deletedIds.has(activeChatId)) {
      setActiveChatId(nextChats[0]?.id ?? "");
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden px-4 py-4 text-zinc-100 sm:px-5 lg:px-6 lg:py-6">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-white/[0.03] to-transparent" />
        <div className="absolute left-[8%] top-20 h-56 w-56 rounded-full bg-sky-500/10 blur-3xl" />
        <div className="absolute right-[10%] top-12 h-64 w-64 rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="absolute bottom-[-6rem] left-1/3 h-72 w-72 rounded-full bg-indigo-500/10 blur-3xl" />
      </div>

      <div className="relative mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1600px] overflow-hidden rounded-[28px] border border-white/10 bg-zinc-950/70 shadow-[0_40px_120px_rgba(0,0,0,0.55)] backdrop-blur-xl">
        <div className="pointer-events-none absolute inset-0 rounded-[28px] ring-1 ring-inset ring-white/5" />
        <Sidebar
          actors={actors}
          chats={filteredChats}
          activeActorId={activeActorId}
          activeChatId={activeChatId}
          onSelectActor={setActiveActorId}
          onSelectChat={setActiveChatId}
          onOpenCreateActor={() => setModalState({ type: "primary" })}
          onOpenCreateSubActor={(actor) => setModalState({ type: "sub", parentActor: actor })}
          onDeleteActor={deleteActor}
        />
        <ChatPanel actorId={activeActorId} chatId={activeChatId} />
      </div>

      {modalState ? (
        <ActorFormModal
          mode={modalState.type}
          parentActor={modalState.type === "sub" ? modalState.parentActor : undefined}
          onClose={() => setModalState(null)}
          onCreate={createActor}
        />
      ) : null}
    </div>
  );
}

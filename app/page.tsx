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

const ACTIVE_ACTOR_STORAGE_KEY = "katie.activeActorId";
const ACTIVE_CHAT_STORAGE_KEY = "katie.activeChatId";

function buildChatId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pickActiveActorId(actors: Actor[], preferredActorId: string | null): string {
  if (preferredActorId && actors.some((actor) => actor.id === preferredActorId)) {
    return preferredActorId;
  }

  return actors[0]?.id ?? "";
}

function pickActiveChatId(chats: ChatThread[], actorId: string, preferredChatId: string | null): string {
  const actorChats = chats.filter((chat) => chat.actorId === actorId);

  if (preferredChatId && actorChats.some((chat) => chat.id === preferredChatId)) {
    return preferredChatId;
  }

  return actorChats[0]?.id ?? "";
}

export default function HomePage() {
  const [actors, setActors] = useState<Actor[]>(demoActors);
  const [chats, setChats] = useState<ChatThread[]>(demoChats);
  const [activeActorId, setActiveActorId] = useState(demoActors[0]?.id ?? "");
  const [activeChatId, setActiveChatId] = useState(demoChats[0]?.id ?? "");
  const [modalState, setModalState] = useState<ModalState>(null);
  const [hasLoadedPersistedState, setHasLoadedPersistedState] = useState(false);

  useEffect(() => {
    async function fetchInitialData() {
      try {
        const [actorsResponse, chatsResponse] = await Promise.all([
          fetch("/api/actors", { cache: "no-store" }),
          fetch("/api/chats", { cache: "no-store" })
        ]);

        const actorsPayload = actorsResponse.ok
          ? ((await actorsResponse.json()) as { actors?: Actor[] })
          : { actors: [] };
        const chatsPayload = chatsResponse.ok
          ? ((await chatsResponse.json()) as { chats?: ChatThread[] })
          : { chats: [] };

        const persistedActors = actorsPayload.actors ?? [];
        const persistedChats = chatsPayload.chats ?? [];
        const hasPersistedActors = persistedActors.length > 0;
        const hasPersistedChats = persistedChats.length > 0;
        const nextActors = hasPersistedActors ? persistedActors : demoActors;
        const nextChats = hasPersistedChats ? persistedChats : hasPersistedActors ? [] : demoChats;
        const storedActorId = window.localStorage.getItem(ACTIVE_ACTOR_STORAGE_KEY);
        const storedChatId = window.localStorage.getItem(ACTIVE_CHAT_STORAGE_KEY);
        const nextActiveActorId = pickActiveActorId(nextActors, storedActorId);
        const nextActiveChatId = pickActiveChatId(nextChats, nextActiveActorId, storedChatId);

        setActors(nextActors);
        setChats(nextChats);
        setActiveActorId(nextActiveActorId);
        setActiveChatId(nextActiveChatId);
      } finally {
        setHasLoadedPersistedState(true);
      }
    }

    void fetchInitialData();
  }, []);

  useEffect(() => {
    if (!hasLoadedPersistedState) {
      return;
    }

    if (activeActorId) {
      window.localStorage.setItem(ACTIVE_ACTOR_STORAGE_KEY, activeActorId);
      return;
    }

    window.localStorage.removeItem(ACTIVE_ACTOR_STORAGE_KEY);
  }, [activeActorId, hasLoadedPersistedState]);

  useEffect(() => {
    if (!hasLoadedPersistedState) {
      return;
    }

    if (activeChatId) {
      window.localStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, activeChatId);
      return;
    }

    window.localStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY);
  }, [activeChatId, hasLoadedPersistedState]);

  useEffect(() => {
    if (!hasLoadedPersistedState || actors.length === 0) {
      return;
    }

    if (!actors.some((actor) => actor.id === activeActorId)) {
      const nextActorId = actors[0]?.id ?? "";
      setActiveActorId(nextActorId);
      setActiveChatId(pickActiveChatId(chats, nextActorId, null));
      return;
    }

    const actorChats = chats.filter((chat) => chat.actorId === activeActorId);
    if (!actorChats.some((chat) => chat.id === activeChatId)) {
      setActiveChatId(actorChats[0]?.id ?? "");
    }
  }, [activeActorId, activeChatId, actors, chats, hasLoadedPersistedState]);

  const filteredChats = useMemo(() => chats, [chats]);

  async function createActor(input: { name: string; purpose?: string; parentId?: string }) {
    const actorResponse = await fetch("/api/actors", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    });

    const actorPayload = (await actorResponse.json()) as { actor?: Actor; error?: string };

    if (!actorResponse.ok || !actorPayload.actor) {
      throw new Error(actorPayload.error ?? "Failed to create actor.");
    }

    const createdActor = actorPayload.actor;
    const chatId = buildChatId();
    const chatResponse = await fetch("/api/chats", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        id: chatId,
        actorId: createdActor.id,
        title: "New Chat"
      })
    });
    const chatPayload = (await chatResponse.json()) as { chat?: ChatThread; error?: string };

    if (!chatResponse.ok || !chatPayload.chat) {
      throw new Error(chatPayload.error ?? "Failed to create initial chat.");
    }

    const createdChat = chatPayload.chat;
    setActors((current) => [...current.filter((actor) => actor.id !== createdActor.id), createdActor]);
    setChats((current) => [...current.filter((chat) => chat.id !== createdChat.id), createdChat]);
    setActiveActorId(createdActor.id);
    setActiveChatId(createdChat.id);
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
    const nextActiveActorId = deletedIds.has(activeActorId)
      ? pickActiveActorId(nextActors, null)
      : activeActorId;
    const nextActiveChatId = deletedIds.has(activeChatId)
      ? pickActiveChatId(nextChats, nextActiveActorId, null)
      : pickActiveChatId(nextChats, nextActiveActorId, activeChatId);

    setActors(nextActors);
    setChats(nextChats);
    setActiveActorId(nextActiveActorId);
    setActiveChatId(nextActiveChatId);
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

"use client";

import { useEffect, useMemo, useState } from "react";
import { ActorFormModal } from "@/components/actor-form-modal";
import { ChatPanel } from "@/components/chat-panel";
import { Sidebar } from "@/components/sidebar";
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
const ACTOR_CHAT_SELECTIONS_STORAGE_KEY = "katie.actorChatSelections";

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

function pickActiveChatId(
  chats: ChatThread[],
  actorId: string,
  preferredChatId: string | null,
  actorChatSelections: Record<string, string>,
): string {
  const actorChats = chats.filter((chat) => chat.actorId === actorId);
  const preferredIds = [preferredChatId, actorChatSelections[actorId]].filter(
    (value): value is string => Boolean(value),
  );

  for (const candidateId of preferredIds) {
    if (actorChats.some((chat) => chat.id === candidateId)) {
      return candidateId;
    }
  }

  return actorChats[0]?.id ?? "";
}

function pickNextActiveChatAfterDeletion(
  chats: ChatThread[],
  deletedChat: ChatThread,
  actorChatSelections: Record<string, string>,
): string {
  const sameActorChatId = pickActiveChatId(chats, deletedChat.actorId, null, actorChatSelections);
  if (sameActorChatId) {
    return sameActorChatId;
  }

  const nextActorId = chats[0]?.actorId ?? "";
  if (!nextActorId) {
    return "";
  }

  return pickActiveChatId(chats, nextActorId, null, actorChatSelections);
}

export default function HomePage() {
  const [actors, setActors] = useState<Actor[]>([]);
  const [chats, setChats] = useState<ChatThread[]>([]);
  const [activeActorId, setActiveActorId] = useState("");
  const [activeChatId, setActiveChatId] = useState("");
  const [actorChatSelections, setActorChatSelections] = useState<Record<string, string>>({});
  const [modalState, setModalState] = useState<ModalState>(null);
  const [hasLoadedPersistedState, setHasLoadedPersistedState] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [uiError, setUiError] = useState("");

  useEffect(() => {
    async function fetchInitialData() {
      try {
        const [actorsResponse, chatsResponse] = await Promise.all([
          fetch("/api/actors", { cache: "no-store" }),
          fetch("/api/chats", { cache: "no-store" }),
        ]);

        const actorsPayload = actorsResponse.ok
          ? ((await actorsResponse.json()) as { actors?: Actor[] })
          : { actors: [] };
        const chatsPayload = chatsResponse.ok
          ? ((await chatsResponse.json()) as { chats?: ChatThread[] })
          : { chats: [] };

        const persistedActors = actorsPayload.actors ?? [];
        const persistedActorIds = new Set(persistedActors.map((actor) => actor.id));
        const persistedChats = (chatsPayload.chats ?? []).filter((chat) =>
          persistedActorIds.has(chat.actorId),
        );
        const storedActorId = window.localStorage.getItem(ACTIVE_ACTOR_STORAGE_KEY);
        const storedChatId = window.localStorage.getItem(ACTIVE_CHAT_STORAGE_KEY);
        const storedActorSelections = window.localStorage.getItem(
          ACTOR_CHAT_SELECTIONS_STORAGE_KEY,
        );
        const nextActorChatSelections = storedActorSelections
          ? (JSON.parse(storedActorSelections) as Record<string, string>)
          : {};
        const validActorIds = new Set(persistedActors.map((actor) => actor.id));
        const chatById = new Map(persistedChats.map((chat) => [chat.id, chat]));
        const sanitizedActorChatSelections = Object.fromEntries(
          Object.entries(nextActorChatSelections).filter(
            ([actorId, chatId]) =>
              validActorIds.has(actorId) &&
              chatById.has(chatId) &&
              chatById.get(chatId)?.actorId === actorId,
          ),
        );
        const nextActiveActorId = pickActiveActorId(persistedActors, storedActorId);
        const nextActiveChatId = pickActiveChatId(
          persistedChats,
          nextActiveActorId,
          storedChatId,
          sanitizedActorChatSelections,
        );

        setActors(persistedActors);
        setChats(persistedChats);
        setActorChatSelections(sanitizedActorChatSelections);
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
    if (!hasLoadedPersistedState) {
      return;
    }

    window.localStorage.setItem(
      ACTOR_CHAT_SELECTIONS_STORAGE_KEY,
      JSON.stringify(actorChatSelections),
    );
  }, [actorChatSelections, hasLoadedPersistedState]);

  useEffect(() => {
    if (!hasLoadedPersistedState || actors.length === 0) {
      if (hasLoadedPersistedState && actors.length === 0) {
        setActorChatSelections({});
        setActiveActorId("");
        setActiveChatId("");
      }
      return;
    }

    if (!actors.some((actor) => actor.id === activeActorId)) {
      const nextActorId = pickActiveActorId(actors, null);
      setActiveActorId(nextActorId);
      setActiveChatId(pickActiveChatId(chats, nextActorId, null, actorChatSelections));
      return;
    }

    const nextChatId = pickActiveChatId(chats, activeActorId, activeChatId, actorChatSelections);
    if (nextChatId !== activeChatId) {
      setActiveChatId(nextChatId);
    }

    const validActorIds = new Set(actors.map((actor) => actor.id));
    const validChatsById = new Map(
      chats
        .filter((chat) => validActorIds.has(chat.actorId))
        .map((chat) => [chat.id, chat]),
    );
    const sanitizedSelections = Object.fromEntries(
      Object.entries(actorChatSelections).filter(
        ([actorId, chatId]) =>
          validActorIds.has(actorId) &&
          validChatsById.has(chatId) &&
          validChatsById.get(chatId)?.actorId === actorId,
      ),
    );
    if (Object.keys(sanitizedSelections).length !== Object.keys(actorChatSelections).length) {
      setActorChatSelections(sanitizedSelections);
    }
  }, [
    activeActorId,
    activeChatId,
    actorChatSelections,
    actors,
    chats,
    hasLoadedPersistedState,
  ]);

  useEffect(() => {
    if (!sidebarOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [sidebarOpen]);

  const filteredChats = useMemo(
    () => chats.filter((chat) => actors.some((actor) => actor.id === chat.actorId)),
    [actors, chats],
  );

  async function createChat(actorId: string) {
    setUiError("");
    const chatResponse = await fetch("/api/chats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: buildChatId(),
        actorId,
        title: `Chat ${new Date().toLocaleString()}`,
      }),
    });
    const chatPayload = (await chatResponse.json()) as { chat?: ChatThread; error?: string };

    if (!chatResponse.ok || !chatPayload.chat) {
      const message = chatPayload.error ?? "Failed to create chat.";
      setUiError(message);
      throw new Error(message);
    }

    const createdChat = chatPayload.chat;
    setChats((current) => [createdChat, ...current.filter((chat) => chat.id !== createdChat.id)]);
    setActorChatSelections((current) => ({ ...current, [actorId]: createdChat.id }));
    setActiveActorId(actorId);
    setActiveChatId(createdChat.id);
    setSidebarOpen(false);
  }

  async function createActor(input: { name: string; purpose?: string; parentId?: string }) {
    setUiError("");
    const actorResponse = await fetch("/api/actors", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });

    const actorPayload = (await actorResponse.json()) as { actor?: Actor; error?: string };

    if (!actorResponse.ok || !actorPayload.actor) {
      throw new Error(actorPayload.error ?? "Failed to create actor.");
    }

    const createdActor = actorPayload.actor;
    setActors((current) => [...current.filter((actor) => actor.id !== createdActor.id), createdActor]);
    setSidebarOpen(false);
    try {
      await createChat(createdActor.id);
    } catch {
      // createChat already writes user-facing UI error state.
    }
  }

  async function deleteActor(actor: Actor) {
    setUiError("");
    const response = await fetch(`/api/actors?id=${encodeURIComponent(actor.id)}`, {
      method: "DELETE",
    });

    const payload = (await response.json()) as { deletedActorIds?: string[]; error?: string };

    if (!response.ok || !payload.deletedActorIds?.length) {
      throw new Error(payload.error ?? "Failed to delete actor.");
    }

    const deletedIds = new Set(payload.deletedActorIds);
    const nextActors = actors.filter((item) => !deletedIds.has(item.id));
    const nextChats = chats.filter((chat) => !deletedIds.has(chat.actorId));
    const nextSelections = Object.fromEntries(
      Object.entries(actorChatSelections).filter(
        ([actorId, chatId]) => !deletedIds.has(actorId) && nextChats.some((chat) => chat.id === chatId),
      ),
    );
    const nextActiveActorId = deletedIds.has(activeActorId)
      ? pickActiveActorId(nextActors, null)
      : activeActorId;
    const nextActiveChatId = pickActiveChatId(
      nextChats,
      nextActiveActorId,
      deletedIds.has(activeChatId) ? null : activeChatId,
      nextSelections,
    );

    setActors(nextActors);
    setChats(nextChats);
    setActorChatSelections(nextSelections);
    setActiveActorId(nextActiveActorId);
    setActiveChatId(nextActiveChatId);
  }

  async function deleteChat(chat: ChatThread) {
    setUiError("");
    const response = await fetch(`/api/chats?id=${encodeURIComponent(chat.id)}`, {
      method: "DELETE",
    });

    const payload = (await response.json()) as { deletedChatId?: string; error?: string };

    if (!response.ok || payload.deletedChatId !== chat.id) {
      throw new Error(payload.error ?? "Failed to delete chat.");
    }

    const nextChats = chats.filter((item) => item.id !== chat.id);
    const nextSelections = Object.fromEntries(
      Object.entries(actorChatSelections).flatMap(([actorId, chatId]) => {
        if (chatId !== chat.id) {
          return [[actorId, chatId]];
        }

        const nextChatId = pickActiveChatId(nextChats, actorId, null, actorChatSelections);
        return nextChatId ? [[actorId, nextChatId]] : [];
      }),
    );
    const nextActiveChatId =
      activeChatId === chat.id
        ? pickNextActiveChatAfterDeletion(nextChats, chat, nextSelections)
        : activeChatId;
    const nextActiveActorId =
      activeChatId === chat.id && nextActiveChatId
        ? nextChats.find((item) => item.id === nextActiveChatId)?.actorId ?? activeActorId
        : activeActorId;

    setChats(nextChats);
    setActorChatSelections(nextSelections);
    setActiveActorId(nextActiveActorId);
    setActiveChatId(nextActiveChatId);
  }

  function handleSelectActor(nextActorId: string) {
    setActiveActorId(nextActorId);
    setActiveChatId((current) =>
      pickActiveChatId(chats, nextActorId, current, actorChatSelections),
    );
    setSidebarOpen(false);
  }

  function handleSelectChat(nextChatId: string) {
    const selectedChat = chats.find((chat) => chat.id === nextChatId);
    if (!selectedChat) {
      return;
    }

    setActiveActorId(selectedChat.actorId);
    setActiveChatId(nextChatId);
    setActorChatSelections((current) => ({ ...current, [selectedChat.actorId]: nextChatId }));
    setSidebarOpen(false);
  }

  return (
    <div className="relative min-h-dvh px-3 py-3 text-zinc-100 sm:px-5 sm:py-4 lg:h-dvh lg:overflow-hidden lg:px-6 lg:py-6">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-white/[0.03] to-transparent" />
        <div className="absolute left-[8%] top-20 h-56 w-56 rounded-full bg-sky-500/10 blur-3xl" />
        <div className="absolute right-[10%] top-12 h-64 w-64 rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="absolute bottom-[-6rem] left-1/3 h-72 w-72 rounded-full bg-indigo-500/10 blur-3xl" />
      </div>

      <div className="relative mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1600px] overflow-hidden rounded-[28px] border border-white/10 bg-zinc-950/70 shadow-[0_40px_120px_rgba(0,0,0,0.55)] backdrop-blur-xl lg:h-[calc(100dvh-3rem)] lg:min-h-0">
        <div className="pointer-events-none absolute inset-0 rounded-[28px] ring-1 ring-inset ring-white/5" />
        <button
          type="button"
          className="absolute left-4 top-4 z-30 inline-flex min-h-10 items-center gap-2 rounded-xl border border-white/10 bg-zinc-900/75 px-3 py-2 text-sm font-medium text-zinc-100 shadow-[0_10px_30px_rgba(0,0,0,0.35)] backdrop-blur-sm transition hover:bg-zinc-900/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 lg:hidden"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open sidebar"
        >
          <span aria-hidden>☰</span>
          <span>Actors</span>
        </button>

        <div className="hidden h-full min-h-0 w-80 min-w-[20rem] max-w-[22rem] flex-none border-r border-white/10 lg:flex">
          <Sidebar
            actors={actors}
            chats={filteredChats}
            activeActorId={activeActorId}
            activeChatId={activeChatId}
            onSelectActor={handleSelectActor}
            onSelectChat={handleSelectChat}
            onCreateChat={createChat}
            onOpenCreateActor={() => setModalState({ type: "primary" })}
            onOpenCreateSubActor={(actor) => setModalState({ type: "sub", parentActor: actor })}
            onDeleteActor={deleteActor}
            onDeleteChat={deleteChat}
            onError={setUiError}
          />
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <ChatPanel actorId={activeActorId} chatId={activeChatId} />
        </div>

        <div
          className={[
            "absolute inset-0 z-40 bg-black/60 backdrop-blur-[1px] transition-opacity duration-200 lg:hidden",
            sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0",
          ].join(" ")}
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
        <aside
          className={[
            "absolute inset-y-0 left-0 z-50 w-[min(22rem,86vw)] border-r border-white/10 shadow-[0_24px_80px_rgba(0,0,0,0.5)] transition-transform duration-200 ease-out lg:hidden",
            sidebarOpen ? "translate-x-0" : "-translate-x-full",
          ].join(" ")}
          aria-hidden={!sidebarOpen}
        >
          <Sidebar
            actors={actors}
            chats={filteredChats}
            activeActorId={activeActorId}
            activeChatId={activeChatId}
            onSelectActor={handleSelectActor}
            onSelectChat={handleSelectChat}
            onCreateChat={createChat}
            onOpenCreateActor={() => setModalState({ type: "primary" })}
            onOpenCreateSubActor={(actor) => setModalState({ type: "sub", parentActor: actor })}
            onDeleteActor={deleteActor}
            onDeleteChat={deleteChat}
            onError={setUiError}
          />
        </aside>
      </div>

      {uiError ? (
        <div className="relative mx-auto mt-3 max-w-[1600px] rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          {uiError}
        </div>
      ) : null}

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

import type { Actor, ChatThread, Message } from "@/lib/types/chat";

const memoryMessages = new Map<string, Message[]>();
const memorySummaries = new Map<string, string>();
const memoryActors = new Map<string, Actor>();
const memoryChats = new Map<string, ChatThread>();
const deletedActorIds = new Set<string>();

const base = process.env.BLOB_BASE_URL ?? process.env.BLOB_URL;
const writeToken = process.env.BLOB_READ_WRITE_TOKEN ?? process.env.BLOB_WRITE_TOKEN;

function getBlobBaseUrl(): string | null {
  return base ?? null;
}

function getBlobWriteConfig(): { baseUrl: string; token: string } | null {
  if (!base || !writeToken) {
    return null;
  }

  return { baseUrl: base, token: writeToken };
}

async function blobGet<T>(path: string): Promise<T | null> {
  const baseUrl = getBlobBaseUrl();
  if (!baseUrl) {
    return null;
  }

  const response = await fetch(`${baseUrl}/${path}`, {
    cache: "no-store",
    headers: {
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
    },
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as T;
}

async function blobPut(path: string, payload: unknown): Promise<void> {
  const writeConfig = getBlobWriteConfig();
  if (!writeConfig) {
    return;
  }

  const response = await fetch(`${writeConfig.baseUrl}/${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${writeConfig.token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Failed to PUT ${path}: ${response.status} ${response.statusText}`);
  }
}

async function blobDelete(path: string): Promise<void> {
  const writeConfig = getBlobWriteConfig();
  if (!writeConfig) {
    return;
  }

  await fetch(`${writeConfig.baseUrl}/${path}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${writeConfig.token}`,
    },
  });
}

function sortChats(chats: ChatThread[]): ChatThread[] {
  return [...chats].sort((left, right) => {
    const leftTimestamp = left.updatedAt ?? left.createdAt;
    const rightTimestamp = right.updatedAt ?? right.createdAt;

    return rightTimestamp.localeCompare(leftTimestamp) || left.title.localeCompare(right.title);
  });
}

async function getDeletedActorIds(): Promise<string[]> {
  const deletedFromBlob = (await blobGet<string[]>("actors/deleted-index.json")) ?? [];

  deletedFromBlob.forEach((actorId) => {
    deletedActorIds.add(actorId);
  });

  return [...deletedActorIds];
}

export async function getActorById(actorId: string): Promise<Actor | null> {
  const deletedIds = await getDeletedActorIds();
  if (deletedIds.includes(actorId)) {
    return null;
  }

  const memoryActor = memoryActors.get(actorId);
  if (memoryActor) {
    return memoryActor;
  }

  const path = `actors/${actorId}.json`;
  const retries = 3;
  const baseDelayMs = 400;
  const baseUrl = getBlobBaseUrl();

  if (baseUrl) {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const actor = await blobGet<Actor>(path);
        if (actor) {
          memoryActors.set(actor.id, actor);
          return actor;
        }

        throw new Error(`Actor not found in Blob yet: ${actorId}`);
      } catch {
        if (attempt < retries - 1) {
          const delayMs = baseDelayMs * (attempt + 1);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
  }

  return null;
}

export async function listActors(): Promise<Actor[]> {
  const deletedIds = await getDeletedActorIds();
  const deleted = new Set(deletedIds);
  const blobActorIds = (await blobGet<string[]>("actors/index.json")) ?? [];

  const blobActors = (
    await Promise.all(blobActorIds.map(async (actorId) => blobGet<Actor>(`actors/${actorId}.json`)))
  ).filter((actor): actor is Actor => Boolean(actor));

  blobActors.forEach((actor) => {
    memoryActors.set(actor.id, actor);
  });

  const deduped = new Map<string, Actor>();
  [...memoryActors.values(), ...blobActors].forEach((actor) => {
    if (!deleted.has(actor.id)) {
      deduped.set(actor.id, actor);
    }
  });

  return [...deduped.values()];
}

export async function getChatById(chatId: string): Promise<ChatThread | null> {
  const memoryChat = memoryChats.get(chatId);
  if (memoryChat) {
    return memoryChat;
  }

  const chat = await blobGet<ChatThread>(`chats/${chatId}.json`);
  if (chat) {
    memoryChats.set(chat.id, chat);
    return chat;
  }

  return null;
}

export async function listChats(): Promise<ChatThread[]> {
  const blobChatIds = (await blobGet<string[]>("chats/index.json")) ?? [];

  const blobChats = (
    await Promise.all(blobChatIds.map(async (chatId) => blobGet<ChatThread>(`chats/${chatId}.json`)))
  ).filter((chat): chat is ChatThread => Boolean(chat));

  blobChats.forEach((chat) => {
    memoryChats.set(chat.id, chat);
  });

  const deduped = new Map<string, ChatThread>();
  [...memoryChats.values(), ...blobChats].forEach((chat) => {
    deduped.set(chat.id, chat);
  });

  return sortChats([...deduped.values()]);
}

export async function listChatsByActorId(actorId: string): Promise<ChatThread[]> {
  const chats = await listChats();
  return chats.filter((chat) => chat.actorId === actorId);
}

export async function saveChat(chat: ChatThread): Promise<ChatThread> {
  const now = new Date().toISOString();
  const nextChat: ChatThread = {
    ...chat,
    title: chat.title.trim(),
    createdAt: chat.createdAt ?? now,
    updatedAt: now,
  };

  memoryChats.set(nextChat.id, nextChat);
  await blobPut(`chats/${nextChat.id}.json`, nextChat);

  const currentIndex = (await blobGet<string[]>("chats/index.json")) ?? [];
  if (!currentIndex.includes(nextChat.id)) {
    await blobPut("chats/index.json", [...currentIndex, nextChat.id]);
  }

  return nextChat;
}

export async function deleteChat(chatId: string): Promise<void> {
  memoryChats.delete(chatId);
  memoryMessages.delete(chatId);
  memorySummaries.delete(chatId);

  const currentIndex = (await blobGet<string[]>("chats/index.json")) ?? [];
  const nextIndex = currentIndex.filter((currentChatId) => currentChatId !== chatId);

  await blobPut("chats/index.json", nextIndex);
  await Promise.all([
    blobDelete(`chats/${chatId}.json`),
    blobDelete(`messages/${chatId}.json`),
    blobDelete(`summaries/${chatId}.json`),
  ]);
}

export async function deleteChatById(chatId: string): Promise<void> {
  await deleteChat(chatId);
}

export async function getMessages(chatId: string): Promise<Message[]> {
  const blobMessages = await blobGet<Message[]>(`messages/${chatId}.json`);
  if (blobMessages) {
    memoryMessages.set(chatId, blobMessages);
    return blobMessages;
  }

  return memoryMessages.get(chatId) ?? [];
}

export async function getRecentMessages(chatId: string, limit = 20): Promise<Message[]> {
  const messages = await getMessages(chatId);
  return messages.slice(-limit);
}

export async function saveMessage(chatId: string, message: Omit<Message, "chatId" | "createdAt"> & Partial<Pick<Message, "chatId" | "createdAt">>): Promise<Message> {
  const current = await getMessages(chatId);
  const nextMessage: Message = {
    ...message,
    chatId,
    createdAt: message.createdAt ?? new Date().toISOString(),
  };
  const nextMessages = [...current, nextMessage];

  memoryMessages.set(chatId, nextMessages);
  await blobPut(`messages/${chatId}.json`, nextMessages);

  const existingChat = await getChatById(chatId);
  if (existingChat) {
    await saveChat({
      ...existingChat,
      updatedAt: new Date().toISOString(),
    });
  }

  return nextMessage;
}

export async function getConversationSummary(chatId: string): Promise<string> {
  const summary = await blobGet<string>(`summaries/${chatId}.json`);
  return summary ?? memorySummaries.get(chatId) ?? "";
}

export async function setConversationSummary(chatId: string, summary: string): Promise<void> {
  memorySummaries.set(chatId, summary);
  await blobPut(`summaries/${chatId}.json`, summary);
}

export async function saveActor(actor: Actor): Promise<void> {
  const actorPath = `actors/${actor.id}.json`;

  deletedActorIds.delete(actor.id);
  memoryActors.set(actor.id, actor);

  const deletedIndex = (await blobGet<string[]>("actors/deleted-index.json")) ?? [];
  if (deletedIndex.includes(actor.id)) {
    const nextDeletedIndex = deletedIndex.filter((deletedId) => deletedId !== actor.id);
    await blobPut("actors/deleted-index.json", nextDeletedIndex);
  }

  await blobPut(actorPath, actor);

  const currentIndex = (await blobGet<string[]>("actors/index.json")) ?? [];
  if (!currentIndex.includes(actor.id)) {
    await blobPut("actors/index.json", [...currentIndex, actor.id]);
  }
}

export async function deleteActorsById(actorIds: string[]): Promise<void> {
  if (!actorIds.length) {
    return;
  }

  const currentIndex = (await blobGet<string[]>("actors/index.json")) ?? [];
  const nextIndex = currentIndex.filter((actorId) => !actorIds.includes(actorId));

  await blobPut("actors/index.json", nextIndex);

  actorIds.forEach((actorId) => {
    deletedActorIds.add(actorId);
    memoryActors.delete(actorId);
  });

  const chatsToDelete = (await listChats()).filter((chat) => actorIds.includes(chat.actorId));

  await Promise.all([
    ...actorIds.map(async (actorId) => blobDelete(`actors/${actorId}.json`)),
    ...chatsToDelete.map(async (chat) => deleteChat(chat.id)),
  ]);
  await blobPut("actors/deleted-index.json", [...deletedActorIds]);
}

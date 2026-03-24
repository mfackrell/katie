import type { Actor, ChatThread, Message } from "@/lib/types/chat";

const memoryMessages = new Map<string, Message[]>();
const memorySummaries = new Map<string, string>();
const memoryActors = new Map<string, Actor>();
const memoryChats = new Map<string, ChatThread>();
const deletedActorIds = new Set<string>();

const ACTOR_INDEX_PATH = "actors/index.json";
const ACTOR_REGISTRY_PATH = "actors/registry.json";
const ACTOR_DELETED_INDEX_PATH = "actors/deleted-index.json";
const CHAT_INDEX_PATH = "chats/index.json";
const CHAT_REGISTRY_PATH = "chats/registry.json";
const BLOB_PATH_MAP_PATH = "_meta/blob-path-map.json";
const BLOB_API_BASE_URL = "https://blob.vercel-storage.com";

const base = process.env.BLOB_BASE_URL ?? process.env.BLOB_URL;
const writeToken = process.env.BLOB_READ_WRITE_TOKEN ?? process.env.BLOB_WRITE_TOKEN;
const allowMemoryFallback = process.env.KATIE_ALLOW_MEMORY_FALLBACK === "true";

type PersistenceMode = "durable" | "memory-fallback";

class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceError";
  }
}

function getBlobBaseUrl(): string | null {
  return base ?? null;
}

function getPersistenceMode(): PersistenceMode {
  return allowMemoryFallback ? "memory-fallback" : "durable";
}

function isMemoryFallbackMode(): boolean {
  return getPersistenceMode() === "memory-fallback";
}

function requireBlobBaseUrl(): string {
  const baseUrl = getBlobBaseUrl();
  if (baseUrl) {
    return baseUrl;
  }

  throw new PersistenceError(
    "Durable persistence is required but blob read configuration is missing. Set BLOB_BASE_URL (or BLOB_URL), or explicitly enable KATIE_ALLOW_MEMORY_FALLBACK=true for local/demo mode."
  );
}

function getBlobWriteConfig(): { baseUrl: string; token: string } | null {
  if (!base || !writeToken) {
    return null;
  }

  return { baseUrl: base, token: writeToken };
}

function requireBlobWriteConfig(): { baseUrl: string; token: string } {
  const writeConfig = getBlobWriteConfig();
  if (writeConfig) {
    return writeConfig;
  }

  throw new PersistenceError(
    "Durable persistence is required but blob write configuration is missing. Set BLOB_READ_WRITE_TOKEN (or BLOB_WRITE_TOKEN), or explicitly enable KATIE_ALLOW_MEMORY_FALLBACK=true for local/demo mode."
  );
}

function resolveBlobPath(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedPath}`;
}

async function blobFetchJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new PersistenceError(`Failed to GET ${url}: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

let blobPathMapCache: Record<string, string> | null = null;

async function getBlobPathMap(): Promise<Record<string, string>> {
  if (blobPathMapCache) {
    return blobPathMapCache;
  }

  const baseUrl = getBlobBaseUrl();
  if (!baseUrl) {
    blobPathMapCache = {};
    return blobPathMapCache;
  }

  const pathMap = await blobFetchJson<Record<string, string>>(resolveBlobPath(baseUrl, BLOB_PATH_MAP_PATH));
  blobPathMapCache = pathMap ?? {};
  return blobPathMapCache;
}

async function persistBlobPathMap(pathMap: Record<string, string>, token: string): Promise<void> {
  const response = await fetch(
    `${BLOB_API_BASE_URL}/${encodeURI(BLOB_PATH_MAP_PATH)}?addRandomSuffix=false&allowOverwrite=true`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-content-type": "application/json",
      },
      body: JSON.stringify(pathMap),
    }
  );

  if (!response.ok) {
    throw new PersistenceError(
      `Failed to PUT ${BLOB_PATH_MAP_PATH}: ${response.status} ${response.statusText}`
    );
  }
}

async function blobUploadJson(path: string, payload: unknown, token: string): Promise<string> {
  const response = await fetch(
    `${BLOB_API_BASE_URL}/${encodeURI(path)}?addRandomSuffix=false&allowOverwrite=true`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    throw new PersistenceError(`Failed to PUT ${path}: ${response.status} ${response.statusText}`);
  }

  const uploaded = (await response.json()) as { url?: string };
  if (!uploaded.url) {
    throw new PersistenceError(`Failed to PUT ${path}: missing blob URL in response.`);
  }

  return uploaded.url;
}

async function blobDeleteByPathOrUrl(pathOrUrl: string, token: string): Promise<void> {
  const targetPath = pathOrUrl.startsWith("http")
    ? (() => {
        try {
          return new URL(pathOrUrl).pathname.slice(1);
        } catch {
          return pathOrUrl;
        }
      })()
    : pathOrUrl;

  const response = await fetch(`${BLOB_API_BASE_URL}/${encodeURI(targetPath)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 404) {
    return;
  }

  if (!response.ok) {
    throw new PersistenceError(
      `Failed to DELETE ${pathOrUrl}: ${response.status} ${response.statusText}`
    );
  }
}

function canUseBlobReads(): boolean {
  return Boolean(getBlobBaseUrl());
}

function canUseBlobWrites(): boolean {
  return Boolean(getBlobWriteConfig());
}

export function getPersistenceDiagnostics(): {
  mode: PersistenceMode;
  blobReadConfigured: boolean;
  blobWriteConfigured: boolean;
  ready: boolean;
} {
  const mode = getPersistenceMode();
  const blobReadConfigured = canUseBlobReads();
  const blobWriteConfigured = canUseBlobWrites();
  return {
    mode,
    blobReadConfigured,
    blobWriteConfigured,
    ready: mode === "memory-fallback" ? true : blobReadConfigured && blobWriteConfigured,
  };
}

function logPersistenceStatus(): void {
  const diagnostics = getPersistenceDiagnostics();
  if (diagnostics.mode === "memory-fallback") {
    console.warn("[BlobStore] Running in explicit memory fallback mode (KATIE_ALLOW_MEMORY_FALLBACK=true). Data is not durable.");
    return;
  }

  if (!diagnostics.ready) {
    console.error(
      `[BlobStore] Durable persistence is not ready. blobReadConfigured=${diagnostics.blobReadConfigured}, blobWriteConfigured=${diagnostics.blobWriteConfigured}.`
    );
    return;
  }

  console.info("[BlobStore] Durable blob persistence is configured.");
}

logPersistenceStatus();

async function blobGet<T>(path: string): Promise<T | null> {
  const baseUrl =
    getPersistenceMode() === "memory-fallback"
      ? getBlobBaseUrl()
      : requireBlobBaseUrl();
  if (!baseUrl) {
    return null;
  }
  const directValue = await blobFetchJson<T>(resolveBlobPath(baseUrl, path));
  if (directValue !== null) {
    return directValue;
  }

  if (path === BLOB_PATH_MAP_PATH) {
    return null;
  }

  const pathMap = await getBlobPathMap();
  const mappedUrl = pathMap[path];
  if (!mappedUrl) {
    return null;
  }

  return blobFetchJson<T>(mappedUrl);
}

async function blobPut(path: string, payload: unknown): Promise<void> {
  const writeConfig =
    getPersistenceMode() === "memory-fallback"
      ? getBlobWriteConfig()
      : requireBlobWriteConfig();
  if (!writeConfig) {
    return;
  }

  const blobUrl = await blobUploadJson(path, payload, writeConfig.token);

  if (path === BLOB_PATH_MAP_PATH) {
    return;
  }

  const pathMap = await getBlobPathMap();
  if (pathMap[path] !== blobUrl) {
    const nextPathMap = { ...pathMap, [path]: blobUrl };
    blobPathMapCache = nextPathMap;
    await persistBlobPathMap(nextPathMap, writeConfig.token);
  }
}

async function blobDelete(path: string): Promise<void> {
  const writeConfig =
    getPersistenceMode() === "memory-fallback"
      ? getBlobWriteConfig()
      : requireBlobWriteConfig();
  if (!writeConfig) {
    return;
  }

  const pathMap = await getBlobPathMap();
  const deleteTarget = pathMap[path] ?? path;
  await blobDeleteByPathOrUrl(deleteTarget, writeConfig.token);

  if (pathMap[path]) {
    const nextPathMap = { ...pathMap };
    delete nextPathMap[path];
    blobPathMapCache = nextPathMap;
    await persistBlobPathMap(nextPathMap, writeConfig.token);
  }
}

function sortChats(chats: ChatThread[]): ChatThread[] {
  return [...chats].sort((left, right) => {
    const leftTimestamp = left.updatedAt ?? left.createdAt;
    const rightTimestamp = right.updatedAt ?? right.createdAt;

    return rightTimestamp.localeCompare(leftTimestamp) || left.title.localeCompare(right.title);
  });
}

async function blobGetWithRetry<T>(path: string, retries = 3, baseDelayMs = 250): Promise<T | null> {
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const value = await blobGet<T>(path);
      if (value !== null) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < retries - 1) {
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

async function readActorRegistry(): Promise<Actor[]> {
  return (await blobGetWithRetry<Actor[]>(ACTOR_REGISTRY_PATH)) ?? [];
}

async function writeActorRegistry(actors: Actor[]): Promise<void> {
  await blobPut(ACTOR_REGISTRY_PATH, actors);
}

async function readChatRegistry(): Promise<ChatThread[]> {
  return (await blobGetWithRetry<ChatThread[]>(CHAT_REGISTRY_PATH)) ?? [];
}

async function writeChatRegistry(chats: ChatThread[]): Promise<void> {
  await blobPut(CHAT_REGISTRY_PATH, sortChats(chats));
}

async function getDeletedActorIds(): Promise<string[]> {
  const deletedFromBlob = (await blobGet<string[]>(ACTOR_DELETED_INDEX_PATH)) ?? [];

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

  if (isMemoryFallbackMode()) {
    const memoryActor = memoryActors.get(actorId);
    if (memoryActor) {
      return memoryActor;
    }
  }

  const actorFromBlob = await blobGetWithRetry<Actor>(`actors/${actorId}.json`);
  if (actorFromBlob) {
    memoryActors.set(actorFromBlob.id, actorFromBlob);
    return actorFromBlob;
  }

  const registryActor = (await readActorRegistry()).find((actor) => actor.id === actorId) ?? null;
  if (registryActor) {
    memoryActors.set(registryActor.id, registryActor);
  }

  return registryActor;
}

export async function listActors(): Promise<Actor[]> {
  const deletedIds = await getDeletedActorIds();
  const deleted = new Set(deletedIds);
  const registryActors = await readActorRegistry();
  const blobActorIds = (await blobGetWithRetry<string[]>(ACTOR_INDEX_PATH)) ?? [];
  const indexedActors = (
    await Promise.all(blobActorIds.map(async (actorId) => blobGetWithRetry<Actor>(`actors/${actorId}.json`)))
  ).filter((actor): actor is Actor => Boolean(actor));

  const deduped = new Map<string, Actor>();
  [...registryActors, ...indexedActors].forEach((actor) => {
    if (!deleted.has(actor.id)) {
      deduped.set(actor.id, actor);
    }
  });

  if (isMemoryFallbackMode()) {
    [...memoryActors.values()].forEach((actor) => {
      if (!deleted.has(actor.id)) {
        deduped.set(actor.id, actor);
      }
    });
  }

  const durableActors = [...deduped.values()];
  durableActors.forEach((actor) => {
    memoryActors.set(actor.id, actor);
  });

  return durableActors;
}

export async function getChatById(chatId: string): Promise<ChatThread | null> {
  const memoryChat = memoryChats.get(chatId);
  if (memoryChat) {
    return memoryChat;
  }

  const chatFromBlob = await blobGetWithRetry<ChatThread>(`chats/${chatId}.json`);
  if (chatFromBlob) {
    memoryChats.set(chatFromBlob.id, chatFromBlob);
    return chatFromBlob;
  }

  const registryChat = (await readChatRegistry()).find((chat) => chat.id === chatId) ?? null;
  if (registryChat) {
    memoryChats.set(registryChat.id, registryChat);
  }

  return registryChat;
}

export async function listChats(): Promise<ChatThread[]> {
  const registryChats = await readChatRegistry();

  registryChats.forEach((chat) => {
    memoryChats.set(chat.id, chat);
  });

  let blobChats = registryChats;
  if (blobChats.length === 0) {
    const blobChatIds = (await blobGetWithRetry<string[]>(CHAT_INDEX_PATH)) ?? [];
    blobChats = (
      await Promise.all(blobChatIds.map(async (chatId) => blobGetWithRetry<ChatThread>(`chats/${chatId}.json`)))
    ).filter((chat): chat is ChatThread => Boolean(chat));

    blobChats.forEach((chat) => {
      memoryChats.set(chat.id, chat);
    });
  }

  const actors = await listActors();
  const validActorIds = new Set(actors.map((actor) => actor.id));
  const deduped = new Map<string, ChatThread>();
  [...blobChats, ...memoryChats.values()].forEach((chat) => {
    if (validActorIds.has(chat.actorId)) {
      deduped.set(chat.id, chat);
    }
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

  const [currentIndex, registryChats] = await Promise.all([
    blobGetWithRetry<string[]>(CHAT_INDEX_PATH).then((value) => value ?? []),
    readChatRegistry(),
  ]);

  const nextRegistry = [
    nextChat,
    ...registryChats.filter((currentChat) => currentChat.id !== nextChat.id),
  ];

  await Promise.all([
    blobPut(`chats/${nextChat.id}.json`, nextChat),
    currentIndex.includes(nextChat.id) ? Promise.resolve() : blobPut(CHAT_INDEX_PATH, [...currentIndex, nextChat.id]),
    writeChatRegistry(nextRegistry),
  ]);

  memoryChats.set(nextChat.id, nextChat);

  return nextChat;
}

export async function deleteChat(chatId: string): Promise<void> {
  const [currentIndex, registryChats] = await Promise.all([
    blobGetWithRetry<string[]>(CHAT_INDEX_PATH).then((value) => value ?? []),
    readChatRegistry(),
  ]);
  const nextIndex = currentIndex.filter((currentChatId) => currentChatId !== chatId);
  const nextRegistry = registryChats.filter((chat) => chat.id !== chatId);

  await Promise.all([
    blobPut(CHAT_INDEX_PATH, nextIndex),
    writeChatRegistry(nextRegistry),
    blobDelete(`chats/${chatId}.json`),
    blobDelete(`messages/${chatId}.json`),
    blobDelete(`summaries/${chatId}.json`),
  ]);

  memoryChats.delete(chatId);
  memoryMessages.delete(chatId);
  memorySummaries.delete(chatId);
}

export async function deleteChatById(chatId: string): Promise<void> {
  await deleteChat(chatId);
}

export async function getMessages(chatId: string): Promise<Message[]> {
  const blobMessages = await blobGetWithRetry<Message[]>(`messages/${chatId}.json`);
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

  await blobPut(`messages/${chatId}.json`, nextMessages);
  memoryMessages.set(chatId, nextMessages);

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
  const summary = await blobGetWithRetry<string>(`summaries/${chatId}.json`);
  if (summary !== null) {
    memorySummaries.set(chatId, summary);
    return summary;
  }

  return memorySummaries.get(chatId) ?? "";
}

export async function setConversationSummary(chatId: string, summary: string): Promise<void> {
  await blobPut(`summaries/${chatId}.json`, summary);
  memorySummaries.set(chatId, summary);
}

export async function saveActor(actor: Actor): Promise<void> {
  const actorPath = `actors/${actor.id}.json`;

  const [deletedIndex, currentIndex, registryActors] = await Promise.all([
    blobGetWithRetry<string[]>(ACTOR_DELETED_INDEX_PATH).then((value) => value ?? []),
    blobGetWithRetry<string[]>(ACTOR_INDEX_PATH).then((value) => value ?? []),
    readActorRegistry(),
  ]);

  const nextDeletedIndex = deletedIndex.filter((deletedId) => deletedId !== actor.id);
  const nextRegistry = [...registryActors.filter((currentActor) => currentActor.id !== actor.id), actor];

  await Promise.all([
    deletedIndex.includes(actor.id) ? blobPut(ACTOR_DELETED_INDEX_PATH, nextDeletedIndex) : Promise.resolve(),
    blobPut(actorPath, actor),
    currentIndex.includes(actor.id) ? Promise.resolve() : blobPut(ACTOR_INDEX_PATH, [...currentIndex, actor.id]),
    writeActorRegistry(nextRegistry),
  ]);

  deletedActorIds.delete(actor.id);
  memoryActors.set(actor.id, actor);
}

export async function deleteActorsById(actorIds: string[]): Promise<void> {
  if (!actorIds.length) {
    return;
  }

  const [currentIndex, registryActors] = await Promise.all([
    blobGetWithRetry<string[]>(ACTOR_INDEX_PATH).then((value) => value ?? []),
    readActorRegistry(),
  ]);
  const nextIndex = currentIndex.filter((actorId) => !actorIds.includes(actorId));
  const nextRegistry = registryActors.filter((actor) => !actorIds.includes(actor.id));

  const chatsToDelete = (await listChats()).filter((chat) => actorIds.includes(chat.actorId));

  await Promise.all([
    blobPut(ACTOR_INDEX_PATH, nextIndex),
    writeActorRegistry(nextRegistry),
    ...actorIds.map(async (actorId) => blobDelete(`actors/${actorId}.json`)),
    ...chatsToDelete.map(async (chat) => deleteChat(chat.id)),
  ]);

  actorIds.forEach((actorId) => {
    deletedActorIds.add(actorId);
    memoryActors.delete(actorId);
  });

  await blobPut(ACTOR_DELETED_INDEX_PATH, [...deletedActorIds]);
}

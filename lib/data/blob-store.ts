import type { Actor, ChatThread, Message } from "@/lib/types/chat";

const memoryMessages = new Map<string, Message[]>();
const memorySummaries = new Map<string, string>();
const memoryActors = new Map<string, Actor>();
const memoryChats = new Map<string, ChatThread>();

const ACTOR_REGISTRY_PATH = "actors/registry.json";
const ACTOR_DELETED_INDEX_PATH = "actors/deleted-index.json";
const CHAT_REGISTRY_PATH = "chats/registry.json";
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

function parseBlobNamespace(urlOrBase: string): { namespace: string } | null {
  try {
    const parsed = new URL(urlOrBase);
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    return {
      namespace: `${parsed.host}${normalizedPath}`,
    };
  } catch {
    return null;
  }
}

function isUrlInReadNamespace(url: string, readBaseUrl: string): boolean {
  const urlNamespace = parseBlobNamespace(url);
  const readNamespace = parseBlobNamespace(readBaseUrl);

  if (!urlNamespace || !readNamespace) {
    return false;
  }

  return urlNamespace.namespace.startsWith(readNamespace.namespace);
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

function logPersistenceDebug(message: string, meta?: Record<string, unknown>): void {
  if (meta) {
    console.info(`[BlobStore] ${message}`, meta);
    return;
  }
  console.info(`[BlobStore] ${message}`);
}

async function verifyDurableReadAfterWrite(
  path: string,
  options?: { reason?: string }
): Promise<void> {
  if (getPersistenceMode() !== "durable") {
    return;
  }

  const baseUrl = requireBlobBaseUrl();
  const retries = 3;
  const baseDelayMs = 150;
  let verificationSucceeded = false;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const directUrl = resolveBlobPath(baseUrl, path);
    if ((await blobFetchJson<unknown>(directUrl)) !== null) {
      verificationSucceeded = true;
      break;
    }

    if (attempt < retries - 1) {
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
    }
  }

  if (!verificationSucceeded) {
    const message =
      `Durable write verification warning for "${path}": write succeeded but immediate durable read-back was not consistently visible. ` +
      "Treating as eventual-consistency/read-lag and continuing.";
    console.warn(`[BlobStore] ${message}`, {
      reason: options?.reason ?? "unspecified",
    });
    return;
  }

  logPersistenceDebug("Verified durable read after write.", {
    path,
    reason: options?.reason ?? "unspecified",
  });
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
  readBaseUrl: string | null;
  readNamespace: string | null;
  writeApiBaseUrl: string;
  ready: boolean;
} {
  const mode = getPersistenceMode();
  const readBaseUrl = getBlobBaseUrl();
  const readNamespace = readBaseUrl ? parseBlobNamespace(readBaseUrl)?.namespace ?? null : null;
  const blobReadConfigured = canUseBlobReads();
  const blobWriteConfigured = canUseBlobWrites();
  return {
    mode,
    blobReadConfigured,
    blobWriteConfigured,
    readBaseUrl,
    readNamespace,
    writeApiBaseUrl: BLOB_API_BASE_URL,
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

  logPersistenceDebug("Durable blob persistence is configured.", {
    readBaseUrl: diagnostics.readBaseUrl,
    readNamespace: diagnostics.readNamespace,
    writeConfigured: diagnostics.blobWriteConfigured,
    writeApiBaseUrl: diagnostics.writeApiBaseUrl,
  });
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
  const value = await blobFetchJson<T>(resolveBlobPath(baseUrl, path));
  if (value !== null) {
    logPersistenceDebug("Read durable blob by direct path.", { path });
  }
  return value;
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
  logPersistenceDebug("Wrote durable blob.", { path, blobUrl });

  const readBaseUrl = getBlobBaseUrl();
  if (readBaseUrl && !isUrlInReadNamespace(blobUrl, readBaseUrl)) {
    console.error("[BlobStore] Blob write completed to a namespace that does not match configured read base URL.", {
      path,
      configuredReadBaseUrl: readBaseUrl,
      configuredReadNamespace: parseBlobNamespace(readBaseUrl)?.namespace ?? "unparseable",
      writtenBlobUrl: blobUrl,
      writtenBlobNamespace: parseBlobNamespace(blobUrl)?.namespace ?? "unparseable",
      writeApiBaseUrl: BLOB_API_BASE_URL,
    });
  }

  await verifyDurableReadAfterWrite(path, {
    reason: "blob-put-direct",
  });
}

async function blobDelete(path: string): Promise<void> {
  const writeConfig =
    getPersistenceMode() === "memory-fallback"
      ? getBlobWriteConfig()
      : requireBlobWriteConfig();
  if (!writeConfig) {
    return;
  }

  await blobDeleteByPathOrUrl(path, writeConfig.token);
  logPersistenceDebug("Deleted durable blob.", { path });
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

let metadataWriteQueue: Promise<void> = Promise.resolve();

function withMetadataWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const nextOperation = metadataWriteQueue.then(operation, operation);
  metadataWriteQueue = nextOperation.then(
    () => undefined,
    () => undefined
  );
  return nextOperation;
}

let actorRegistryCache: Actor[] | null = null;
let chatRegistryCache: ChatThread[] | null = null;
let deletedActorIdsCache: string[] | null = null;

async function readActorRegistry(): Promise<Actor[]> {
  if (actorRegistryCache !== null) {
    return actorRegistryCache;
  }

  const remoteRegistry = await blobGetWithRetry<Actor[]>(ACTOR_REGISTRY_PATH);
  if (remoteRegistry !== null) {
    actorRegistryCache = remoteRegistry;
    return actorRegistryCache;
  }
  actorRegistryCache = [];
  return actorRegistryCache;
}

async function writeActorRegistry(actors: Actor[]): Promise<void> {
  await blobPut(ACTOR_REGISTRY_PATH, actors);
  actorRegistryCache = actors;
}

async function readChatRegistry(): Promise<ChatThread[]> {
  if (chatRegistryCache !== null) {
    return chatRegistryCache;
  }

  const remoteRegistry = await blobGetWithRetry<ChatThread[]>(CHAT_REGISTRY_PATH);
  if (remoteRegistry !== null) {
    chatRegistryCache = remoteRegistry;
    return chatRegistryCache;
  }
  chatRegistryCache = [];
  return chatRegistryCache;
}

async function writeChatRegistry(chats: ChatThread[]): Promise<void> {
  const sorted = sortChats(chats);
  await blobPut(CHAT_REGISTRY_PATH, sorted);
  chatRegistryCache = sorted;
}

async function getDeletedActorIds(): Promise<string[]> {
  if (deletedActorIdsCache !== null) {
    return deletedActorIdsCache;
  }

  const deletedFromBlob = await blobGetWithRetry<string[]>(ACTOR_DELETED_INDEX_PATH);
  if (deletedFromBlob !== null) {
    deletedActorIdsCache = deletedFromBlob;
  } else {
    deletedActorIdsCache = [];
  }
  return deletedActorIdsCache;
}

export async function getActorById(actorId: string): Promise<Actor | null> {
  if (!actorId.trim()) {
    return null;
  }

  if (isMemoryFallbackMode()) {
    const memoryActor = memoryActors.get(actorId);
    if (memoryActor) {
      return memoryActor;
    }
  }

  const registryActor = (await readActorRegistry()).find((actor) => actor.id === actorId) ?? null;
  if (registryActor) {
    logPersistenceDebug("Loaded actor from durable registry.", { actorId });
    memoryActors.set(registryActor.id, registryActor);
  }

  return registryActor;
}

export async function listActors(): Promise<Actor[]> {
  const registryActors = await readActorRegistry();
  const deduped = new Map<string, Actor>();
  registryActors.forEach((actor) => {
    deduped.set(actor.id, actor);
  });

  if (isMemoryFallbackMode()) {
    [...memoryActors.values()].forEach((actor) => {
      deduped.set(actor.id, actor);
    });
  }

  const durableActors = [...deduped.values()];
  logPersistenceDebug("Listed actors from durable state.", {
    registryCount: registryActors.length,
    durableCount: durableActors.length,
  });
  durableActors.forEach((actor) => {
    memoryActors.set(actor.id, actor);
  });

  return durableActors;
}

export async function getChatById(chatId: string): Promise<ChatThread | null> {
  if (!chatId.trim()) {
    return null;
  }

  if (isMemoryFallbackMode()) {
    const memoryChat = memoryChats.get(chatId);
    if (memoryChat) {
      return memoryChat;
    }
  }

  const registryChat = (await readChatRegistry()).find((chat) => chat.id === chatId) ?? null;
  if (registryChat) {
    logPersistenceDebug("Loaded chat from durable registry.", { chatId });
    memoryChats.set(registryChat.id, registryChat);
    return registryChat;
  }

  return null;
}

export async function listChats(): Promise<ChatThread[]> {
  const registryChats = await readChatRegistry();
  const actors = await listActors();
  const validActorIds = new Set(actors.map((actor) => actor.id));
  const deduped = new Map<string, ChatThread>();
  registryChats.forEach((chat) => {
    if (validActorIds.has(chat.actorId)) {
      deduped.set(chat.id, chat);
    }
  });

  if (isMemoryFallbackMode()) {
    [...memoryChats.values()].forEach((chat) => {
      if (validActorIds.has(chat.actorId)) {
        deduped.set(chat.id, chat);
      }
    });
  }

  const durableChats = sortChats([...deduped.values()]);
  durableChats.forEach((chat) => {
    memoryChats.set(chat.id, chat);
  });
  logPersistenceDebug("Listed chats from durable state.", {
    registryCount: registryChats.length,
    durableCount: durableChats.length,
    actorCount: validActorIds.size,
  });
  return durableChats;
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

  await withMetadataWriteLock(async () => {
    const registryChats = await readChatRegistry();
    const nextRegistry = [
      nextChat,
      ...registryChats.filter((currentChat) => currentChat.id !== nextChat.id),
    ];

    await blobPut(`chats/${nextChat.id}.json`, nextChat);
    await writeChatRegistry(nextRegistry);
  });
  logPersistenceDebug("Saved chat to durable state.", {
    chatId: nextChat.id,
  });

  memoryChats.set(nextChat.id, nextChat);

  return nextChat;
}

export async function deleteChat(chatId: string): Promise<void> {
  await withMetadataWriteLock(async () => {
    const registryChats = await readChatRegistry();
    const nextRegistry = registryChats.filter((chat) => chat.id !== chatId);
    await writeChatRegistry(nextRegistry);

    await blobDelete(`chats/${chatId}.json`);
    await blobDelete(`messages/${chatId}.json`);
    await blobDelete(`summaries/${chatId}.json`);
  });

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
    logPersistenceDebug("Loaded messages from durable blob.", { chatId, count: blobMessages.length });
    memoryMessages.set(chatId, blobMessages);
    return blobMessages;
  }

  return isMemoryFallbackMode() ? memoryMessages.get(chatId) ?? [] : [];
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
    logPersistenceDebug("Loaded summary from durable blob.", { chatId, length: summary.length });
    memorySummaries.set(chatId, summary);
    return summary;
  }

  return isMemoryFallbackMode() ? memorySummaries.get(chatId) ?? "" : "";
}

export async function setConversationSummary(chatId: string, summary: string): Promise<void> {
  await blobPut(`summaries/${chatId}.json`, summary);
  memorySummaries.set(chatId, summary);
}

export async function saveActor(actor: Actor): Promise<void> {
  const actorPath = `actors/${actor.id}.json`;
  await withMetadataWriteLock(async () => {
    const deletedIndex = await getDeletedActorIds();
    const registryActors = await readActorRegistry();
    const nextDeletedIndex = deletedIndex.filter((deletedId) => deletedId !== actor.id);
    const nextRegistry = [...registryActors.filter((currentActor) => currentActor.id !== actor.id), actor];

    await blobPut(actorPath, actor);
    await writeActorRegistry(nextRegistry);
    if (deletedIndex.includes(actor.id)) {
      await blobPut(ACTOR_DELETED_INDEX_PATH, nextDeletedIndex);
      deletedActorIdsCache = nextDeletedIndex;
    }
  });
  logPersistenceDebug("Saved actor to durable state.", {
    actorId: actor.id,
  });

  memoryActors.set(actor.id, actor);
}

export async function deleteActorsById(actorIds: string[]): Promise<void> {
  if (!actorIds.length) {
    return;
  }

  await withMetadataWriteLock(async () => {
    const registryActors = await readActorRegistry();
    const chatRegistry = await readChatRegistry();
    const deletedIndex = await getDeletedActorIds();
    const nextRegistry = registryActors.filter((actor) => !actorIds.includes(actor.id));
    const nextDeleted = [...new Set([...deletedIndex, ...actorIds])];
    const chatIdsToDelete = chatRegistry
      .filter((chat) => actorIds.includes(chat.actorId))
      .map((chat) => chat.id);
    const nextChatRegistry = chatRegistry.filter((chat) => !chatIdsToDelete.includes(chat.id));

    await writeActorRegistry(nextRegistry);
    await blobPut(ACTOR_DELETED_INDEX_PATH, nextDeleted);
    deletedActorIdsCache = nextDeleted;
    await writeChatRegistry(nextChatRegistry);

    for (const actorId of actorIds) {
      await blobDelete(`actors/${actorId}.json`);
    }
    for (const chatId of chatIdsToDelete) {
      await blobDelete(`chats/${chatId}.json`);
      await blobDelete(`messages/${chatId}.json`);
      await blobDelete(`summaries/${chatId}.json`);
      memoryChats.delete(chatId);
      memoryMessages.delete(chatId);
      memorySummaries.delete(chatId);
    }

    logPersistenceDebug("Deleted actors from durable state.", {
      deletedCount: actorIds.length,
      remainingRegistryCount: nextRegistry.length,
      deletedChatsCount: chatIdsToDelete.length,
    });
  });

  actorIds.forEach((actorId) => {
    memoryActors.delete(actorId);
  });
}

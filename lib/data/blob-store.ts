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
const OPTIONAL_BOOTSTRAP_PATHS = new Set<string>([
  ACTOR_REGISTRY_PATH,
  ACTOR_INDEX_PATH,
  ACTOR_DELETED_INDEX_PATH,
  CHAT_REGISTRY_PATH,
  CHAT_INDEX_PATH,
  BLOB_PATH_MAP_PATH,
]);

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

function parseBlobNamespace(urlOrBase: string): {
  raw: string;
  host: string;
  normalizedPath: string;
  namespace: string;
} | null {
  try {
    const parsed = new URL(urlOrBase);
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    return {
      raw: urlOrBase,
      host: parsed.host,
      normalizedPath,
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

let blobPathMapCache: Record<string, string> | null = null;

function logPersistenceDebug(message: string, meta?: Record<string, unknown>): void {
  if (meta) {
    console.info(`[BlobStore] ${message}`, meta);
    return;
  }
  console.info(`[BlobStore] ${message}`);
}

async function getBlobPathMap(forceRefresh = false): Promise<Record<string, string>> {
  if (!forceRefresh && blobPathMapCache) {
    return blobPathMapCache;
  }

  const baseUrl = getBlobBaseUrl();
  if (!baseUrl) {
    blobPathMapCache = {};
    return blobPathMapCache;
  }

  const pathMap = await blobFetchJson<Record<string, string>>(resolveBlobPath(baseUrl, BLOB_PATH_MAP_PATH));
  blobPathMapCache = pathMap ?? {};
  const mismatchedNamespaces = Object.entries(blobPathMapCache)
    .filter(([, mappedUrl]) => !isUrlInReadNamespace(mappedUrl, baseUrl))
    .slice(0, 5)
    .map(([path, mappedUrl]) => ({ path, mappedUrl }));
  logPersistenceDebug("Loaded blob path-map.", {
    source: forceRefresh ? "refreshed" : "cached-or-remote",
    entries: Object.keys(blobPathMapCache).length,
    readNamespace: parseBlobNamespace(baseUrl)?.namespace ?? "unparseable",
    mismatchedNamespaceEntries: mismatchedNamespaces.length,
    mismatchedNamespaceExamples: mismatchedNamespaces,
  });
  if (mismatchedNamespaces.length > 0) {
    console.error("[BlobStore] Blob path-map contains entries outside the configured read namespace.", {
      readBaseUrl: baseUrl,
      readNamespace: parseBlobNamespace(baseUrl)?.namespace ?? "unparseable",
      mismatchedNamespaceExamples: mismatchedNamespaces,
    });
  }
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

  logPersistenceDebug("Persisted blob path-map.", {
    entries: Object.keys(pathMap).length,
  });

  await verifyDurableReadAfterWrite(BLOB_PATH_MAP_PATH, {
    reason: "persist-path-map",
    expectedPathMapEntryCount: Object.keys(pathMap).length,
  });
}

async function verifyDurableReadAfterWrite(
  path: string,
  options?: { reason?: string; expectedBlobUrl?: string; expectedPathMapEntryCount?: number }
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
    const directRead = await blobFetchJson<unknown>(directUrl);

    if (directRead !== null) {
      verificationSucceeded = true;
      break;
    }

    const pathMap = await getBlobPathMap(true);
    const mappedUrl = options?.expectedBlobUrl ?? pathMap[path];
    const mappedRead = mappedUrl ? await blobFetchJson<unknown>(mappedUrl) : null;
    if (mappedRead !== null) {
      verificationSucceeded = true;
      break;
    }

    if (attempt < retries - 1) {
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
    }
  }

  if (
    verificationSucceeded &&
    path === BLOB_PATH_MAP_PATH &&
    typeof options?.expectedPathMapEntryCount === "number"
  ) {
    const refreshedPathMap = await getBlobPathMap(true);
    if (Object.keys(refreshedPathMap).length < options.expectedPathMapEntryCount) {
      verificationSucceeded = false;
    }
  }

  if (!verificationSucceeded) {
    const message =
      `Durable write verification warning for "${path}": write succeeded but immediate durable read-back was not consistently visible. ` +
      "Treating as eventual-consistency/read-lag and continuing.";
    if (path === BLOB_PATH_MAP_PATH) {
      console.warn(`[BlobStore] ${message}`, {
        reason: options?.reason ?? "unspecified",
        expectedPathMapEntryCount: options?.expectedPathMapEntryCount,
      });
      return;
    }
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
  const directValue = await blobFetchJson<T>(resolveBlobPath(baseUrl, path));
  if (directValue !== null) {
    logPersistenceDebug("Read durable blob by direct path.", { path });
    return directValue;
  }

  if (path === BLOB_PATH_MAP_PATH) {
    return null;
  }

  const pathMap = await getBlobPathMap();
  const mappedUrl = pathMap[path];
  if (!mappedUrl) {
    const logMethod = OPTIONAL_BOOTSTRAP_PATHS.has(path) ? console.info : console.warn;
    logMethod("[BlobStore] Durable blob path not found (direct/path-map miss).", {
      path,
      optionalBootstrapFile: OPTIONAL_BOOTSTRAP_PATHS.has(path),
    });
    const refreshedPathMap = await getBlobPathMap(true);
    const refreshedMappedUrl = refreshedPathMap[path];
    if (!refreshedMappedUrl) {
      if (OPTIONAL_BOOTSTRAP_PATHS.has(path)) {
        logPersistenceDebug("Optional bootstrap file is not present yet; treating as empty state.", { path });
      }
      return null;
    }

    const refreshedMappedValue = await blobFetchJson<T>(refreshedMappedUrl);
    if (refreshedMappedValue !== null) {
      logPersistenceDebug("Read durable blob by refreshed path-map URL.", { path, mappedUrl: refreshedMappedUrl });
    }
    return refreshedMappedValue;
  }

  const mappedValue = await blobFetchJson<T>(mappedUrl);
  if (mappedValue !== null) {
    logPersistenceDebug("Read durable blob by path-map URL.", { path, mappedUrl });
    return mappedValue;
  }

  if (!isUrlInReadNamespace(mappedUrl, baseUrl)) {
    throw new PersistenceError(`Durable persistence namespace mismatch for "${path}" via blob path-map.`);
  }

  const refreshedPathMap = await getBlobPathMap(true);
  const refreshedMappedUrl = refreshedPathMap[path];
  if (refreshedMappedUrl && !isUrlInReadNamespace(refreshedMappedUrl, baseUrl)) {
    throw new PersistenceError(`Durable persistence namespace mismatch for "${path}" via refreshed blob path-map.`);
  }

  if (refreshedMappedUrl && refreshedMappedUrl !== mappedUrl) {
    logPersistenceDebug("Path-map entry changed after refresh.", {
      path,
      previousMappedUrl: mappedUrl,
      refreshedMappedUrl,
    });
  }
  if (!refreshedMappedUrl) {
    return null;
  }

  const refreshedMappedValue = await blobFetchJson<T>(refreshedMappedUrl);
  if (refreshedMappedValue !== null) {
    logPersistenceDebug("Read durable blob by refreshed path-map URL.", { path, mappedUrl: refreshedMappedUrl });
  }
  return refreshedMappedValue;
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

  if (path === BLOB_PATH_MAP_PATH) {
    await verifyDurableReadAfterWrite(path, {
      reason: "blob-put-direct",
      expectedBlobUrl: blobUrl,
    });
    return;
  }

  const pathMap = await getBlobPathMap();
  if (pathMap[path] !== blobUrl) {
    const nextPathMap = { ...pathMap, [path]: blobUrl };
    blobPathMapCache = nextPathMap;
    await persistBlobPathMap(nextPathMap, writeConfig.token);
  }

  await verifyDurableReadAfterWrite(path, {
    reason: "blob-put-with-path-map",
    expectedBlobUrl: blobUrl,
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

  const pathMap = await getBlobPathMap();
  const deleteTarget = pathMap[path] ?? path;
  await blobDeleteByPathOrUrl(deleteTarget, writeConfig.token);
  logPersistenceDebug("Deleted durable blob.", { path, deleteTarget });

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
    logPersistenceDebug("Loaded actor from durable blob.", { actorId });
    memoryActors.set(actorFromBlob.id, actorFromBlob);
    return actorFromBlob;
  }

  const registryActor = (await readActorRegistry()).find((actor) => actor.id === actorId) ?? null;
  if (registryActor) {
    logPersistenceDebug("Loaded actor from durable registry.", { actorId });
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
  logPersistenceDebug("Listed actors from durable state.", {
    deletedCount: deleted.size,
    registryCount: registryActors.length,
    indexCount: blobActorIds.length,
    durableCount: durableActors.length,
  });
  durableActors.forEach((actor) => {
    memoryActors.set(actor.id, actor);
  });

  return durableActors;
}

export async function getChatById(chatId: string): Promise<ChatThread | null> {
  if (isMemoryFallbackMode()) {
    const memoryChat = memoryChats.get(chatId);
    if (memoryChat) {
      return memoryChat;
    }
  }

  const chatFromBlob = await blobGetWithRetry<ChatThread>(`chats/${chatId}.json`);
  if (chatFromBlob) {
    logPersistenceDebug("Loaded chat from durable blob.", { chatId });
    memoryChats.set(chatFromBlob.id, chatFromBlob);
    return chatFromBlob;
  }

  const registryChat = (await readChatRegistry()).find((chat) => chat.id === chatId) ?? null;
  if (registryChat) {
    logPersistenceDebug("Loaded chat from durable registry.", { chatId });
    memoryChats.set(registryChat.id, registryChat);
    return registryChat;
  }

  return isMemoryFallbackMode() ? memoryChats.get(chatId) ?? null : null;
}

export async function listChats(): Promise<ChatThread[]> {
  const registryChats = await readChatRegistry();
  const blobChatIds = (await blobGetWithRetry<string[]>(CHAT_INDEX_PATH)) ?? [];
  const indexedChats = (
    await Promise.all(blobChatIds.map(async (chatId) => blobGetWithRetry<ChatThread>(`chats/${chatId}.json`)))
  ).filter((chat): chat is ChatThread => Boolean(chat));

  const actors = await listActors();
  const validActorIds = new Set(actors.map((actor) => actor.id));
  const deduped = new Map<string, ChatThread>();
  [...registryChats, ...indexedChats].forEach((chat) => {
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
    indexCount: blobChatIds.length,
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
  logPersistenceDebug("Saved chat to durable state.", {
    chatId: nextChat.id,
    indexHadChat: currentIndex.includes(nextChat.id),
    registrySize: nextRegistry.length,
  });

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
  logPersistenceDebug("Saved actor to durable state.", {
    actorId: actor.id,
    indexHadActor: currentIndex.includes(actor.id),
    registrySize: nextRegistry.length,
    removedFromDeletedIndex: deletedIndex.includes(actor.id),
  });

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
  logPersistenceDebug("Deleted actors from durable state.", {
    deletedCount: actorIds.length,
    remainingIndexCount: nextIndex.length,
    remainingRegistryCount: nextRegistry.length,
    deletedChatsCount: chatsToDelete.length,
  });

  actorIds.forEach((actorId) => {
    deletedActorIds.add(actorId);
    memoryActors.delete(actorId);
  });

  await blobPut(ACTOR_DELETED_INDEX_PATH, [...deletedActorIds]);
}

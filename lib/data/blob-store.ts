import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import type { Actor, ChatThread, Message } from "@/lib/types/chat";

type JsonRecord = Record<string, unknown>;

type ActorRow = {
  id: string;
  name: string;
  system_prompt: string;
  parent_actor_id: string | null;
  created_at: string;
  updated_at: string;
};

type ChatRow = {
  id: string;
  actor_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  actor_id: string;
  chat_id: string;
  role: Message["role"];
  content: string;
  created_at: string;
};

type MemoryRow = {
  id: string;
  actor_id: string;
  chat_id: string;
  content: JsonRecord | null;
  created_at: string;
  updated_at: string;
};

function toActor(row: ActorRow): Actor {
  return {
    id: row.id,
    name: row.name,
    purpose: row.system_prompt,
    ...(row.parent_actor_id ? { parentId: row.parent_actor_id } : {}),
  };
}

function toChat(row: ChatRow): ChatThread {
  return {
    id: row.id,
    actorId: row.actor_id,
    title: row.title ?? "Untitled chat",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

function toMemoryContent(row: MemoryRow | null): JsonRecord {
  if (!row?.content || typeof row.content !== "object") {
    return {};
  }

  return row.content;
}

function parseMessageContent(content: string): { text: string; model?: string; assets?: Array<{ type: string; url: string }> } {
  try {
    const parsed = JSON.parse(content) as { text?: unknown; model?: unknown; assets?: unknown };
    if (typeof parsed.text === "string") {
      return {
        text: parsed.text,
        ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
        ...(Array.isArray(parsed.assets)
          ? {
              assets: parsed.assets.filter(
                (asset): asset is { type: string; url: string } =>
                  Boolean(asset) &&
                  typeof (asset as { type?: unknown }).type === "string" &&
                  typeof (asset as { url?: unknown }).url === "string"
              ),
            }
          : {}),
      };
    }
  } catch {
    // noop; non-json content is supported.
  }

  return { text: content };
}

function encodeMessageContent(message: Pick<Message, "content" | "model" | "assets">): string {
  if (message.model || (message.assets && message.assets.length > 0)) {
    return JSON.stringify({ text: message.content, model: message.model, assets: message.assets ?? [] });
  }

  return message.content;
}

async function requireActor(actorId: string): Promise<ActorRow> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("actors")
    .select("id,name,system_prompt,parent_actor_id,created_at,updated_at")
    .eq("id", actorId)
    .maybeSingle<ActorRow>();

  if (error) {
    throw new Error(`Failed to load actor ${actorId}: ${error.message}`);
  }

  if (!data) {
    throw new Error(`Actor not found: ${actorId}`);
  }

  return data;
}

async function requireChat(chatId: string): Promise<ChatRow> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("chats")
    .select("id,actor_id,title,created_at,updated_at")
    .eq("id", chatId)
    .maybeSingle<ChatRow>();

  if (error) {
    throw new Error(`Failed to load chat ${chatId}: ${error.message}`);
  }

  if (!data) {
    throw new Error(`Chat not found: ${chatId}`);
  }

  return data;
}

export function getPersistenceDiagnostics() {
  return {
    mode: "durable" as const,
    blobReadConfigured: false,
    blobWriteConfigured: false,
    readBaseUrl: null,
    readNamespace: null,
    writeApiBaseUrl: "",
    ready: true,
  };
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
  try {
    const previousEntryCount = Object.keys(blobPathMapCache ?? {}).length;
    const nextEntryCount = Object.keys(pathMap).length;
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
      previousEntryCount,
      nextEntryCount,
      changed: previousEntryCount !== nextEntryCount,
      cacheUpdatedInMemory: blobPathMapCache === pathMap,
    });

    await verifyDurableReadAfterWrite(BLOB_PATH_MAP_PATH, {
      reason: "persist-path-map",
      expectedPathMapEntryCount: nextEntryCount,
    });
  } catch (error) {
    console.error("[BlobStore] Failed while persisting blob path-map.", {
      entries: Object.keys(pathMap).length,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function listActors(): Promise<Actor[]> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("actors")
    .select("id,name,system_prompt,parent_actor_id,created_at,updated_at")
    .order("name", { ascending: true })
    .order("created_at", { ascending: true })
    .returns<ActorRow>();

  if (error) {
    throw new Error(`Failed to list actors: ${error.message}`);
  }

  return (data ?? []).map(toActor);
}

export async function saveActor(actor: Actor): Promise<Actor> {
  const client = getSupabaseAdminClient();
  const now = new Date().toISOString();
  const payload = {
    id: actor.id,
    name: actor.name.trim(),
    system_prompt: actor.purpose,
    parent_actor_id: actor.parentId ?? null,
    updated_at: now,
  };

  const { data, error } = await client
    .from("actors")
    .upsert(payload, { onConflict: "id" })
    .select("id,name,system_prompt,parent_actor_id,created_at,updated_at")
    .single<ActorRow>();

  if (error) {
    throw new Error(`Failed to save actor ${actor.id}: ${error.message}`);
  }

  return toActor(data);
}

export async function deleteActorsById(actorIds: string[]): Promise<void> {
  if (!actorIds.length) {
    return;
  }

  const client = getSupabaseAdminClient();
  const { error } = await client.from("actors").in("id", actorIds).delete();

  if (error) {
    throw new Error(`Failed to delete actors: ${error.message}`);
  }
}

export async function getChatById(chatId: string): Promise<ChatThread | null> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("chats")
    .select("id,actor_id,title,created_at,updated_at")
    .eq("id", chatId)
    .maybeSingle<ChatRow>();

  if (error) {
    throw new Error(`Failed to load chat ${chatId}: ${error.message}`);
  }

  return data ? toChat(data) : null;
}

export async function listChats(): Promise<ChatThread[]> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("chats")
    .select("id,actor_id,title,created_at,updated_at")
    .order("updated_at", { ascending: false })
    .order("created_at", { ascending: false })
    .returns<ChatRow>();

  if (error) {
    throw new Error(`Failed to list chats: ${error.message}`);
  }

  return (data ?? []).map(toChat);
}

export async function listChatsByActorId(actorId: string): Promise<ChatThread[]> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("chats")
    .select("id,actor_id,title,created_at,updated_at")
    .eq("actor_id", actorId)
    .order("updated_at", { ascending: false })
    .order("created_at", { ascending: false })
    .returns<ChatRow>();

  if (error) {
    throw new Error(`Failed to list chats for actor ${actorId}: ${error.message}`);
  }

  return (data ?? []).map(toChat);
}

async function ensureMemoryRows(actorId: string, chatId: string): Promise<void> {
  const client = getSupabaseAdminClient();
  const emptyContent: JsonRecord = {};

  const statements = ["short_term_memory", "intermediate_memory", "long_term_memory"].map((table) =>
    client
      .from(table)
      .upsert({ actor_id: actorId, chat_id: chatId, content: emptyContent, updated_at: new Date().toISOString() }, { onConflict: "actor_id,chat_id" })
  );

  const results = await Promise.all(statements);
  const failed = results.find((result) => result.error);
  if (failed?.error) {
    throw new Error(`Failed to provision memory rows: ${failed.error.message}`);
  }
}

async function blobPut(path: string, payload: unknown): Promise<void> {
  try {
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
    const previousEntryCount = Object.keys(pathMap).length;
    if (pathMap[path] !== blobUrl) {
      const nextPathMap = { ...pathMap, [path]: blobUrl };
      const nextEntryCount = Object.keys(nextPathMap).length;
      blobPathMapCache = nextPathMap;
      logPersistenceDebug("Updating blob path-map entry.", {
        path,
        blobUrl,
        previousEntryCount,
        nextEntryCount,
        changed: previousEntryCount !== nextEntryCount,
        cacheUpdatedInMemory: blobPathMapCache === nextPathMap,
      });
      await persistBlobPathMap(nextPathMap, writeConfig.token);
    } else {
      logPersistenceDebug("Blob path-map already up to date.", {
        path,
        blobUrl,
        entries: previousEntryCount,
      });
    }

    await verifyDurableReadAfterWrite(path, {
      reason: "blob-put-with-path-map",
      expectedBlobUrl: blobUrl,
    });
  } catch (error) {
    console.error("[BlobStore] blobPut failed.", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function deleteChat(chatId: string): Promise<void> {
  const client = getSupabaseAdminClient();
  const { error } = await client.from("chats").eq("id", chatId).delete();

  if (error) {
    throw new Error(`Failed to delete chat ${chatId}: ${error.message}`);
  }
}

export async function deleteChatById(chatId: string): Promise<void> {
  await deleteChat(chatId);
}

export async function getMessages(chatId: string): Promise<Message[]> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("messages")
    .select("id,actor_id,chat_id,role,content,created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .returns<MessageRow>();

  if (error) {
    throw new Error(`Failed to load messages for chat ${chatId}: ${error.message}`);
  }

  return (data ?? []).map((row: MessageRow) => {
    const parsed = parseMessageContent(row.content);
    return {
      ...toMessage(row),
      content: parsed.text,
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.assets ? { assets: parsed.assets } : {}),
    };
  });
}

export async function getRecentMessages(chatId: string, limit = 20): Promise<Message[]> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("messages")
    .select("id,actor_id,chat_id,role,content,created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit)
    .returns<MessageRow>();

  if (error) {
    throw new Error(`Failed to load recent messages for chat ${chatId}: ${error.message}`);
  }

  return (data ?? [])
    .reverse()
    .map((row: MessageRow) => {
      const parsed = parseMessageContent(row.content);
      return {
        ...toMessage(row),
        content: parsed.text,
        ...(parsed.model ? { model: parsed.model } : {}),
        ...(parsed.assets ? { assets: parsed.assets } : {}),
      };
    });
}

export async function saveMessage(
  chatId: string,
  message: Omit<Message, "chatId" | "createdAt"> & Partial<Pick<Message, "chatId" | "createdAt">>
): Promise<Message> {
  const chat = await requireChat(chatId);
  const client = getSupabaseAdminClient();

  const { data, error } = await client
    .from("messages")
    .insert({
      id: message.id,
      actor_id: chat.actor_id,
      chat_id: chatId,
      role: message.role,
      content: encodeMessageContent(message),
      created_at: message.createdAt ?? new Date().toISOString(),
    })
    .select("id,actor_id,chat_id,role,content,created_at")
    .single<MessageRow>();

  if (error) {
    throw new Error(`Failed to save message for chat ${chatId}: ${error.message}`);
  }

  const { error: chatTouchError } = await client
    .from("chats")
    .eq("id", chatId)
    .update({ updated_at: new Date().toISOString() });

  if (chatTouchError) {
    throw new Error(`Failed to update chat timestamp for ${chatId}: ${chatTouchError.message}`);
  }

  const parsed = parseMessageContent(data.content);
  return {
    ...toMessage(data),
    content: parsed.text,
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.assets ? { assets: parsed.assets } : {}),
  };
}

export async function appendUserMessage(chatId: string, params: { id: string; content: string; createdAt?: string }): Promise<Message> {
  return saveMessage(chatId, { ...params, role: "user" });
}

export async function appendAssistantMessage(
  chatId: string,
  params: { id: string; content: string; model?: string; assets?: Array<{ type: string; url: string }>; createdAt?: string }
): Promise<Message> {
  return saveMessage(chatId, { ...params, role: "assistant" });
}

async function getMemory(table: "short_term_memory" | "intermediate_memory" | "long_term_memory", actorId: string, chatId: string): Promise<JsonRecord> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from(table)
    .select("id,actor_id,chat_id,content,created_at,updated_at")
    .eq("actor_id", actorId)
    .eq("chat_id", chatId)
    .maybeSingle<MemoryRow>();

  if (error) {
    throw new Error(`Failed to load ${table} for actor ${actorId} chat ${chatId}: ${error.message}`);
  }

  return toMemoryContent(data ?? null);
}

async function setMemory(
  table: "short_term_memory" | "intermediate_memory" | "long_term_memory",
  actorId: string,
  chatId: string,
  payload: JsonRecord
): Promise<void> {
  const client = getSupabaseAdminClient();
  const { error } = await client
    .from(table)
    .upsert(
      {
        actor_id: actorId,
        chat_id: chatId,
        content: payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "actor_id,chat_id" }
    );

  if (error) {
    throw new Error(`Failed to save ${table} for actor ${actorId} chat ${chatId}: ${error.message}`);
  }
}

export async function getShortTermMemory(actorId: string, chatId: string): Promise<JsonRecord> {
  return getMemory("short_term_memory", actorId, chatId);
}

export async function setShortTermMemory(actorId: string, chatId: string, payload: JsonRecord): Promise<void> {
  await setMemory("short_term_memory", actorId, chatId, payload);
}

export async function getIntermediateMemory(actorId: string, chatId: string): Promise<JsonRecord> {
  return getMemory("intermediate_memory", actorId, chatId);
}

export async function setIntermediateMemory(actorId: string, chatId: string, payload: JsonRecord): Promise<void> {
  await setMemory("intermediate_memory", actorId, chatId, payload);
}

export async function getLongTermMemory(actorId: string, chatId: string): Promise<JsonRecord> {
  return getMemory("long_term_memory", actorId, chatId);
}

export async function setLongTermMemory(actorId: string, chatId: string, payload: JsonRecord): Promise<void> {
  await setMemory("long_term_memory", actorId, chatId, payload);
}

export async function getConversationSummary(chatId: string): Promise<string> {
  const chat = await requireChat(chatId);
  const intermediate = await getIntermediateMemory(chat.actor_id, chatId);
  return typeof intermediate.summary === "string" ? intermediate.summary : "";
}

export async function setConversationSummary(chatId: string, summary: string): Promise<void> {
  const chat = await requireChat(chatId);
  const current = await getIntermediateMemory(chat.actor_id, chatId);
  await setIntermediateMemory(chat.actor_id, chatId, { ...current, summary });
}

export async function getChatContextState(actorId: string, chatId: string): Promise<{
  actor: Actor;
  chat: ChatThread;
  shortTermMemory: JsonRecord;
  intermediateMemory: JsonRecord;
  longTermMemory: JsonRecord;
  recentMessages: Message[];
}> {
  const [actor, chat, shortTermMemory, intermediateMemory, longTermMemory, recentMessages] = await Promise.all([
    getActorById(actorId),
    getChatById(chatId),
    getShortTermMemory(actorId, chatId),
    getIntermediateMemory(actorId, chatId),
    getLongTermMemory(actorId, chatId),
    getRecentMessages(chatId),
  ]);

  const nextDeletedIndex = deletedIndex.filter((deletedId) => deletedId !== actor.id);
  const nextRegistry = [...registryActors.filter((currentActor) => currentActor.id !== actor.id), actor];
  const shouldWriteDeletedIndex = deletedIndex.includes(actor.id);
  const shouldWriteIndex = !currentIndex.includes(actor.id);

  logPersistenceDebug("saveActor: starting durable writes.", {
    actorId: actor.id,
    actorPath,
    shouldWriteDeletedIndex,
    shouldWriteIndex,
    nextIndexCount: shouldWriteIndex ? currentIndex.length + 1 : currentIndex.length,
    nextRegistryCount: nextRegistry.length,
  });

  let actorBlobWriteSucceeded = false;
  let actorIndexWriteSucceeded = !shouldWriteIndex;
  let actorRegistryWriteSucceeded = false;
  let actorDeletedIndexWriteSucceeded = !shouldWriteDeletedIndex;

  const writeSteps: Array<{ step: string; run: () => Promise<void> }> = [
    {
      step: "write:actor-file",
      run: async () => {
        logPersistenceDebug("saveActor: before actor file write.", { actorId: actor.id, actorPath });
        await blobPut(actorPath, actor);
        actorBlobWriteSucceeded = true;
        logPersistenceDebug("saveActor: actor file write succeeded.", { actorId: actor.id, actorPath });
      },
    },
    {
      step: "write:actor-index",
      run: async () => {
        if (!shouldWriteIndex) {
          logPersistenceDebug("saveActor: actor already present in index; skipping index write.", {
            actorId: actor.id,
          });
          return;
        }
        await blobPut(ACTOR_INDEX_PATH, [...currentIndex, actor.id]);
        actorIndexWriteSucceeded = true;
        logPersistenceDebug("saveActor: actor index write succeeded.", {
          actorId: actor.id,
          path: ACTOR_INDEX_PATH,
        });
      },
    },
    {
      step: "write:actor-registry",
      run: async () => {
        await writeActorRegistry(nextRegistry);
        actorRegistryWriteSucceeded = true;
        logPersistenceDebug("saveActor: actor registry write succeeded.", {
          actorId: actor.id,
          path: ACTOR_REGISTRY_PATH,
          registrySize: nextRegistry.length,
        });
      },
    },
    {
      step: "write:deleted-index",
      run: async () => {
        if (!shouldWriteDeletedIndex) {
          logPersistenceDebug("saveActor: actor not in deleted index; skipping deleted-index write.", {
            actorId: actor.id,
          });
          return;
        }
        await blobPut(ACTOR_DELETED_INDEX_PATH, nextDeletedIndex);
        actorDeletedIndexWriteSucceeded = true;
        logPersistenceDebug("saveActor: deleted index write succeeded.", {
          actorId: actor.id,
          path: ACTOR_DELETED_INDEX_PATH,
          deletedIndexSize: nextDeletedIndex.length,
        });
      },
    },
  ];

  const writeResults = await Promise.allSettled(writeSteps.map((step) => step.run()));
  const failedWrite = writeResults.find((result) => result.status === "rejected");

  logPersistenceDebug("saveActor: Promise.allSettled completed.", {
    actorId: actor.id,
    actorBlobWriteSucceeded,
    actorIndexWriteSucceeded,
    actorRegistryWriteSucceeded,
    actorDeletedIndexWriteSucceeded,
    statuses: writeResults.map((result, index) => ({
      step: writeSteps[index]?.step,
      status: result.status,
      reason:
        result.status === "rejected"
          ? result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
          : "ok",
    })),
  });

  if (failedWrite?.status === "rejected") {
    const failedStepIndex = writeResults.indexOf(failedWrite);
    const failedStep = writeSteps[failedStepIndex]?.step ?? "unknown-step";
    const failedReason =
      failedWrite.reason instanceof Error ? failedWrite.reason.message : String(failedWrite.reason);
    throw new PersistenceError(
      `saveActor failed at ${failedStep}: ${failedReason}. Success states: actorFile=${actorBlobWriteSucceeded}, actorIndex=${actorIndexWriteSucceeded}, actorRegistry=${actorRegistryWriteSucceeded}, deletedIndex=${actorDeletedIndexWriteSucceeded}`
    );
  }

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

  if (!chat || chat.actorId !== actorId) {
    throw new Error(`Chat not found for actor ${actorId}: ${chatId}`);
  }

  return {
    actor,
    chat,
    shortTermMemory,
    intermediateMemory,
    longTermMemory,
    recentMessages,
  };
}

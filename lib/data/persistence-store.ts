import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import type { Actor, ChatThread, Message } from "@/lib/types/chat";
import { createNeutralActorRoutingProfile, normalizeActorRoutingProfile } from "@/lib/router/actor-routing-profile";

type JsonRecord = Record<string, unknown>;

type ActorRow = {
  id: string;
  name: string;
  system_prompt: string;
  parent_actor_id: string | null;
  routing_profile: unknown;
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
    routingProfile: (() => {
      try {
        return normalizeActorRoutingProfile(row.routing_profile);
      } catch {
        return createNeutralActorRoutingProfile("Neutral profile used because persisted profile was invalid.");
      }
    })(),
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
    .select("id,name,system_prompt,parent_actor_id,routing_profile,created_at,updated_at")
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

export async function getActorById(actorId: string): Promise<Actor | null> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("actors")
    .select("id,name,system_prompt,parent_actor_id,routing_profile,created_at,updated_at")
    .eq("id", actorId)
    .maybeSingle<ActorRow>();

  if (error) {
    throw new Error(`Failed to load actor ${actorId}: ${error.message}`);
  }

  return data ? toActor(data) : null;
}

export async function listActors(): Promise<Actor[]> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("actors")
    .select("id,name,system_prompt,parent_actor_id,routing_profile,created_at,updated_at")
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
    routing_profile: actor.routingProfile ?? createNeutralActorRoutingProfile(),
    updated_at: now,
  };

  const { data, error } = await client
    .from("actors")
    .upsert(payload, { onConflict: "id" })
    .select("id,name,system_prompt,parent_actor_id,routing_profile,created_at,updated_at")
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

export async function saveChat(chat: ChatThread): Promise<ChatThread> {
  await requireActor(chat.actorId);

  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("chats")
    .upsert(
      {
        id: chat.id,
        actor_id: chat.actorId,
        title: chat.title.trim(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    )
    .select("id,actor_id,title,created_at,updated_at")
    .single<ChatRow>();

  if (error) {
    throw new Error(`Failed to save chat ${chat.id}: ${error.message}`);
  }

  await ensureMemoryRows(data.actor_id, data.id);

  return toChat(data);
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

  if (!actor) {
    throw new Error(`Actor not found: ${actorId}`);
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

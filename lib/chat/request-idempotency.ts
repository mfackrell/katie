import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";

export type ChatRequestStatus = "processing" | "completed" | "failed";

export type ChatRequestRecord = {
  requestId: string;
  actorId: string;
  chatId: string;
  requestFingerprint: string;
  status: ChatRequestStatus;
  assistantMessageId?: string;
  assistantModel?: string;
  assistantContent?: string;
  assistantAssets: Array<{ type: string; url: string }>;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

type ChatRequestRow = {
  request_id: string;
  actor_id: string;
  chat_id: string;
  request_fingerprint: string;
  status: ChatRequestStatus;
  assistant_message_id: string | null;
  assistant_model: string | null;
  assistant_content: string | null;
  assistant_assets: unknown;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

const CHAT_REQUEST_COLUMNS =
  "request_id,actor_id,chat_id,request_fingerprint,status,assistant_message_id,assistant_model,assistant_content,assistant_assets,error_message,created_at,updated_at,completed_at";
const STALE_PROCESSING_MS = 20 * 60 * 1000;

function normalizeAssets(value: unknown): Array<{ type: string; url: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (asset): asset is { type: string; url: string } =>
      Boolean(asset) &&
      typeof (asset as { type?: unknown }).type === "string" &&
      typeof (asset as { url?: unknown }).url === "string",
  );
}

function toRecord(row: ChatRequestRow): ChatRequestRecord {
  return {
    requestId: row.request_id,
    actorId: row.actor_id,
    chatId: row.chat_id,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    ...(row.assistant_message_id ? { assistantMessageId: row.assistant_message_id } : {}),
    ...(row.assistant_model ? { assistantModel: row.assistant_model } : {}),
    ...(row.assistant_content ? { assistantContent: row.assistant_content } : {}),
    assistantAssets: normalizeAssets(row.assistant_assets),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

export async function fingerprintChatRequest(value: unknown): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readChatRequest(
  requestId: string,
): Promise<{ record: ChatRequestRecord | null; error: string | null }> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("chat_requests")
    .select(CHAT_REQUEST_COLUMNS)
    .eq("request_id", requestId)
    .maybeSingle<ChatRequestRow>();

  if (error) {
    return { record: null, error: error.message };
  }

  return { record: data ? toRecord(data) : null, error: null };
}

export async function getChatRequest(requestId: string): Promise<ChatRequestRecord | null> {
  const { record } = await readChatRequest(requestId);
  return record;
}

export type ChatRequestClaim =
  | { mode: "claimed"; tracked: true; reclaimed?: boolean }
  | { mode: "existing"; tracked: true; record: ChatRequestRecord }
  | { mode: "conflict"; tracked: true; record: ChatRequestRecord }
  | { mode: "untracked"; tracked: false; reason: string };

export async function claimChatRequest(input: {
  requestId: string;
  actorId: string;
  chatId: string;
  requestFingerprint: string;
}): Promise<ChatRequestClaim> {
  const client = getSupabaseAdminClient();
  const now = new Date().toISOString();
  const { error } = await client.from("chat_requests").insert({
    request_id: input.requestId,
    actor_id: input.actorId,
    chat_id: input.chatId,
    request_fingerprint: input.requestFingerprint,
    status: "processing",
    assistant_assets: [],
    created_at: now,
    updated_at: now,
  });

  if (!error) {
    return { mode: "claimed", tracked: true };
  }

  const existingResult = await readChatRequest(input.requestId);
  if (!existingResult.record) {
    return {
      mode: "untracked",
      tracked: false,
      reason: existingResult.error ?? error.message,
    };
  }

  const existing = existingResult.record;
  if (
    existing.actorId !== input.actorId ||
    existing.chatId !== input.chatId ||
    existing.requestFingerprint !== input.requestFingerprint
  ) {
    return { mode: "conflict", tracked: true, record: existing };
  }

  if (existing.status === "processing") {
    const updatedAt = Date.parse(existing.updatedAt);
    if (
      Number.isFinite(updatedAt) &&
      Date.now() - updatedAt > STALE_PROCESSING_MS
    ) {
      const { error: reclaimError } = await client
        .from("chat_requests")
        .eq("request_id", input.requestId)
        .update({
          status: "processing",
          error_message: null,
          updated_at: now,
        });

      if (!reclaimError) {
        return { mode: "claimed", tracked: true, reclaimed: true };
      }
    }
  }

  return { mode: "existing", tracked: true, record: existing };
}

export async function completeChatRequest(
  requestId: string,
  input: {
    assistantMessageId: string;
    assistantModel?: string;
    assistantContent: string;
    assistantAssets?: Array<{ type: string; url: string }>;
  },
): Promise<void> {
  const client = getSupabaseAdminClient();
  const now = new Date().toISOString();
  const { error } = await client
    .from("chat_requests")
    .eq("request_id", requestId)
    .update({
      status: "completed",
      assistant_message_id: input.assistantMessageId,
      assistant_model: input.assistantModel ?? null,
      assistant_content: input.assistantContent,
      assistant_assets: input.assistantAssets ?? [],
      error_message: null,
      updated_at: now,
      completed_at: now,
    });

  if (error) {
    console.warn("[Idempotency] Failed to mark chat request completed", {
      requestId,
      reason: error.message,
    });
  }
}

export async function failChatRequest(requestId: string, errorValue: unknown): Promise<void> {
  const client = getSupabaseAdminClient();
  const message =
    errorValue instanceof Error ? errorValue.message : String(errorValue ?? "Unknown request failure");
  const { error } = await client
    .from("chat_requests")
    .eq("request_id", requestId)
    .update({
      status: "failed",
      error_message: message.slice(0, 2000),
      updated_at: new Date().toISOString(),
    });

  if (error) {
    console.warn("[Idempotency] Failed to mark chat request failed", {
      requestId,
      reason: error.message,
    });
  }
}

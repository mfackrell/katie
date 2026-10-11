import { createClient } from "@supabase/supabase-js";
import { getChatById } from "@/lib/data/persistence-store";
import type { FileReference } from "@/lib/providers/types";

export type HandoffFile = {
  request_id: string; ordinal: number; file_name: string; mime_type: string;
  bytes: number; upload_id: string | null; upload_token: string | null;
  file_reference: FileReference | null;
};
export type VideoHandoff = {
  request_id: string; actor_id: string; chat_id: string;
  request_payload: Record<string, unknown>;
  status: "uploading" | "ready" | "dispatching" | "dispatched" | "failed";
  attempts: number; last_error: string | null;
  claimed_at: string | null; created_at: string; updated_at: string;
};

// The legacy admin REST helper is read-oriented and does not support
// chained filters on writes. Use the official server-only Supabase client.
let admin: ReturnType<typeof createClient> | null = null;
const db = () => {
  if (!admin) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("Private video handoff database is unavailable.");
    admin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return admin;
};
const now = () => new Date().toISOString();
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return "{" + Object.keys(row).sort()
      .map(key => JSON.stringify(key) + ":" + stableJson(row[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

export async function registerVideoHandoff(input: {
  requestId: string; actorId: string; chatId: string; message: string;
  files: Array<{ name: string; type: string; size: number }>;
  overrideProvider?: string; overrideModel?: string; activeRepoId?: string;
  repoInjectionEnabled?: boolean;
}): Promise<void> {
  const chat = await getChatById(input.chatId);
  if (!chat || chat.actorId !== input.actorId) throw new Error("Chat does not belong to this actor.");
  if (!input.files.length || input.files.length > 5 ||
      input.files.some(file => !file.type.startsWith("video/"))) {
    throw new Error("Durable handoffs require one to five video files.");
  }
  const payload: Record<string, unknown> = {
    actorId: input.actorId, chatId: input.chatId, message: input.message,
    images: [], fileReferences: [],
    ...(input.overrideProvider ? { overrideProvider: input.overrideProvider } : {}),
    ...(input.overrideModel ? { overrideModel: input.overrideModel } : {}),
    ...(input.activeRepoId ? { activeRepoId: input.activeRepoId } : {}),
    ...(input.repoInjectionEnabled === false ? { repoInjectionEnabled: false } : {}),
  };
  const { error } = await db().from("video_upload_handoffs").insert({
    request_id: input.requestId, actor_id: input.actorId,
    chat_id: input.chatId, request_payload: payload, status: "uploading",
  });
  if (error) {
    if (error.code !== "23505") throw new Error("Unable to register video handoff: " + error.message);
    const { data: prior, error: readError } = await db().from("video_upload_handoffs")
      .select("actor_id,chat_id,request_payload").eq("request_id", input.requestId).single();
    if (readError || !prior || prior.actor_id !== input.actorId || prior.chat_id !== input.chatId ||
        stableJson(prior.request_payload) !== stableJson(payload)) {
      // Avoid reusing a request ID to submit different content.
      throw new Error("Video handoff request ID already belongs to another message.");
    }
  }
  const rows = input.files.map((file, index) => ({
    request_id: input.requestId, ordinal: index,
    file_name: file.name, mime_type: file.type, bytes: file.size,
  }));
  const { error: fileError } = await db().from("video_upload_handoff_files")
    .upsert(rows, { onConflict: "request_id,ordinal", ignoreDuplicates: true });
  if (fileError) throw new Error("Could not register the expected video files: " + fileError.message);
  const files = await readHandoffFiles(input.requestId);
  if (files.length !== rows.length || files.some((row, index) =>
    row.ordinal !== index || row.file_name !== input.files[index].name ||
    row.mime_type !== input.files[index].type || Number(row.bytes) !== input.files[index].size)) {
    throw new Error("Previously registered video files do not match this request.");
  }
}

export async function readHandoffFiles(requestId: string): Promise<HandoffFile[]> {
  const { data, error } = await db().from("video_upload_handoff_files")
    .select("*").eq("request_id", requestId).order("ordinal", { ascending: true });
  if (error) throw new Error("Unable to load video handoff files: " + error.message);
  return (data ?? []) as HandoffFile[];
}

export async function readVideoHandoff(requestId: string): Promise<VideoHandoff | null> {
  const { data, error } = await db().from("video_upload_handoffs")
    .select("*").eq("request_id", requestId).maybeSingle();
  if (error) throw new Error("Unable to load video handoff: " + error.message);
  return data as VideoHandoff | null;
}

/** Returns a prior signed receipt on retry, or links one newly prepared upload. */
export async function authorizeHandoffUpload(input: {
  requestId: string; ordinal: number; name: string; type: string; size: number;
}, prepared?: { uploadToken: string; uploadId?: string; uploadUrl: string }
): Promise<{ uploadToken: string; uploadId: string; uploadUrl: string } | null> {
  const intent = await readVideoHandoff(input.requestId);
  if (!intent || intent.status === "failed") throw new Error("Video handoff is unavailable.");
  const files = await readHandoffFiles(input.requestId);
  const file = files.find(row => row.ordinal === input.ordinal);
  if (!file || file.file_name !== input.name ||
      file.mime_type !== input.type || Number(file.bytes) !== input.size) {
    throw new Error("Video does not match its registered conversation.");
  }
  if (file.upload_id && file.upload_token) {
    return { uploadToken: file.upload_token, uploadId: file.upload_id, uploadUrl: "resumed" };
  }
  if (!prepared?.uploadId) return null;
  const { data, error } = await db().from("video_upload_handoff_files")
    .update({ upload_id: prepared.uploadId, upload_token: prepared.uploadToken })
    .eq("request_id", input.requestId).eq("ordinal", input.ordinal)
    .is("upload_id", null).select("upload_id").maybeSingle();
  if (error) throw new Error("Could not bind video to conversation: " + error.message);
  if (!data) return authorizeHandoffUpload(input);
  return { uploadId: prepared.uploadId, uploadToken: prepared.uploadToken, uploadUrl: prepared.uploadUrl };
}

/** File completion is durable, irrespective of the browser's next HTTP request. */
export async function recordCompletedHandoffUpload(uploadId: string, reference: FileReference): Promise<void> {
  const { data: file, error } = await db().from("video_upload_handoff_files")
    .select("request_id,ordinal,file_name").eq("upload_id", uploadId).maybeSingle();
  if (error) throw new Error("Cannot check video handoff ownership: " + error.message);
  if (!file) return; // Legacy uploads have no server-side handoff.
  if (file.file_name !== reference.fileName || reference.attachmentKind !== "video") {
    throw new Error("Saved video reference does not match the registered video.");
  }
  const { error: updateError } = await db().from("video_upload_handoff_files")
    .update({ file_reference: reference }).eq("request_id", file.request_id)
    .eq("ordinal", file.ordinal).eq("upload_id", uploadId);
  if (updateError) throw new Error("Cannot record completed video: " + updateError.message);
  const files = await readHandoffFiles(file.request_id);
  if (files.length && files.every(item => Boolean(item.file_reference))) {
    const { error: readyError } = await db().from("video_upload_handoffs")
      .update({ status: "ready", updated_at: now() })
      .eq("request_id", file.request_id).eq("status", "uploading");
    if (readyError) throw new Error("Cannot queue completed video: " + readyError.message);
  }
}

export async function listVideoHandoffs(status: VideoHandoff["status"], limit = 12): Promise<VideoHandoff[]> {
  const { data, error } = await db().from("video_upload_handoffs").select("*")
    .eq("status", status).order("created_at", { ascending: true }).limit(limit);
  if (error) throw new Error("Cannot read video handoff queue: " + error.message);
  return (data ?? []) as VideoHandoff[];
}

export async function setVideoHandoffState(requestId: string,
  status: VideoHandoff["status"], lastError: string | null = null
): Promise<void> {
  const { error } = await db().from("video_upload_handoffs")
    .update({ status, last_error: lastError, updated_at: now() }).eq("request_id", requestId);
  if (error) throw new Error("Cannot update video handoff status: " + error.message);
}

export async function claimVideoHandoff(row: VideoHandoff): Promise<boolean> {
  const { data, error } = await db().from("video_upload_handoffs").update({
    status: "dispatching", attempts: row.attempts + 1,
    claimed_at: now(), updated_at: now(), last_error: null,
  }).eq("request_id", row.request_id).eq("status", "ready")
    .eq("attempts", row.attempts).select("request_id").maybeSingle();
  if (error) throw new Error("Cannot claim video handoff: " + error.message);
  return Boolean(data);
}

export async function findChatRequest(requestId: string): Promise<{status: string; updated_at: string} | null> {
  const { data, error } = await db().from("chat_requests")
    .select("status,updated_at").eq("request_id", requestId).maybeSingle();
  if (error) throw new Error("Cannot reconcile video chat request: " + error.message);
  return data;
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { buildRunpodVideoScenePrompt } from "@/lib/chat/video-scene-prompts";

export const RUNPOD_VIDEO_ENDPOINT_ID = "yafwsm98e8m9lv";
export const RUNPOD_VIDEO_MODEL = "Qwen/Qwen3-VL-8B-Instruct";
// Approved RunPod endpoints only. Never use an untrusted DB value as a host or URL.
const POLLABLE_VIDEO_ENDPOINT_IDS = new Set([
  RUNPOD_VIDEO_ENDPOINT_ID,
  "t52dzwlfimvchg", // Molmo 2 isolated video evaluation
]);
export const ACTIVE_RUNPOD_STATES = ["pending", "queued", "in_progress"] as const;
const SUPABASE_BUCKET = "katie-attachments";
const JOB_ID_PATTERN = /^[A-Za-z0-9-]{8,150}$/;
const CHAT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9-]{27,40}$/i;

type Json = string | number | boolean | null | Json[] | {[key: string]: Json | undefined};
type RunpodVideoRow = {
  id: string;
  runpod_job_id: string | null;
  endpoint_id: string;
  model: string;
  chat_id: string | null;
  chat_request_id: string | null;
  target_chat_id: string | null;
  actor_id: string | null;
  assistant_message_id: string | null;
  video_index: number | null;
  video_total: number | null;
  source_filename: string | null;
  fallback_state: string | null;
  fallback_attempts: number;
  fallback_text: string | null;
  fallback_model: string | null;
  fallback_started_at: string | null;
  fallback_completed_at: string | null;
  fallback_error_code: string | null;
  response_delivered_at: string | null;
  attachment_path: string | null;
  request_prompt: string | null;
  callback_token_hash: string | null;
  status: string;
  analysis_text: string | null;
  model_output: Json | null;
  error_code: string | null;
  queue_ms: number | null;
  inference_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  last_polled_at: string | null;
  submitted_at: string;
  completed_at: string | null;
  updated_at: string;
};
type VideoDatabase = {
  public: {
    Tables: {
      video_analysis_jobs: {
        Row: RunpodVideoRow;
        Insert: Partial<RunpodVideoRow>;
        Update: Partial<RunpodVideoRow>;
        Relationships: [];
      },
      messages: {
        Row: { id: string; actor_id: string; chat_id: string; role: string;
          content: string; created_at: string };
        Insert: { id?: string; actor_id?: string; chat_id?: string; role?: string;
          content?: string; created_at?: string };
        Update: { content?: string; created_at?: string };
        Relationships: [];
      },
      chat_requests: {
        Row: { request_id: string; actor_id: string; chat_id: string;
          status: string; assistant_message_id: string | null;
          assistant_content: string | null; assistant_model: string | null;
          updated_at: string; completed_at: string | null; error_message: string | null };
        Insert: Record<string, unknown>;
        Update: Partial<{ status: string; assistant_message_id: string | null;
          assistant_content: string | null; assistant_model: string | null;
          updated_at: string; completed_at: string | null; error_message: string | null }>;
        Relationships: [];
      },
      chats: {
        Row: { id: string; actor_id: string };
        Insert: { id?: string; actor_id?: string };
        Update: { actor_id?: string };
        Relationships: [];
      }
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  }
};
type StorageClient = SupabaseClient<VideoDatabase>;
type RecordData = Record<string, unknown>;

export type SavedVideoJob = {
  id: string;
  runpod_job_id: string | null;
  endpoint_id: string;
  model: string;
  chat_id: string | null;
  attachment_path: string | null;
  status: string;
  analysis_text: string | null;
  error_code: string | null;
  submitted_at: string;
  completed_at: string | null;
  queue_ms: number | null;
  inference_ms: number | null;
};

export function assertRunpodAdmin(request: Request): boolean {
  const expected = process.env.RUNPOD_INTERNAL_TOKEN;
  const incoming = request.headers.get("x-runpod-admin-token") ?? "";
  if (!expected || expected.length < 32 || incoming.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(incoming));
}

export function assertCronAuth(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const incoming = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || secret.length < 32 || incoming.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(secret), Buffer.from(incoming));
}

export function requireRunpodKey(): string {
  const key = process.env.RUNPOD_API_KEY;
  if (!key) throw new Error("RunPod API key is not configured");
  return key;
}

export function resultStore(): StorageClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase persistence credentials unavailable");
  return createClient<VideoDatabase>(url, key, { auth: {persistSession: false, autoRefreshToken: false} });
}

export function assertStoredVideoPath(chatId: string, path: string): void {
  if (!CHAT_ID_PATTERN.test(chatId) ||
      !path.startsWith("chats/" + chatId + "/") ||
      !/^chats\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.source$/i.test(path)) {
    throw new Error("Invalid chat ID or private video attachment path");
  }
}

export function hashCallbackProof(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function parseRunpodOutput(job: RecordData) {
  const state = String(job.status ?? "");
  const first = Array.isArray(job.output) ? job.output[0] : job.output;
  const output: RecordData = (first && typeof first === "object" && !Array.isArray(first))
    ? first as RecordData : {};
  const choices = Array.isArray(output.choices) ? output.choices as RecordData[] : [];
  const message = choices.length && choices[0].message && typeof choices[0].message === "object"
    ? choices[0].message as RecordData : {};
  const rawText = message.content;
  const text = typeof rawText === "string" && rawText.trim()
    ? rawText.trim().slice(0, 250000) : null;
  const usage = output.usage && typeof output.usage === "object" ? output.usage as RecordData : {};
  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(state);
  const status = state === "COMPLETED" ? (text ? "completed" : "failed")
    : state === "FAILED" ? "failed"
    : state === "CANCELLED" ? "cancelled"
    : state === "TIMED_OUT" ? "timed_out"
    : state === "IN_PROGRESS" ? "in_progress" : "queued";
  const safeOutput = terminal && Object.keys(output).length ? {
    model: typeof output.model === "string" ? output.model : null,
    choices: choices.slice(0, 3).map((c) => {
      const m = c.message && typeof c.message === "object" ? c.message as RecordData : {};
      return {
        index: c.index ?? null, finish_reason: c.finish_reason ?? null,
        message: { role: m.role ?? null, content: typeof m.content === "string" ? m.content.slice(0, 250000) : null }
      };
    }),
    usage: {
      prompt_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
      completion_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
      total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : null,
    }
  } : null;
  return {
    terminal, status, analysis_text: text,
    model_output: safeOutput,
    error_code: state === "COMPLETED" && !text ? "COMPLETED_WITHOUT_ANALYSIS"
      : status === "failed" ? "RUNPOD_FAILED"
      : status === "cancelled" ? "RUNPOD_CANCELLED"
      : status === "timed_out" ? "RUNPOD_TIMED_OUT" : null,
    queue_ms: typeof job.delayTime === "number" && Number.isFinite(job.delayTime) ? job.delayTime : null,
    inference_ms: typeof job.executionTime === "number" && Number.isFinite(job.executionTime) ? job.executionTime : null,
    input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
    output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
  };
}

export async function refreshRunpodJob(
  client: StorageClient, job: Pick<SavedVideoJob, "id" | "runpod_job_id" | "endpoint_id" | "status">
) {
  if (!job.runpod_job_id || !JOB_ID_PATTERN.test(job.runpod_job_id)) {
    throw new Error("Missing or invalid RunPod job ID");
  }
  if (!POLLABLE_VIDEO_ENDPOINT_IDS.has(job.endpoint_id)) {
    throw new Error("Unapproved RunPod video endpoint");
  }
  if (!ACTIVE_RUNPOD_STATES.some((x) => x === job.status)) {
    return {status: job.status, saved: true, skipped: true};
  }
  const result = await fetch(
    "https://api.runpod.ai/v2/" + job.endpoint_id + "/status/" +
    encodeURIComponent(job.runpod_job_id), {
      cache: "no-store",
      headers: {Authorization: "Bearer " + requireRunpodKey()},
      signal: AbortSignal.timeout(18000),
    }
  );
  if (result.status === 404) {
    // An unreachable or expired job must not silently be treated as success.
    const patch = {
      status: "expired", error_code: "RUNPOD_RESULT_EXPIRED_OR_NOT_FOUND",
      last_polled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const {error} = await client.from("video_analysis_jobs").update(patch).eq("id", job.id)
      .in("status", [...ACTIVE_RUNPOD_STATES]);
    if (error) throw new Error("Failed to save job expiration");
    return {status: "expired", saved: true};
  }
  if (!result.ok) throw new Error("RunPod status fetch failed with HTTP " + result.status);
  const body = await result.json() as RecordData;
  if (body.id !== job.runpod_job_id) throw new Error("RunPod job identity mismatch");
  const parsed = parseRunpodOutput(body);
  const now = new Date().toISOString();
  const patch: RecordData = {
    status: parsed.status,
    last_polled_at: now, updated_at: now,
  };
  if (parsed.terminal) {
    Object.assign(patch, {
      completed_at: now, analysis_text: parsed.analysis_text, model_output: parsed.model_output,
      error_code: parsed.error_code, queue_ms: parsed.queue_ms,
      inference_ms: parsed.inference_ms, input_tokens: parsed.input_tokens,
      output_tokens: parsed.output_tokens,
    });
  }
  // Guard against overwriting a webhook-confirmed completion with an older poll.
  const {error} = await client.from("video_analysis_jobs").update(patch).eq("id", job.id)
    .in("status", [...ACTIVE_RUNPOD_STATES]);
  if (error) throw new Error("Failed to persist RunPod job result");
  return {status: parsed.status, saved: true, hasAnalysis: Boolean(parsed.analysis_text)};
}

export async function submitSavedVideo(params: {
  chatId: string; attachmentPath: string; question: string;
  requestId?: string; targetChatId?: string; actorId?: string;
  assistantMessageId?: string; videoIndex?: number; videoTotal?: number;
  sourceFilename?: string;
}) {
  assertStoredVideoPath(params.chatId, params.attachmentPath);
  if (params.requestId) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(params.requestId) ||
        !params.targetChatId || !params.actorId || !params.assistantMessageId ||
        !CHAT_ID_PATTERN.test(params.targetChatId) || !CHAT_ID_PATTERN.test(params.actorId) ||
        !CHAT_ID_PATTERN.test(params.assistantMessageId) ||
        !Number.isInteger(params.videoIndex) || !Number.isInteger(params.videoTotal) ||
        (params.videoIndex ?? -1) < 0 || (params.videoTotal ?? 0) < 1 ||
        (params.videoTotal ?? 0) > 5 || (params.videoIndex ?? 0) >= (params.videoTotal ?? 0)) {
      throw new Error("Invalid durable chat video correlation");
    }
    const {data: chats, error: ownershipError} = await getSupabaseAdminClient()
      .from("chats").select("id,actor_id")
      .in("id", [params.chatId, params.targetChatId]);
    const ownedChats = (chats ?? []) as Array<{ id: string; actor_id: string }>;
    if (ownershipError ||
        ![params.chatId, params.targetChatId].every(id =>
          ownedChats.some(chat => chat.id === id && chat.actor_id === params.actorId))) {
      throw new Error("Video source or destination does not belong to this actor");
    }
  }
  if (!params.question || params.question.length > 2000) {
    throw new Error("Video question must be 1 to 2000 characters");
  }
  const client = resultStore();
  const callbackProof = randomBytes(32).toString("hex");
  // Row exists before job submission so a fast webhook can never be orphaned.
  const {data: record, error: insertError} = await client.from("video_analysis_jobs")
    .insert({
      chat_id: params.chatId,
      ...(params.requestId ? {
        chat_request_id: params.requestId,
        target_chat_id: params.targetChatId!,
        actor_id: params.actorId!,
        assistant_message_id: params.assistantMessageId!,
        video_index: params.videoIndex!,
        video_total: params.videoTotal!,
        source_filename: params.sourceFilename?.slice(0,255) ?? "Video",
        fallback_state: "pending",
      } : {}),
      attachment_path: params.attachmentPath,
      request_prompt: params.question,
      status: "pending",
      endpoint_id: RUNPOD_VIDEO_ENDPOINT_ID,
      model: RUNPOD_VIDEO_MODEL,
      callback_token_hash: hashCallbackProof(callbackProof),
    }).select("id").single();
  if (insertError || !record) throw new Error("Cannot register durable video job");

  try {
    const {data: signed, error: signError} = await client.storage
      .from(SUPABASE_BUCKET).createSignedUrl(params.attachmentPath, 3600);
    if (signError || !signed?.signedUrl) throw new Error("Cannot sign the private video URL");
    const provider = await fetch("https://api.runpod.ai/v2/" + RUNPOD_VIDEO_ENDPOINT_ID + "/run",{
      method: "POST",
      headers: {
        Authorization: "Bearer " + requireRunpodKey(), "content-type": "application/json"
      },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        input: {
          route: "/v1/chat/completions", method: "POST",
          body: {
            model: RUNPOD_VIDEO_MODEL, temperature: 0, max_tokens: 1400,
            messages: [{role: "user", content: [
              {type: "video_url", video_url: {url: signed.signedUrl}},
              {type: "text", text: buildRunpodVideoScenePrompt(params.question)},
            ]}],
          },
        },
        // RunPod invokes Supabase on a terminal result. The callback secret is
        // never placed in result metadata, user messages, or source control.
        webhook: "https://barclcqataqyvifoeyop.supabase.co/functions/v1/katie-runpod-result-webhook" +
          "?receipt=" + encodeURIComponent(record.id) + "&proof=" + callbackProof,
      }),
    });
    if (!provider.ok) throw new Error("RunPod rejected video submission: HTTP " + provider.status);
    const body: unknown = await provider.json();
    const providerId = body && typeof body === "object"
      ? (body as RecordData).id : null;
    if (typeof providerId !== "string" || !JOB_ID_PATTERN.test(providerId)) {
      throw new Error("RunPod did not issue a valid job identifier");
    }
    const {error: updateError} = await client.from("video_analysis_jobs").update({
      runpod_job_id: providerId,
      status: "queued",
      updated_at: new Date().toISOString(),
    }).eq("id", record.id).eq("status", "pending");
    // If the webhook already completed the job, this update matches 0 rows,
    // which is safe. An actual persistence failure must be reported.
    if (updateError) throw new Error("RunPod job accepted but registration update failed");
    return {id: record.id, jobId: providerId, status: "queued"};
  } catch (error) {
    await client.from("video_analysis_jobs").update({
      status: "failed", error_code: "SUBMISSION_FAILED",
      completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", record.id).eq("status", "pending");
    throw error;
  }
}

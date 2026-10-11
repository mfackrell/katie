import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { encodeMessageContent, parseMessageContent } from "@/lib/data/persistence-store";
import { GrokProvider } from "@/lib/providers/grok-provider";
import { recoverSavedVideoFrames } from "@/lib/uploads/stored-uploads";
import { RUNPOD_VIDEO_MODEL, resultStore } from "@/lib/runpod/durable-results";

export const PENDING_VIDEO_PREFIX = "[Katie video analysis pending:";
const FINISHED_STATES = new Set(["completed", "failed", "cancelled", "timed_out", "expired", "rejected"]);
const ID_FROM_PATH = /^chats\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.source$/i;

type LinkedVideo = {
  id: string;
  chat_request_id: string | null;
  chat_id: string | null;
  target_chat_id: string | null;
  actor_id: string | null;
  assistant_message_id: string | null;
  video_index: number | null;
  video_total: number | null;
  source_filename: string | null;
  attachment_path: string | null;
  request_prompt: string | null;
  model: string;
  status: string;
  analysis_text: string | null;
  fallback_state: string | null;
  fallback_attempts: number;
  fallback_text: string | null;
  fallback_model: string | null;
  fallback_started_at: string | null;
  fallback_error_code: string | null;
  response_delivered_at: string | null;
};

const VIDEO_COLUMNS = "id,chat_request_id,chat_id,target_chat_id,actor_id,assistant_message_id,video_index,video_total,source_filename,attachment_path,request_prompt,model,status,analysis_text,fallback_state,fallback_attempts,fallback_text,fallback_model,fallback_started_at,fallback_error_code,response_delivered_at";

export function usableVideoAnalysis(value: string | null | undefined): value is string {
  if (!value || value.trim().length < 25) return false;
  const trimmed = value.trim();
  // A model-level refusal is not evidence that the video was analyzed.
  return !/^(?:i (?:can(?:not|'t|’t)|am unable to|won't|will not) (?:help|assist|provide|analy[sz]e|describe)|sorry,? i (?:can(?:not|'t|’t)|am unable)|as an ai)/i.test(trimmed)
    && !/^(?:this|that|the) (?:request|content|video) (?:violates|is prohibited)/i.test(trimmed);
}

export function pendingVideoMessage(requestId: string, count: number): string {
  return PENDING_VIDEO_PREFIX + " " + requestId + "]\n" +
    "Gemini could not analyze " + (count === 1 ? "the video" : "the videos") +
    ". I submitted the original " + (count === 1 ? "video" : "videos") +
    " to Qwen for independent analysis (up to 15 minutes). " +
    "If Qwen cannot produce an analysis, I will try Grok using frames recovered from the saved original. " +
    "The result will replace this message automatically; you can leave this chat and return.";
}

/** Idempotently replace the assistant's persisted placeholder with all completed analyses. */
export async function publishVideoChat(requestId: string): Promise<{ status: string; count?: number }> {
  const db = resultStore();
  const { data, error } = await db.from("video_analysis_jobs")
    .select(VIDEO_COLUMNS).eq("chat_request_id", requestId)
    .order("video_index", { ascending: true }).limit(5);
  if (error) throw new Error("Cannot load video delivery batch");
  const jobs = (data ?? []) as LinkedVideo[];
  if (!jobs.length) return { status: "missing" };
  const expected = jobs[0].video_total;
  if (!expected || jobs.length !== expected) return { status: "awaiting_submissions" };
  const source = jobs[0];
  if (!source.assistant_message_id || !source.target_chat_id || !source.actor_id ||
      jobs.some((job, index) =>
        job.video_index !== index || job.video_total !== expected ||
        job.actor_id !== source.actor_id || job.target_chat_id !== source.target_chat_id ||
        job.assistant_message_id !== source.assistant_message_id)) {
    throw new Error("Video delivery correlation did not match the originating conversation");
  }
  if (jobs.every(j => Boolean(j.response_delivered_at))) return { status: "delivered", count: jobs.length };
  if (jobs.some(j => !FINISHED_STATES.has(j.status))) return { status: "analyzing" };

  const sections: string[] = [];
  let anyGrok = false;
  for (const job of jobs) {
    const label = job.source_filename || "Video";
    let text: string;
    if (job.status === "completed" && usableVideoAnalysis(job.analysis_text)) {
      text = job.analysis_text.trim();
    } else if (job.fallback_state === "completed" && usableVideoAnalysis(job.fallback_text)) {
      text = job.fallback_text!.trim();
      anyGrok = true;
      text += "\n\n[Analysis used recovered video frames; audio and activity between sampled frames were not directly inspected.]";
    } else if (job.fallback_state === "failed") {
      text = "I could not analyze this video. Qwen did not produce a usable result and Grok also failed (" +
        (job.fallback_error_code || job.status) + "). The original video remains saved.";
    } else {
      return { status: "awaiting_grok" };
    }
    sections.push(jobs.length > 1 ? "Video \"" + label + "\":\n" + text : text);
  }
  const answer = sections.join("\n\n");
  const model = anyGrok ? (jobs.find(j => j.fallback_model)?.fallback_model || "grok") : RUNPOD_VIDEO_MODEL;
  const chatDb = getSupabaseAdminClient();
  const { data: message, error: readError } = await chatDb.from("messages")
    .select("id,content").eq("id", source.assistant_message_id)
    .eq("chat_id", source.target_chat_id).eq("actor_id", source.actor_id)
    .eq("role", "assistant").maybeSingle();
  if (readError) throw new Error("Failed to load assistant video placeholder");
  if (!message) return { status: "awaiting_assistant_message" };
  const oldText = parseMessageContent(message.content).text;
  if (!oldText.startsWith(PENDING_VIDEO_PREFIX + " " + requestId + "]")) {
    // Another actor/user edit or prior delivery must not be overwritten.
    return { status: "message_changed" };
  }

  const { data: updated, error: writeError } = await chatDb.from("messages")
    .update({ content: encodeMessageContent({ content: answer, model }) })
    .eq("id", source.assistant_message_id).eq("chat_id", source.target_chat_id)
    .eq("actor_id", source.actor_id).eq("content", message.content)
    .select("id").maybeSingle();
  if (writeError) throw new Error("Failed to deliver video analysis");
  if (!updated) return { status: "concurrent_delivery" };

  const now = new Date().toISOString();
  const { error: requestError } = await chatDb.from("chat_requests").update({
    status: "completed", assistant_message_id: source.assistant_message_id,
    assistant_content: answer, assistant_model: model, updated_at: now,
    completed_at: now, error_message: null,
  }).eq("request_id", requestId).eq("chat_id", source.target_chat_id)
    .eq("actor_id", source.actor_id);
  if (requestError) {
    console.error("[Video Delivery] chat request update failed", { requestId, error: requestError.message });
    // The chat message itself is already persisted. Cron will reconcile the request
    // separately rather than retrying and overwriting the final message.
  }

  const { error: jobError } = await db.from("video_analysis_jobs")
    .update({ response_delivered_at: now, updated_at: now })
    .eq("chat_request_id", requestId).is("response_delivered_at", null);
  if (jobError) throw new Error("Failed to mark delivered video jobs");
  return { status: "delivered", count: jobs.length };
}

/** The independent cron invokes this only after Qwen is terminal (or refused). */
export async function processNextGrokVideo(): Promise<{ status: string; requestId?: string }> {
  const db = resultStore();
  const now = new Date().toISOString();
  // Recover abandoned leases, for example when Vercel killed a previous attempt.
  const staleCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  await db.from("video_analysis_jobs").update({ fallback_state: "pending", updated_at: now })
    .eq("fallback_state", "processing").lt("fallback_started_at", staleCutoff)
    .lt("fallback_attempts", 3);

  const { data, error } = await db.from("video_analysis_jobs").select(VIDEO_COLUMNS)
    .in("status", ["failed", "cancelled", "timed_out", "expired", "rejected"])
    .eq("fallback_state", "pending").not("chat_request_id", "is", null)
    .is("response_delivered_at", null).order("submitted_at", { ascending: true })
    .limit(5);
  if (error) throw new Error("Cannot load pending Grok fallback jobs");
  for (const row of (data ?? []) as LinkedVideo[]) {
    const { data: claim, error: claimError } = await db.from("video_analysis_jobs")
      .update({ fallback_state: "processing", fallback_started_at: now,
        fallback_attempts: row.fallback_attempts + 1, updated_at: now })
      .eq("id", row.id).eq("fallback_state", "pending")
      .eq("fallback_attempts", row.fallback_attempts)
      .select("id").maybeSingle();
    if (claimError) throw new Error("Cannot claim Grok video fallback");
    if (!claim) continue;
    try {
      const actorId = row.actor_id, sourceChat = row.chat_id, path = row.attachment_path;
      const match = path ? ID_FROM_PATH.exec(path) : null;
      if (!actorId || !sourceChat || !match || match[1] !== sourceChat) {
        throw new Error("Saved video source is invalid");
      }
      const frames = await recoverSavedVideoFrames(sourceChat, {
        id: match[2], fileName: row.source_filename || "video.mp4",
        mimeType: "video/mp4", hasOriginal: true, chatId: sourceChat, actorId,
      }, actorId);
      if (!frames.videoFrames?.length) throw new Error("No real saved video frames available");
      const key = process.env.GROK_API_KEY || process.env.XAI_API_KEY || process.env["grok_api_key"];
      if (!key) throw new Error("Grok API credentials are not configured");
      const provider = new GrokProvider(key);
      const available = await provider.listModels();
      const model = ["grok-4.7", "grok-4.6", "grok-4.5", "grok-4.3"].find(name => available.includes(name));
      if (!model) throw new Error("No configured Grok vision model is available");
      const generated = await provider.generate({
        name: "Katie",
        persona: "You are Katie. Report only observations grounded in the video frames. " +
          "Answer the user's question and distinguish visible evidence from uncertainty.",
        summary: "", history: [], user: row.request_prompt?.trim() ||
          "Provide a detailed and specific description of the video.",
        modelId: model, attachments: [frames],
      });
      if (!usableVideoAnalysis(generated.text)) throw new Error("Grok returned no usable video analysis");
      const finished = new Date().toISOString();
      const { error: updateError } = await db.from("video_analysis_jobs").update({
        fallback_state: "completed", fallback_text: generated.text.slice(0, 250000),
        fallback_model: generated.model, fallback_error_code: null,
        fallback_completed_at: finished, updated_at: finished,
      }).eq("id", row.id).eq("fallback_state", "processing");
      if (updateError) throw new Error("Failed to save Grok video analysis");
      if (row.chat_request_id) await publishVideoChat(row.chat_request_id);
      return { status: "completed", requestId: row.chat_request_id ?? undefined };
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      console.error("[Video Routing] independent Grok attempt failed", {
        jobId: row.id, attempt: row.fallback_attempts + 1, reason: reason.slice(0, 350),
      });
      const done = row.fallback_attempts + 1 >= 3;
      const finished = new Date().toISOString();
      const { error: failureError } = await db.from("video_analysis_jobs").update({
        fallback_state: done ? "failed" : "pending",
        fallback_error_code: reason.slice(0, 200),
        ...(done ? { fallback_completed_at: finished } : {}),
        updated_at: finished,
      }).eq("id", row.id).eq("fallback_state", "processing");
      if (failureError) throw new Error("Failed to persist Grok fallback failure");
      if (done && row.chat_request_id) await publishVideoChat(row.chat_request_id);
      return { status: done ? "failed" : "retry_queued", requestId: row.chat_request_id ?? undefined };
    }
  }
  return { status: "idle" };
}

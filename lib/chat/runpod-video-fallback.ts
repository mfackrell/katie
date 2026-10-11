import {
  RUNPOD_VIDEO_ENDPOINT_ID,
  RUNPOD_VIDEO_MODEL,
  parseRunpodOutput,
  refreshRunpodJob,
  requireRunpodKey,
  resultStore,
  submitSavedVideo,
} from "@/lib/runpod/durable-results";

// This is an analysis fallback, never an upload path or a new model router.
// Source locations are derived from actor-authorized, server-persisted descriptors.
export type SavedVideoSource = {
  chatId: string;
  attachmentId: string;
  fileName: string;
};

type RunpodStatus = {
  id?: string;
  status?: string;
  output?: unknown;
  delayTime?: number;
  executionTime?: number;
  error?: unknown;
};

type Receipt = { id: string; jobId: string; status: string };
type Dependencies = {
  submit?: (params: { chatId: string; attachmentPath: string; question: string }) => Promise<Receipt>;
  status?: (jobId: string) => Promise<RunpodStatus>;
  persist?: (receipt: Receipt) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
};

// The chat route permits 800s; reserve at least 150s for Grok and cleanup.
// A full 15-minute budget requires moving orchestration outside the chat request.
const DEFAULT_TIMEOUT_MS = 600_000;
const POLL_MS = 4_500;
const sleepDefault = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function queryRunpodStatus(jobId: string): Promise<RunpodStatus> {
  const response = await fetch(
    `https://api.runpod.ai/v2/${RUNPOD_VIDEO_ENDPOINT_ID}/status/${encodeURIComponent(jobId)}`,
    { headers: { Authorization: "Bearer " + requireRunpodKey() },
      cache: "no-store", signal: AbortSignal.timeout(18_000) },
  );
  if (!response.ok) throw new Error(`Qwen video status failed (HTTP ${response.status}).`);
  return await response.json() as RunpodStatus;
}

async function persistTerminalStatus(receipt: Receipt) {
  const store = resultStore();
  await refreshRunpodJob(store, {
    id: receipt.id,
    runpod_job_id: receipt.jobId,
    endpoint_id: RUNPOD_VIDEO_ENDPOINT_ID,
    status: "queued",
  });
}

/**
 * Run the same original-video Qwen3-VL inference that was verified against
 * Katie's saved MP4. A successful result becomes Katie's response; on any
 * submission, inference, persistence or timeout failure the caller can run
 * the existing Grok pixel-recovery fallback.
 *
 * The existing RunPod webhook and one-minute cron retain the response even
 * if the HTTP client disconnects or this bounded polling window expires.
 */
export async function analyzeSavedVideosWithQwen(
  sources: SavedVideoSource[],
  question: string,
  dependencies: Dependencies = {},
): Promise<{ text: string; model: string; queueMs: number | null; inferenceMs: number | null }> {
  if (!sources.length || sources.length > 5) throw new Error("Qwen video fallback requires 1 to 5 saved videos.");
  if (!process.env.RUNPOD_API_KEY && !dependencies.submit) throw new Error("RunPod video fallback is not configured.");
  const submit = dependencies.submit ?? submitSavedVideo;
  const status = dependencies.status ?? queryRunpodStatus;
  const persist = dependencies.persist ?? persistTerminalStatus;
  const sleep = dependencies.sleep ?? sleepDefault;
  const now = dependencies.now ?? Date.now;
  const deadline = now() + (dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const texts: string[] = [];
  let queueMs = 0;
  let inferenceMs = 0;

  for (const source of sources) {
    if (now() >= deadline) throw new Error("Qwen video fallback exceeded its time budget.");
    // The durable results service checks UUIDs and signs only a private
    // original under the verified owning conversation.
    const attachmentPath = `chats/${source.chatId}/${source.attachmentId}.source`;
    const prompt = question.trim().slice(0, 1900) || "Provide a detailed and specific description of the video.";
    const receipt = await submit({ chatId: source.chatId, attachmentPath, question: prompt });
    console.info("[Video Routing] RunPod Qwen fallback accepted", {
      receiptId: receipt.id, jobId: receipt.jobId, sourceId: source.attachmentId,
    });

    let completed = false;
    while (now() < deadline) {
      const job = await status(receipt.jobId);
      if (job.id !== receipt.jobId) throw new Error("Qwen video result did not match the submitted job.");
      const state = job.status;
      if (state === "COMPLETED") {
        const parsed = parseRunpodOutput(job as Record<string, unknown>);
        if (!parsed.analysis_text || parsed.status !== "completed") {
          throw new Error("Qwen completed without a usable video analysis.");
        }
        // Webhook and cron independently persist this record. A transient
        // persistence error must not discard the already completed analysis.
        try { await persist(receipt); }
        catch (error) {
          console.warn("[Video Routing] Qwen result persistence deferred to webhook/cron", {
            jobId: receipt.jobId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        texts.push(sources.length === 1
          ? parsed.analysis_text
          : `Video "${source.fileName}":\n${parsed.analysis_text}`);
        queueMs += parsed.queue_ms ?? 0;
        inferenceMs += parsed.inference_ms ?? 0;
        completed = true;
        console.info("[Video Routing] RunPod Qwen fallback completed", {
          receiptId: receipt.id, queueMs: parsed.queue_ms, inferenceMs: parsed.inference_ms,
        });
        break;
      }
      if (state === "FAILED" || state === "CANCELLED" || state === "TIMED_OUT") {
        try { await persist(receipt); } catch { /* webhook/cron remains the recovery path */ }
        throw new Error(`Qwen video inference ended in ${state}.`);
      }
      if (state !== "IN_QUEUE" && state !== "IN_PROGRESS") {
        throw new Error("Qwen returned an unexpected video job state.");
      }
      await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
    }
    if (!completed) throw new Error("Qwen video inference timed out; Grok recovery is still available.");
  }
  return { text: texts.join("\n\n"), model: RUNPOD_VIDEO_MODEL,
    queueMs: queueMs || null, inferenceMs: inferenceMs || null };
}

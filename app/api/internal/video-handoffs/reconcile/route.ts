import { after, NextRequest, NextResponse } from "next/server";
import { assertCronAuth } from "@/lib/runpod/durable-results";
import {
  beginStoredUploadProcessing, getStoredUploadChunkStatus,
  getStoredUploadProcessingResult, processStoredUploadInBackground,
} from "@/lib/uploads/stored-uploads";
import {
  claimVideoHandoff, findChatRequest, listVideoHandoffs, readHandoffFiles,
  recordCompletedHandoffUpload, setVideoHandoffState, type VideoHandoff,
} from "@/lib/uploads/video-handoffs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function recoverUpload(row: VideoHandoff): Promise<number> {
  const files = await readHandoffFiles(row.request_id);
  let scheduled = 0;
  for (const file of files) {
    if (file.file_reference || !file.upload_token || !file.upload_id) continue;
    const result = await getStoredUploadProcessingResult(file.upload_token);
    if (result.status === "ready") {
      await recordCompletedHandoffUpload(file.upload_id, result.fileReference);
      continue;
    }
    if (result.status === "processing") continue;
    const chunks = await getStoredUploadChunkStatus(file.upload_token);
    if (!chunks.complete) continue; // The browser is still transferring bytes.
    const started = await beginStoredUploadProcessing(file.upload_token);
    if (started.status === "ready") {
      await recordCompletedHandoffUpload(file.upload_id, started.fileReference);
    } else if (started.scheduled) {
      const token = file.upload_token;
      // Server-owned continuation: no browser tab, request, or open socket.
      after(() => processStoredUploadInBackground(token));
      scheduled++;
    }
  }
  return scheduled;
}

async function dispatchHandoff(row: VideoHandoff, origin: string): Promise<string> {
  // A live browser and the independent worker may arrive concurrently.
  // Both use the SAME request ID, and /api/chat owns the idempotency gate.
  const existing = await findChatRequest(row.request_id);
  if (existing) {
    if (existing.status === "failed") {
      await setVideoHandoffState(row.request_id, "failed", "Conversation processing failed.");
    } else {
      await setVideoHandoffState(row.request_id, "dispatched");
    }
    return "already_submitted";
  }
  if (!(await claimVideoHandoff(row))) return "claimed_elsewhere";
  try {
    const files = await readHandoffFiles(row.request_id);
    if (!files.length || files.some(file => !file.file_reference)) {
      throw new Error("A required video reference is not ready.");
    }
    const payload = {
      ...row.request_payload,
      fileReferences: files.map(file => file.file_reference),
    };
    const response = await fetch(new URL("/api/chat", origin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-request-id": row.request_id,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(230_000),
      cache: "no-store",
    });
    // Do not abort a streamed Gemini/RunPod handoff as soon as headers arrive.
    // Wait for the server to persist the resulting chat request and placeholder.
    const text = await response.text();
    const saved = await findChatRequest(row.request_id);
    if (saved && saved.status !== "failed") {
      await setVideoHandoffState(row.request_id, "dispatched");
      return "dispatched";
    }
    throw new Error(`Chat handoff returned HTTP ${response.status}: ${text.slice(-200)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setVideoHandoffState(row.request_id,
      row.attempts + 1 >= 6 ? "failed" : "ready", message.slice(0, 350));
    console.warn("[Video Handoff] chat dispatch interrupted; future cron will reconcile", {
      requestId: row.request_id, attempt: row.attempts + 1, detail: message.slice(0, 200),
    });
    return "retry";
  }
}

export async function GET(request: NextRequest) {
  if (!assertCronAuth(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const counts = { uploading: 0, recovered: 0, dispatched: 0, retried: 0, failed: 0 };
  try {
    const incoming = await listVideoHandoffs("uploading", 8);
    for (const row of incoming) {
      counts.uploading++;
      try {
        counts.recovered += await recoverUpload(row);
        if (Date.now() - Date.parse(row.created_at) > 23 * 60 * 60_000) {
          await setVideoHandoffState(row.request_id, "failed", "Upload did not complete before its storage retention deadline.");
          counts.failed++;
        }
      } catch (error) {
        console.warn("[Video Handoff] upload recovery will retry", {
          requestId: row.request_id, message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // A worker can die while dispatching without marking the handoff complete.
    // Confirm the chat request independently before requeuing its lease.
    for (const row of await listVideoHandoffs("dispatching", 8)) {
      if (!row.claimed_at || Date.now() - Date.parse(row.claimed_at) < 6 * 60_000) continue;
      const submitted = await findChatRequest(row.request_id);
      if (submitted) {
        await setVideoHandoffState(row.request_id, submitted.status === "failed" ? "failed" : "dispatched");
      } else {
        await setVideoHandoffState(row.request_id, row.attempts >= 6 ? "failed" : "ready",
          "Previous worker lost its connection before chat submission.");
      }
    }
    // Serial claims respect Vercel runtime budgets and avoid a burst of
    // expensive conversational inference on an already overloaded service.
    for (const row of (await listVideoHandoffs("ready", 2))) {
      const outcome = await dispatchHandoff(row, request.nextUrl.origin);
      if (outcome === "dispatched" || outcome === "already_submitted") counts.dispatched++;
      if (outcome === "retry") counts.retried++;
    }
    return NextResponse.json(counts, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[Video Handoff] reconciliation failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "video_handoff_reconciliation_failed", ...counts }, { status: 503 });
  }
}

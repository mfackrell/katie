import { NextRequest, NextResponse } from "next/server";
import {
  ACTIVE_RUNPOD_STATES, assertCronAuth, refreshRunpodJob, resultStore,
} from "@/lib/runpod/durable-results";
import { publishVideoChat } from "@/lib/runpod/video-orchestration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Runs independently of chat HTTP requests. Qwen gets 15 minutes of queue +
// inference time. The webhook is a fast path; this cron is the durable recovery.
export async function GET(request: NextRequest) {
  if (!assertCronAuth(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const client = resultStore();
    const { data, error } = await client.from("video_analysis_jobs")
      .select("id,runpod_job_id,endpoint_id,status,submitted_at")
      .in("status", [...ACTIVE_RUNPOD_STATES])
      .order("submitted_at", { ascending: true }).limit(24);
    if (error) throw new Error("Reconciliation database read failed");
    const rows = (data ?? []) as Array<{
      id: string; runpod_job_id: string | null; endpoint_id: string;
      status: string; submitted_at: string;
    }>;
    let checked = 0, saved = 0, failed = 0, timedOut = 0;
    // Parallelism keeps one blocked RunPod status request from blocking the
    // whole cron invocation or starving other video jobs.
    for (let offset = 0; offset < rows.length; offset += 6) {
      await Promise.all(rows.slice(offset, offset + 6).map(async row => {
        const now = new Date().toISOString();
        if (!row.runpod_job_id) {
          if (Date.now() - Date.parse(row.submitted_at) > 120_000) {
            const { error: staleError } = await client.from("video_analysis_jobs").update({
              status: "failed", error_code: "UNREGISTERED_SUBMISSION_TIMED_OUT",
              completed_at: now, updated_at: now,
            }).eq("id", row.id).eq("status", "pending");
            if (staleError) failed++; else saved++;
          }
          return;
        }
        checked++;
        try {
          const refreshed = await refreshRunpodJob(client, row);
          if (refreshed.saved) saved++;
          // Poll first to avoid misclassifying a just-finished job as timed out.
          if (row.endpoint_id === "yafwsm98e8m9lv" &&
              Date.now() - Date.parse(row.submitted_at) >= 900_000 &&
              ACTIVE_RUNPOD_STATES.some(state => state === refreshed.status)) {
            const deadline = new Date().toISOString();
            const { error: overdueError } = await client.from("video_analysis_jobs").update({
              status: "timed_out", error_code: "QWEN_FIFTEEN_MINUTE_DEADLINE",
              completed_at: deadline, updated_at: deadline,
            }).eq("id", row.id).in("status", [...ACTIVE_RUNPOD_STATES]);
            if (overdueError) failed++; else timedOut++;
          }
        } catch (caught) {
          failed++;
          console.warn("[Video Reconcile] RunPod poll failed; next cron will retry", {
            jobId: row.id, error: caught instanceof Error ? caught.message : String(caught),
          });
          if (row.endpoint_id === "yafwsm98e8m9lv" &&
              Date.now() - Date.parse(row.submitted_at) >= 900_000) {
            // Bounded completion even when RunPod polling itself is unavailable.
            const deadline = new Date().toISOString();
            await client.from("video_analysis_jobs").update({
              status: "timed_out", error_code: "QWEN_DEADLINE_POLL_UNAVAILABLE",
              completed_at: deadline, updated_at: deadline,
            }).eq("id", row.id).in("status", [...ACTIVE_RUNPOD_STATES]);
          }
        }
      }));
    }

    // Every terminal RunPod result is handed to Grok for final review.
    // The independent Grok worker processes completed and failed RunPod jobs;
    // do not publish the preliminary RunPod text as a final answer.
    const refusals = 0;

    // The webhook may complete a job at any time. Publish only when every
    // video in the originating request has a terminal outcome (including Grok).
    const { data: undelivered, error: deliveryError } = await client
      .from("video_analysis_jobs").select("chat_request_id")
      .not("chat_request_id", "is", null).is("response_delivered_at", null)
      .order("submitted_at", { ascending: false }).limit(100);
    if (deliveryError) throw new Error("Cannot inspect pending video deliveries");
    const ids = [...new Set((undelivered ?? []).map(row => row.chat_request_id)
      .filter((id): id is string => typeof id === "string"))];
    let published = 0;
    for (const id of ids.slice(0, 1)) {
      try {
        const result = await publishVideoChat(id);
        if (result.status === "delivered") published++;
      } catch (caught) {
        console.error("[Video Reconcile] Chat delivery will retry", {
          requestId: id, error: caught instanceof Error ? caught.message : String(caught),
        });
        failed++;
      }
    }
    return NextResponse.json({
      checked, saved, failed, timedOut, refusals, published,
      pendingJobs: rows.length, pendingConversations: ids.length,
    }, { headers: { "cache-control": "no-store" } });
  } catch (caught) {
    console.error("[Video Reconcile] Unhandled", caught);
    return NextResponse.json({ error: "reconciliation_failed" }, { status: 503 });
  }
}

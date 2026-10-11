import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getMessages } from "@/lib/data/persistence-store";
import { resultStore } from "@/lib/runpod/durable-results";

const chatIdParamSchema = z.object({
  chatId: z.string().min(1)
});

export async function GET(request: NextRequest) {
  try {
    const { chatId } = chatIdParamSchema.parse({
      chatId: request.nextUrl.searchParams.get("chatId")
    });
    const messages = await getMessages(chatId);

    const pendingRequests = [...new Set(messages
      .filter(message => message.role === "assistant")
      .map(message => /^\\[Katie video analysis pending: ([a-f0-9-]{36})\\]/i.exec(message.content)?.[1])
      .filter((id): id is string => Boolean(id)))];
    let videoProgress: Record<string, {
      stage: string; submittedAt: string; elapsedSeconds: number;
      videoCount: number; completedCount: number; failedCount: number;
    }> = {};
    if (pendingRequests.length) {
      try {
        const { data, error } = await resultStore().from("video_analysis_jobs")
          .select("chat_request_id,status,submitted_at,fallback_state,response_delivered_at")
          .eq("target_chat_id", chatId).in("chat_request_id", pendingRequests)
          .order("submitted_at", { ascending: true }).limit(25);
        if (error) throw error;
        const groups = new Map<string, typeof data>();
        for (const row of data ?? []) {
          if (!row.chat_request_id) continue;
          groups.set(row.chat_request_id, [...(groups.get(row.chat_request_id) ?? []), row]);
        }
        videoProgress = Object.fromEntries([...groups].map(([requestId, jobs]) => {
          const completedCount = jobs.filter(job => job.status === "completed").length;
          const failedCount = jobs.filter(job => ["failed", "cancelled", "timed_out", "expired", "rejected"].includes(job.status)).length;
          const grokRunning = jobs.some(job => job.fallback_state === "processing");
          const grokPending = jobs.some(job => failedCount > 0 && job.fallback_state === "pending");
          const grokDone = jobs.some(job => job.fallback_state === "completed");
          const stage = grokRunning ? "grok_analyzing" :
            grokPending ? "grok_queued" :
            grokDone ? "delivering" :
            completedCount === jobs.length ? "delivering" :
            jobs.some(job => job.status === "in_progress") ? "qwen_analyzing" :
            jobs.some(job => job.status === "queued") ? "qwen_queued" :
            jobs.some(job => job.status === "pending") ? "qwen_submitting" : "processing";
          const submittedAt = jobs[0]?.submitted_at ?? new Date().toISOString();
          return [requestId, { stage, submittedAt,
            elapsedSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(submittedAt)) / 1000)),
            videoCount: jobs.length, completedCount, failedCount }];
        }));
      } catch (error) {
        console.warn("[Video Progress] Status unavailable; video jobs continue independently", error);
      }
    }
    return NextResponse.json({ messages, videoProgress }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Invalid chat id" }, { status: 400 });
  }
}

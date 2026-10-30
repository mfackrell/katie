import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { deleteSingleMessage, getChatById, getMessages } from "@/lib/data/persistence-store";
import { authenticateStandaloneOwner, StandaloneAuthorizationError } from "@/lib/standalone-accounting/auth";
import { createStandaloneLedger } from "@/lib/standalone-accounting/ledger";
import { resultStore } from "@/lib/runpod/durable-results";
import { publishVideoChat, processNextGrokVideo } from "@/lib/runpod/video-orchestration";

export const runtime = "nodejs";
export const maxDuration = 300;

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
      .map(message => message.content.startsWith("[Katie video analysis pending: ") ? message.content.slice(31, 67) : undefined)
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
        // Vercel cron delivery is best-effort. The authenticated chat polling
        // path independently recovers completed jobs, including provider refusals.
        // Execute after returning the status so the UI stays responsive.
        const requestIds = [...groups.keys()];
        if (requestIds.length) after(async () => {
          const db = resultStore();
          let needGrok = false;
          for (const requestId of requestIds) {
            try {
              const { data: rows, error: lookupError } = await db.from("video_analysis_jobs")
                .select("id,status,analysis_text,fallback_state,response_delivered_at")
                .eq("target_chat_id", chatId).eq("chat_request_id", requestId)
                .is("response_delivered_at", null);
              if (lookupError) throw lookupError;
              for (const row of rows ?? []) {
                if (["completed","rejected","failed","timed_out","expired","cancelled"].includes(row.status)
                    && row.fallback_state === "pending") needGrok = true;
              }
              const delivery = await publishVideoChat(requestId);
              if (delivery.status === "awaiting_grok") needGrok = true;
            } catch (error) {
              console.error("[Video Delivery] Chat-triggered recovery failed", {
                requestId, reason: error instanceof Error ? error.message : String(error),
              });
            }
          }
          if (needGrok) {
            try { await processNextGrokVideo(); }
            catch (error) { console.error("[Video Delivery] Grok recovery failed", error); }
          }
        });
        videoProgress = Object.fromEntries([...groups].map(([requestId, jobs]) => {
          const completedCount = jobs.filter(job => job.status === "completed").length;
          const failedCount = jobs.filter(job => ["failed", "cancelled", "timed_out", "expired", "rejected"].includes(job.status)).length;
          const grokRunning = jobs.some(job => job.fallback_state === "processing");
          const grokPending = jobs.some(job => (job.status === "completed" || failedCount > 0) && job.fallback_state === "pending");
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

export async function DELETE(request: NextRequest) {
  const chatId = request.nextUrl.searchParams.get("chatId");
  const messageId = request.nextUrl.searchParams.get("messageId");
  if (!chatId || !messageId || !/^[0-9a-f-]{36}$/i.test(messageId)) {
    return NextResponse.json({error:"Invalid message identifier."},{status:400});
  }
  try {
    const chat = await getChatById(chatId);
    if (!chat) return NextResponse.json({error:"Conversation not found."},{status:404});
    const ownerId = await authenticateStandaloneOwner(request);
    if (!await createStandaloneLedger().authorizeScope(ownerId,chat.actorId,chat.id)) {
      return NextResponse.json({error:"You are not authorized to delete this message."},{status:403});
    }
    const deleted = await deleteSingleMessage(chatId,messageId);
    if (!deleted) return NextResponse.json({error:"Message not found in this conversation."},{status:404});
    return NextResponse.json({success:true,deletedMessageId:messageId},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {
    if (error instanceof StandaloneAuthorizationError) return NextResponse.json({error:"Owner authorization required."},{status:403});
    return NextResponse.json({error:"Message deletion failed."},{status:500});
  }
}

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { getChatById, getMessages, saveChat } from "@/lib/data/persistence-store";
import { restoreConversationAttachment } from "@/lib/uploads/stored-uploads";
import { POST as runNormalChat } from "@/app/api/chat/route";
import type { ConversationAttachment } from "@/lib/chat/attachment-continuity";

type ReplayRow = {
  id: string;
  actor_id: string;
  source_chat_id: string;
  attachment_id: string;
  replay_chat_id: string | null;
  status: string;
  expires_at: string;
};

// Only the service-role database can enqueue a replay. The existing authenticated
// mission cron is the sole caller. A conditional claim prevents parallel or repeat
// inference, including a retry after an uncertain paid attempt.
export async function runOneSavedImageReplay(): Promise<{ status: string; trialId?: string }> {
  const db = getSupabaseAdminClient();
  const { data: pending, error: readError } = await db.from("image_replay_trials")
    .select("id,actor_id,source_chat_id,attachment_id,replay_chat_id,status,expires_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true }).limit(1).maybeSingle<ReplayRow>();
  if (readError) throw new Error("Replay queue lookup failed: " + readError.message);
  if (!pending || Date.parse(pending.expires_at) <= Date.now()) return { status: "idle" };
  const requestId = randomUUID();
  const replayChatId = randomUUID();
  const { data: claimed, error: claimError } = await db.from("image_replay_trials")
    .eq("id",pending.id).eq("status","pending").updateReturning<{id:string}>(
      {status:"running",request_id:requestId,replay_chat_id:replayChatId,claimed_at:new Date().toISOString()}, "id");
  if (claimError) throw new Error("Replay claim failed: " + claimError.message);
  if (!claimed?.length) return { status:"already_claimed" };
  console.info("[ImageReplay] claimed", {trialId:pending.id,requestId,replayChatId});
  try {
    const owner = await getChatById(pending.source_chat_id);
    if (!owner || owner.actorId !== pending.actor_id) throw new Error("Original actor/chat ownership mismatch");
    const sourceMessages = await getMessages(pending.source_chat_id);
    const source = sourceMessages.flatMap(m=>m.attachments ?? [])
      .find(a=>a.id===pending.attachment_id && a.mimeType==="image/jpeg") as ConversationAttachment | undefined;
    if (!source) throw new Error("Original JPEG attachment not found in its owning chat");
    const saved = await restoreConversationAttachment(pending.source_chat_id,source,pending.actor_id);
    if (!saved.imageDataUrl?.startsWith("data:image/jpeg;base64,")) throw new Error("Original JPEG pixels unavailable");
    await saveChat({
      id:replayChatId,actorId:pending.actor_id,
      title:"One-time image replay — IMG_4449.jpeg",
      createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
    });
    console.info("[ImageReplay] original restored", {trialId:pending.id,bytesApprox:Math.floor(saved.imageDataUrl.length*3/4)});
    // Intentionally use the SAME [image] text and normal /api/chat POST logic
    // as the original request. No override, no synthetic model response.
    const request = new NextRequest("https://katie-mu.vercel.app/api/chat",{
      method:"POST",
      headers:{"content-type":"application/json","x-request-id":requestId},
      body:JSON.stringify({actorId:pending.actor_id,chatId:replayChatId,message:"[image]",images:[saved.imageDataUrl]})
    });
    const response = await runNormalChat(request);
    const responseBody = await response.text();
    if (!response.ok) throw new Error("Chat replay returned HTTP " + response.status + ": " + responseBody.slice(0,250));
    const messages = await getMessages(replayChatId);
    const assistant = [...messages].reverse().find(m=>m.role==="assistant");
    if (!assistant?.content) throw new Error("Replay streamed but did not persist an assistant response");
    const resultText = assistant.content;
    if (assistant.model==="katie-local") throw new Error("Replay was intercepted by local response: " + resultText.slice(0,160));
    const {error:completeError} = await db.from("image_replay_trials")
      .eq("id",pending.id).eq("status","running").update({
        status:"completed",model:assistant.model??null,
        result_text:resultText.slice(0,12000),completed_at:new Date().toISOString()
      });
    if (completeError) throw new Error("Failed to persist replay result: " + completeError.message);
    console.info("[ImageReplay] completed", {trialId:pending.id,requestId,model:assistant.model,chars:resultText.length});
    return { status:"completed",trialId:pending.id };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown replay failure";
    await db.from("image_replay_trials").eq("id",pending.id).eq("status","running").update({
      status:"failed",error:reason.slice(0,900),completed_at:new Date().toISOString()
    });
    console.error("[ImageReplay] failed", {trialId:pending.id,requestId,reason});
    return {status:"failed",trialId:pending.id};
  }
}

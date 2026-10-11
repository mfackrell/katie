import { assembleContext } from "@/lib/memory/assemble-context";
import { parseMessageContent } from "@/lib/data/persistence-store";
import { getAvailableProviders } from "@/lib/providers";
import { canSynthesizeVideoReply, generateContextualVideoReply, selectVideoReplyTarget } from "@/lib/chat/video-response";
import { resultStore } from "@/lib/runpod/durable-results";

type Answer = { status: "ready"; text: string; model: string } | { status: "pending" };
const LEASE_MS = 240000;

async function withDeadline<T>(job: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([job, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Video conversational reply timed out")), 65000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}


export async function finalizeContextualVideoReply(input: {
  requestId: string; actorId: string; chatId: string;
  assistantMessageId: string; question: string; observations: string;
}): Promise<Answer> {
  const db = resultStore();
  const { data: state, error: readError } = await db.from("chat_requests")
    .select("status,video_reply_provider,video_reply_model,video_synthesis_state,video_synthesis_started_at,video_synthesis_text,video_synthesis_model")
    .eq("request_id", input.requestId).eq("actor_id", input.actorId)
    .eq("chat_id", input.chatId).maybeSingle();
  if (readError || !state) throw new Error("Video synthesis state is unavailable");
  if (state.video_synthesis_state === "completed" && state.video_synthesis_text && state.video_synthesis_model)
    return { status: "ready", text: state.video_synthesis_text, model: state.video_synthesis_model };
  if (state.status !== "processing" && state.status !== "completed") return { status: "pending" };
  if (state.video_synthesis_state === "failed")
    return { status: "ready", model: "katie-video-delivery",
      text: "I inspected the video, but couldn't finish the conversational reply. The observations remain saved. Please ask me to try again." };
  if (state.video_synthesis_state === "processing") {
    const age = Date.now() - Date.parse(state.video_synthesis_started_at || "");
    if (!Number.isFinite(age) || age < LEASE_MS) return { status: "pending" };
    await db.from("chat_requests").update({
      video_synthesis_state: null, video_synthesis_started_at: null,
    }).eq("request_id", input.requestId).eq("video_synthesis_state", "processing")
      .eq("video_synthesis_started_at", state.video_synthesis_started_at ?? "");
  }

  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimError } = await db.from("chat_requests").update({
    video_synthesis_state: "processing", video_synthesis_started_at: claimedAt,
  }).eq("request_id", input.requestId).eq("actor_id", input.actorId)
    .eq("chat_id", input.chatId).in("status", ["processing", "completed"])
    .is("video_synthesis_state", null).select("request_id").maybeSingle();
  if (claimError) throw new Error("Could not claim video synthesis");
  if (!claimed) return { status: "pending" };

  try {
    const { data: placeholder, error: placeholderError } = await db.from("messages")
      .select("created_at").eq("id", input.assistantMessageId)
      .eq("actor_id", input.actorId).eq("chat_id", input.chatId)
      .eq("role", "assistant").maybeSingle();
    if (placeholderError || !placeholder) throw new Error("Pending video message not found");

    const { data: preceding, error: historyError } = await db.from("messages")
      .select("role,content,created_at").eq("actor_id", input.actorId)
      .eq("chat_id", input.chatId).lt("created_at", placeholder.created_at)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: false }).limit(24);
    if (historyError) throw new Error("Cannot read preceding conversation");
    const history = [...(preceding ?? [])].reverse()
      .map(entry => ({ role: entry.role as "user" | "assistant", content: parseMessageContent(entry.content).text }));
    if (history.at(-1)?.role === "user" && history.at(-1)?.content.trim() === input.question.trim()) history.pop();

    const providers = getAvailableProviders();
    const target = state.video_reply_provider && state.video_reply_model
      ? { provider: state.video_reply_provider, model: state.video_reply_model }
      : await selectVideoReplyTarget(providers, {}, (preceding ?? [])
          .filter(x => x.role === "assistant").map(x => parseMessageContent(x.content).model)
          .find(Boolean));
    if (!target || !canSynthesizeVideoReply(target.provider as "openai" | "google" | "grok" | "anthropic", target.model))
      throw new Error("No compatible conversational model");
    const provider = providers.find(item => item.name === target.provider);
    if (!provider) throw new Error("Conversational provider unavailable");
    const context = await assembleContext(input.actorId, input.chatId);
    const reply = await withDeadline(generateContextualVideoReply({
      provider, model: target.model, persona: context.persona, summary: context.summary,
      history, userQuestion: input.question, observations: input.observations,
    }));
    const finished = new Date().toISOString();
    const { error: saveError } = await db.from("chat_requests").update({
      video_synthesis_state: "completed", video_synthesis_text: reply.text,
      video_synthesis_model: reply.model, updated_at: finished,
    }).eq("request_id", input.requestId).eq("video_synthesis_state", "processing")
      .eq("video_synthesis_started_at", claimedAt);
    if (saveError) throw new Error("Failed to save conversational video reply");
    console.info("[Video Reply] conversational synthesis completed", { requestId: input.requestId, model: reply.model });
    return { status: "ready", text: reply.text, model: reply.model };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await db.from("chat_requests").update({
      video_synthesis_state: "failed", video_synthesis_error: reason.slice(0, 300),
    }).eq("request_id", input.requestId).eq("video_synthesis_state", "processing")
      .eq("video_synthesis_started_at", claimedAt);
    console.error("[Video Reply] synthesis failed", { requestId: input.requestId, reason: reason.slice(0, 200) });
    return { status: "pending" };
  }
}

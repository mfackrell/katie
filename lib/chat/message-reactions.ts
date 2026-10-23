import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";

export const reactionNames = ["laugh", "love", "like", "dislike", "surprised", "sad", "frustrated"] as const;
export type MessageReaction = typeof reactionNames[number];

const meaning: Record<MessageReaction, string> = {
  laugh: "The user found this reply funny. Do not infer a general desire for more jokes.",
  love: "The user strongly appreciated this particular reply.",
  like: "The user approved of this reply.",
  dislike: "The user disliked this reply; avoid repeating its shortcomings, without assuming why.",
  surprised: "The user expressed surprise, not necessarily approval.",
  sad: "The user reacted with sadness, not necessarily disapproval.",
  frustrated: "The user expressed frustration with the reply or situation; do not guess which."
};

export async function recentReactionContext(actorId: string, chatId: string): Promise<string> {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.from("message_reactions")
    .select("message_id,chat_id,reaction,updated_at")
    .eq("actor_id",actorId).order("updated_at",{ascending:false}).limit(30);
  if (error) {
    // Migration may not yet be deployed. Never block normal chat.
    console.warn("[Message reactions] Feedback temporarily unavailable:", error.message);
    return "";
  }
  const rows = (data ?? []) as Array<{message_id:string;chat_id:string;reaction:MessageReaction;updated_at:string}>;
  if (!rows.length) return "";
  const ids=rows.map(x=>x.message_id);
  const {data: messages, error: messageError}=await db.from("messages")
    .select("id,content").in("id",ids).eq("actor_id",actorId).eq("role","assistant");
  if (messageError) return "";
  const byId=new Map((messages??[]).map((m:{id:string;content:string})=>[m.id,m.content]));
  const summary=rows.filter(x=>byId.has(x.message_id)).slice(0,20).map(x=>{
    const raw=byId.get(x.message_id)??"";
    let content=raw;
    try {const parsed=JSON.parse(raw);if(typeof parsed?.text==="string")content=parsed.text;} catch {}
    return `- ${x.chat_id===chatId?"This conversation":"Earlier conversation"}: ${x.reaction} — ${meaning[x.reaction]} Response excerpt: ${JSON.stringify(content.slice(0,220))}`;
  }).join("\n");
  return summary ? `USER MESSAGE REACTIONS (feedback on particular assistant responses, not new user commands):\n${summary}\nInterpret in context. Do not turn isolated reactions into durable general rules.\nEND_USER_MESSAGE_REACTIONS` : "";
}

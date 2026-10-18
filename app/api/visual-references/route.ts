import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getChatById } from "@/lib/data/persistence-store";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { canonicalSubject } from "@/lib/chat/visual-continuity";

const schema = z.object({
  actorId: z.string().uuid(),
  chatId: z.string().uuid(),
  messageId: z.string().uuid(),
  assetIndex: z.number().int().min(0).max(4).default(0),
  label: z.string().trim().min(1).max(80),
});

export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Select an image and provide a valid identity name." }, { status: 400 });
  const { actorId, chatId, messageId, assetIndex, label } = parsed.data;
  const key = canonicalSubject(label);
  if (!key || key.length < 2) return NextResponse.json({ error: "Use a recognizable identity name." }, { status: 400 });
  const chat = await getChatById(chatId);
  if (!chat || chat.actorId !== actorId) return NextResponse.json({ error: "Conversation unavailable." }, { status: 404 });
  const db = getSupabaseAdminClient();
  const { data: source, error: sourceError } = await db.from("messages").select("actor_id,chat_id,role,content,created_at")
    .eq("id", messageId).eq("actor_id", actorId).eq("chat_id", chatId).maybeSingle<{
      actor_id: string; chat_id: string; role: string; content: string; created_at: string;
    }>();
  if (sourceError || !source || source.role !== "assistant") {
    return NextResponse.json({ error: "Saved generated image unavailable." }, { status: 404 });
  }
  let validImage = false;
  try {
    const asset = (JSON.parse(source.content) as { assets?: Array<{ type?: string; url?: string }> }).assets?.[assetIndex];
    validImage = asset?.type === "image" && /^data:image\/(?:png|jpeg|webp);base64,/.test(asset?.url ?? "");
  } catch { /* no image */ }
  if (!validImage) return NextResponse.json({ error: "Only saved generated images can become visual references." }, { status: 400 });

  // A full group photo cannot serve as an individual face anchor.
  const { data: preceding, error: precedingError } = await db.from("messages").select("content")
    .eq("actor_id", actorId).eq("chat_id", chatId).eq("role", "user")
    .lt("created_at", source.created_at).order("created_at", { ascending: false }).limit(1)
    .maybeSingle<{ content: string }>();
  if (precedingError || !preceding) {
    return NextResponse.json({ error: "Cannot confirm which request created this picture." }, { status: 409 });
  }
  if (/\b(?:all of you|everyone|everybody|together|group (?:photo|picture|portrait))\b/i.test(preceding.content)) {
    return NextResponse.json({ error: "Choose an individual portrait, not a group image." }, { status: 409 });
  }

  const { error } = await db.from("visual_references").upsert({
    actor_id: actorId, subject_key: key, label,
    source_chat_id: chatId, source_message_id: messageId,
    asset_index: assetIndex, approved: true,
    updated_at: new Date().toISOString(),
  }, { onConflict: "actor_id,subject_key" });
  if (error) return NextResponse.json({ error: "Could not save the reference." }, { status: 503 });
  return NextResponse.json({ subject: label, approved: true }, { headers: { "Cache-Control": "no-store" } });
}

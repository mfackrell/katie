import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteChatById, getActorById, getChatById, listChats, listChatsByActorId, saveChat } from "@/lib/data/blob-store";
import type { ChatThread } from "@/lib/types/chat";

const createChatSchema = z.object({
  id: z.string().min(1).optional(),
  actorId: z.string().min(1),
  title: z.string().min(1)
});

const chatIdParamSchema = z.object({
  id: z.string().min(1)
});

export async function GET(request: NextRequest) {
  const actorId = request.nextUrl.searchParams.get("actorId");
  const chats = actorId ? await listChatsByActorId(actorId) : await listChats();

  return NextResponse.json({ chats }, { headers: { "Cache-Control": "no-cache" } });
}

export async function POST(request: NextRequest) {
  try {
    const payload = createChatSchema.parse(await request.json());
    const actor = await getActorById(payload.actorId);

    if (!actor) {
      return NextResponse.json({ error: `Actor not found: ${payload.actorId}` }, { status: 404 });
    }

    const now = new Date().toISOString();
    const chat: ChatThread = {
      id:
        payload.id ??
        (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      actorId: payload.actorId,
      title: payload.title.trim(),
      createdAt: now,
      updatedAt: now
    };

    const savedChat = await saveChat(chat);

    return NextResponse.json({ chat: savedChat }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const url = new URL(request.url);

  try {
    const { id: chatId } = chatIdParamSchema.parse({ id: url.searchParams.get("id") });
    const chat = await getChatById(chatId);

    if (!chat) {
      return NextResponse.json({ error: `Chat not found: ${chatId}` }, { status: 404 });
    }

    await deleteChatById(chatId);

    return NextResponse.json({ success: true, deletedChatId: chatId });
  } catch {
    return NextResponse.json({ error: "Invalid chat id" }, { status: 400 });
  }
}

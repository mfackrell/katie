import { authenticateStandalonePrincipal, StandaloneAuthorizationError } from '@/lib/standalone-accounting/auth';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import { createStandaloneLedger } from '@/lib/standalone-accounting/ledger';
import { managedActor } from "@/lib/agents/store";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteChatById, getActorById, getChatById, listChats, listChatsByActorId, saveChat } from "@/lib/data/persistence-store";
import { resolveStarterChat } from "@/lib/chat/starter-chat";
import type { ChatThread } from "@/lib/types/chat";

const createChatSchema = z.object({
  id: z.string().min(1).optional(),
  actorId: z.string().min(1),
  title: z.string().min(1),
  createStarterChat: z.boolean().optional(),
});

const chatIdParamSchema = z.object({
  id: z.string().min(1)
});

const updateChatSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
});

export async function GET(request: NextRequest) {
  const actorId = request.nextUrl.searchParams.get("actorId");
  try {
    const principal=await authenticateStandalonePrincipal(request);
    const chats=actorId?await listChatsByActorId(actorId):await listChats();
    if (!principal.isAnonymous && principal.id===process.env.KATIE_OWNER_AUTH_USER_ID)
      return NextResponse.json({chats},{headers:{"Cache-Control":"no-store"}});
    const {data,error}=await getSupabaseAdminClient().rpc<string[]>('standalone_owned_chat_ids',{p_owner:principal.id});
    if(error)throw Error('Scope lookup failed');
    const owned=new Set(data??[]);
    return NextResponse.json({chats:chats.filter(chat=>owned.has(chat.id))},{headers:{"Cache-Control":"no-store"}});
  }catch{return NextResponse.json({error:"Session required."},{status:403});}
}

export async function POST(request: NextRequest) {
  try {
    const payload = createChatSchema.parse(await request.json());
    if (await managedActor(payload.actorId)) return NextResponse.json({ error: "Create managed conversations by assigning a task in Agents management." }, { status: 409 });
    const actor = await getActorById(payload.actorId);

    if (!actor) {
      return NextResponse.json({ error: `Actor not found: ${payload.actorId}` }, { status: 404 });
    }

    const standalone = actor.actorKind !== 'executive';
    const principal = standalone ? await authenticateStandalonePrincipal(request) : null;
    const ownerId = principal?.id ?? null;
    const ledger = standalone ? createStandaloneLedger() : null;
    if (payload.createStarterChat) {
      const existingChats = await listChatsByActorId(payload.actorId);
      const ownedChats = ledger && ownerId ? (await Promise.all(existingChats.map(async chat => await ledger.authorizeScope(ownerId, payload.actorId, chat.id) ? chat : null))).filter((chat): chat is ChatThread => chat !== null) : existingChats;
      const existingStarterChat = resolveStarterChat(ownedChats, payload);
      if (existingStarterChat) {
        return NextResponse.json({ chat: existingStarterChat });
      }
    }

    const now = new Date().toISOString();
    const chat: ChatThread = {
      id: (payload.createStarterChat ? undefined : payload.id) ??
        (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      actorId: payload.actorId,
      title: payload.title.trim(),
      createdAt: now,
      updatedAt: now
    };

    let row: {id:string;actor_id:string;title:string;created_at:string;updated_at:string}|null=n...[truncated]
    const savedChat = row ? { id:row.id, actorId:row.actor_id, title:row.title, createdAt:row.created_at, updatedAt:row.updated_at } : await saveChat(chat);

    return NextResponse.json({ chat: savedChat }, { status: 201 });
  } catch (error) {
    if (error instanceof StandaloneAuthorizationError) return NextResponse.json({error:error.message},{status:403});
    if (error && typeof error==='object' && 'code' in error && typeof error.code==='string' && error.code.startsWith('standalone_')) return NextResponse.json({error:'Conversation enrollment denied or unavailable.'},{status:409});
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Unknown persistence error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const payload = updateChatSchema.parse(await request.json());
    const existingChat = await getChatById(payload.id);

    if (!existingChat) {
      return NextResponse.json({ error: `Chat not found: ${payload.id}` }, { status: 404 });
    }

    const updatedChat = await saveChat({
      ...existingChat,
      title: payload.title.trim(),
    });

    return NextResponse.json({ chat: updatedChat });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Unknown persistence error";
    return NextResponse.json({ error: message }, { status: 500 });
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
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid chat id" }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Unknown persistence error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

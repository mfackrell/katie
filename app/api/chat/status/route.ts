import { getChatById } from "@/lib/data/persistence-store";
import { managedActor } from "@/lib/agents/store";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { agentConfigSchema } from "@/lib/agents/policy";
import { NextRequest, NextResponse } from "next/server";
import { getChatRequest } from "@/lib/chat/request-idempotency";

export async function GET(request: NextRequest) {
  const requestId = request.nextUrl.searchParams.get("requestId")?.trim() ?? "";
  const chatId = request.nextUrl.searchParams.get("chatId")?.trim() ?? "";

  if (!requestId || !chatId) {
    return NextResponse.json(
      { error: "requestId and chatId are required." },
      { status: 400 },
    );
  }

  const record = await getChatRequest(requestId);
  const chat = await getChatById(chatId);
  if (!record || record.chatId !== chatId || chat?.actorId !== record.actorId) {
    return NextResponse.json(
      { error: "Chat request not found." },
      { status: 404 },
    );
  }

  try {
    const agent = await managedActor(record.actorId);
    if (agent) {
      const { data, error } = await getSupabaseAdminClient().from("agent_tasks").select("agent_id,actor_id,snapshot").eq("chat_id", chatId).maybeSingle<{ agent_id: string; actor_id: string; snapshot: unknown }>();
      if (error || !data || data.agent_id !== agent.id || data.actor_id !== record.actorId) throw new Error("Task association invalid");
      agentConfigSchema.parse(data.snapshot);
    }
  } catch { return NextResponse.json({ error: "Task status unavailable" }, { status: 503 }); }
  return NextResponse.json(
    {
      requestId: record.requestId,
      chatId: record.chatId,
      status: record.status,
      assistantMessageId: record.assistantMessageId ?? null,
      assistantModel: record.assistantModel ?? null,
      error: record.errorMessage ?? null,
      updatedAt: record.updatedAt,
      completedAt: record.completedAt ?? null,
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    },
  );
}

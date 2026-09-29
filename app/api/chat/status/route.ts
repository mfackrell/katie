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
  if (!record || record.chatId !== chatId) {
    return NextResponse.json(
      { error: "Chat request not found." },
      { status: 404 },
    );
  }

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

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getMessages } from "@/lib/data/persistence-store";

const chatIdParamSchema = z.object({
  chatId: z.string().min(1)
});

export async function GET(request: NextRequest) {
  try {
    const { chatId } = chatIdParamSchema.parse({
      chatId: request.nextUrl.searchParams.get("chatId")
    });
    const messages = await getMessages(chatId);

    return NextResponse.json({ messages }, { headers: { "Cache-Control": "no-cache" } });
  } catch {
    return NextResponse.json({ error: "Invalid chat id" }, { status: 400 });
  }
}

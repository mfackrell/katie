import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getLongTermMemory } from "@/lib/data/persistence-store";

const paramsSchema = z.object({
  actorId: z.string().min(1),
  chatId: z.string().min(1)
});

export async function GET(request: NextRequest) {
  try {
    const { actorId, chatId } = paramsSchema.parse({
      actorId: request.nextUrl.searchParams.get("actorId"),
      chatId: request.nextUrl.searchParams.get("chatId")
    });

    const content = await getLongTermMemory(actorId, chatId);

    return NextResponse.json(
      {
        actorId,
        chatId,
        content
      },
      { headers: { "Cache-Control": "no-cache" } }
    );
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid actorId/chatId" }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Unknown persistence error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

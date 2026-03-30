import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getIntermediateMemory, setIntermediateMemory } from "@/lib/data/persistence-store";

const querySchema = z.object({
  actorId: z.string().trim().min(1),
  chatId: z.string().trim().min(1),
});

const patchBodySchema = z.object({
  content: z.record(z.string(), z.unknown()),
});

function parseQuery(request: NextRequest) {
  const url = new URL(request.url);

  return querySchema.parse({
    actorId: url.searchParams.get("actorId"),
    chatId: url.searchParams.get("chatId"),
  });
}

export async function GET(request: NextRequest) {
  try {
    const { actorId, chatId } = parseQuery(request);
    const content = await getIntermediateMemory(actorId, chatId);
    return NextResponse.json({ content }, { headers: { "Cache-Control": "no-cache" } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "actorId and chatId are required." }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Failed to load intermediate memory.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { actorId, chatId } = parseQuery(request);
    const payload = patchBodySchema.parse(await request.json());

    await setIntermediateMemory(actorId, chatId, payload.content);
    const content = await getIntermediateMemory(actorId, chatId);

    return NextResponse.json({ content });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Failed to save intermediate memory.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

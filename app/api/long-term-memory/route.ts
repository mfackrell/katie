import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeStandaloneActor } from "@/lib/standalone-accounting/auth";
import { getActorById, getLongTermMemory, setLongTermMemory, listActorMemoryDocuments } from "@/lib/data/persistence-store";

const paramsSchema = z.object({ actorId: z.string().uuid(), chatId: z.string().uuid().optional() });
const editSchema = z.object({
  actorId: z.string().uuid(),
  content: z.object({ version: z.literal(3), purpose: z.string(), entries: z.array(z.object({
    key: z.string().min(1), category: z.enum(["fact","preference","relationship","goal","decision","constraint","pattern"]),
    value: z.string().min(1), source: z.enum(["user-stated","assistant-inference"]),
    confidence: z.enum(["high","medium","low"]), evidenceMessageIds: z.array(z.string()).optional(),
    lastConfirmedAt: z.string().optional()
  })) })
});
export async function GET(request: NextRequest) {
  try {
    const { actorId } = paramsSchema.parse({
      actorId: request.nextUrl.searchParams.get("actorId"),
      chatId: request.nextUrl.searchParams.get("chatId") ?? undefined,
    });
    await authorizeStandaloneActor(request,actorId);
    if (!await getActorById(actorId)) return NextResponse.json({ error: "Actor not found" }, { status: 404 });
    const [content, documents] = await Promise.all([getLongTermMemory(actorId, ""), listActorMemoryDocuments(actorId)]);
    return NextResponse.json({ actorId, scope: "actor", content, documents },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof z.ZodError ? "Invalid request" : String(error) }, { status: 400 });
  }
}
export async function PATCH(request: NextRequest) {
  try {
    const { actorId, content } = editSchema.parse(await request.json());
    await authorizeStandaloneActor(request,actorId);
    if (!await getActorById(actorId)) return NextResponse.json({ error: "Actor not found" }, { status: 404 });
    await setLongTermMemory(actorId, "", content);
    return NextResponse.json({ actorId, saved: true, content: await getLongTermMemory(actorId, "") });
  } catch (error) {
    return NextResponse.json({ saved: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: error instanceof z.ZodError ? 400 : 500 });
  }
}

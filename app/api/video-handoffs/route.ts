import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { registerVideoHandoff, readVideoHandoff, readHandoffFiles } from "@/lib/uploads/video-handoffs";

export const runtime = "nodejs";
const schema = z.object({
  requestId: z.string().uuid(), actorId: z.string().uuid(), chatId: z.string().uuid(),
  message: z.string().max(100000),
  files: z.array(z.object({
    name: z.string().trim().min(1).max(255), type: z.string().startsWith("video/"),
    size: z.number().int().positive().max(200 * 1024 * 1024),
  })).min(1).max(5),
  overrideProvider: z.string().max(100).optional(),
  overrideModel: z.string().max(150).optional(),
  activeRepoId: z.string().max(150).optional(),
  repoInjectionEnabled: z.boolean().optional(),
});
export async function POST(request: NextRequest) {
  try {
    const input = schema.parse(await request.json());
    await registerVideoHandoff(input);
    return NextResponse.json({ status: "registered", requestId: input.requestId },
      { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Cannot register video.";
    console.warn("[Video Handoff] registration failed", { detail });
    return NextResponse.json({ error: detail }, {
      status: error instanceof z.ZodError || /does not belong|already belongs|do not match|require/.test(detail) ? 400 : 503,
    });
  }
}
export async function GET(request: NextRequest) {
  const requestId = request.nextUrl.searchParams.get("requestId");
  const actorId = request.nextUrl.searchParams.get("actorId");
  const chatId = request.nextUrl.searchParams.get("chatId");
  if (!requestId || !z.string().uuid().safeParse(requestId).success ||
      !actorId || !chatId) return NextResponse.json({error:"Invalid handoff lookup"}, {status:400});
  const row = await readVideoHandoff(requestId);
  if (!row || row.actor_id !== actorId || row.chat_id !== chatId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const files = await readHandoffFiles(requestId);
  return NextResponse.json({
    status: row.status, attempts: row.attempts, lastError: row.last_error,
    uploaded: files.filter(file => file.file_reference !== null).length, total: files.length,
  }, {headers: {"cache-control": "no-store"}});
}

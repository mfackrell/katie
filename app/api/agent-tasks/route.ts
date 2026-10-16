import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { agentRpc, readTask, refreshTask } from "@/lib/agents/store";
import { dispatchDevelopment, reconcileDevelopment } from "@/lib/agents/development";
import type { AgentTask } from "@/lib/agents/policy";
export const runtime = "nodejs";
export const maxDuration = 120;

const create = z.object({ action: z.literal("create"), id: z.string().uuid(), agentId: z.string().uuid(), input: z.string().trim().min(1).max(16000), kind: z.enum(["general", "development"]), repositoryId: z.string().uuid().optional() }).strict();
const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("refresh"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("continue"), id: z.string().uuid(), turnId: z.string().uuid(), expectedRequestId: z.string().min(1).max(128), message: z.string().trim().min(1).max(16000) }).strict(),
]);
export async function GET(request: NextRequest) {
  try {
    let id = request.nextUrl.searchParams.get("id");
    const chatId = request.nextUrl.searchParams.get("chatId");
    if (!id && chatId) {
      const { data, error } = await getSupabaseAdminClient().from("agent_tasks").select("id").eq("chat_id", z.string().uuid().parse(chatId)).maybeSingle<{ id: string }>();
      if (error || !data) throw new Error("Task chat unavailable");
      id = data.id;
    }
    if (id) return NextResponse.json({ task: await refreshTask(z.string().uuid().parse(id)) }, { headers: { "Cache-Control": "no-store" } });
    const { data, error } = await getSupabaseAdminClient().from("agent_tasks").select("id").order("created_at", { ascending: false }).limit(100);
    if (error) throw new Error("Task list unavailable");
    const tasks = await Promise.all(((data ?? []) as { id: string }[]).map(t => refreshTask(t.id)));
    return NextResponse.json({ tasks }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Task history unavailable" }, { status: 503 }); }
}
export async function POST(request: NextRequest) {
  try {
    const raw = await request.json();
    if (raw.action === "create") {
      const body = create.parse(raw);
      const task = await agentRpc("create_agent_task", { p_id: body.id, p_agent: body.agentId, p_input: body.input, p_kind: body.kind, p_repository: body.repositoryId ?? null });
      return NextResponse.json({ task });
    }
    const body = action.parse(raw);
    const saved = await readTask(body.id);
    if (body.action === "refresh") return NextResponse.json({ task: saved.kind === "development" ? await reconcileDevelopment(saved) : await refreshTask(saved.id) });
    const transition = await agentRpc<AgentTask & { continuation_receipt?: { turn_id: string; request_id: string; input: string; base_request_id: string } }>("transition_agent_task", {
      p_id: body.id, p_action: body.action, p_message: body.action === "continue" ? body.message : null,
      p_turn: body.action === "continue" ? body.turnId : null,
      p_expected_request: body.action === "continue" ? body.expectedRequestId : null,
    });
    const { continuation_receipt: continuation, ...task } = transition;
    // Start approves the saved development snapshot; continuation receipts never dispatch development work.
    return NextResponse.json({ task: task.kind === "development" ? await dispatchDevelopment(task) : task, ...(continuation ? { continuation } : {}) });
  } catch (error) { return NextResponse.json({ error: error instanceof z.ZodError ? "Invalid task request" : error instanceof Error ? error.message.slice(0, 400) : "Task operation failed" }, { status: 409 }); }
}

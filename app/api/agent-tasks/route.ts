import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { agentRpc, readTask, refreshTask } from "@/lib/agents/store";
import { dispatchDevelopment, reconcileDevelopment } from "@/lib/agents/development";
import { getChatById } from "@/lib/data/persistence-store";
import { loadTaskProgress } from "@/lib/chat/task-progress-store";
import { prepareTaskHandoffKnowledge } from "@/lib/agents/task-handoff-knowledge";
import type { AgentTask } from "@/lib/agents/policy";
export const runtime = "nodejs";
export const maxDuration = 120;

const create = z.object({ action: z.literal("create"), id: z.string().uuid(), agentId: z.string().uuid(), input: z.string().trim().min(1).max(16000), kind: z.enum(["general", "development"]), repositoryId: z.string().uuid().optional(), handoff: z.object({sourceActorId:z.string().uuid(),sourceChatId:z.string().uuid(),projectId:z.string().min(1)}).strict().optional() }).strict();
const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("refresh"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("continue"), id: z.string().uuid(), turnId: z.string().uuid(), expectedRequestId: z.string().min(1).max(128), message: z.string().trim().min(1).max(16000) }).strict(),
]);
export async function GET(request: NextRequest) {
  try {
    const handoffChatId=request.nextUrl.searchParams.get("handoffChatId");
    if(handoffChatId){
      const chat=await getChatById(z.string().uuid().parse(handoffChatId));
      if(!chat) throw new Error("Source conversation unavailable");
      const state=await loadTaskProgress(chat.actorId,chat.id);
      if(!state?.projectContext || state.projectClarification) throw new Error("Select an unambiguous source project first");
      return NextResponse.json({handoff:{sourceActorId:chat.actorId,sourceChatId:chat.id,projectId:state.projectContext.userMessageId},label:state.projectContext.text.slice(0,160)}, {headers:{"Cache-Control":"no-store"}});
    }
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
      if(body.handoff && body.kind!=="general") throw new Error("Application context handoff requires a general task");
      const knowledge = body.handoff ? await prepareTaskHandoffKnowledge(body.handoff, body.input, body.id) : [];
      const task = body.handoff ? await agentRpc("create_agent_task_handoff_with_knowledge", {p_id:body.id,p_agent:body.agentId,p_input:body.input,p_source_actor:body.handoff.sourceActorId,p_source_chat:body.handoff.sourceChatId,p_project:body.handoff.projectId,p_knowledge:knowledge}) : await agentRpc("create_agent_task", { p_id: body.id, p_agent: body.agentId, p_input: body.input, p_kind: body.kind, p_repository: body.repositoryId ?? null });
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

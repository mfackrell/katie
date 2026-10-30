import { getChatById } from "@/lib/data/persistence-store";
import { authenticateStandalonePrincipal, authorizeStandaloneCaller } from "@/lib/standalone-accounting/auth";
import { managedActor } from "@/lib/agents/store";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { agentConfigSchema } from "@/lib/agents/policy";
import { NextRequest, NextResponse } from "next/server";
import { getChatRequest } from "@/lib/chat/request-idempotency";
import { classifyPausedChatWorkflow } from "@/lib/chat/paused-workflow-recovery";

export async function GET(request: NextRequest) {
  const requestId = request.nextUrl.searchParams.get("requestId")?.trim() ?? "";
  const chatId = request.nextUrl.searchParams.get("chatId")?.trim() ?? "";

  if (!requestId || !chatId) {
    return NextResponse.json(
      { error: "requestId and chatId are required." },
      { status: 400 },
    );
  }

  try{
    const principal=await authenticateStandalonePrincipal(request);
    const chat=await getChatById(chatId);
    if(!chat)return NextResponse.json({error:"Conversation not found."},{status:404});
    if(principal.isAnonymous || principal.id!==process.env.KATIE_OWNER_AUTH_USER_ID)
      await authorizeStandaloneCaller(request,chat.actorId,chatId);
  }catch{return NextResponse.json({error:"Conversation access denied."},{status:403});}
  const record = await getChatRequest(requestId);
  const chat = await getChatById(chatId);
  if (!record || record.chatId !== chatId || chat?.actorId !== record.actorId) {
    // Image observation happens BEFORE chat_requests is claimed. A saved
    // RunPod job can legitimately be running for several minutes here.
    // Report the durable workflow rather than falsely saying no POST arrived.
    if (chat && !record) {
      const {data:workflow,error:workflowError}=await getSupabaseAdminClient()
        .from('standalone_workflows').select('status,error,updated_at,actor_id')
        .eq('request_id',requestId).eq('chat_id',chatId).eq('actor_id',chat.actorId)
        .maybeSingle<{status:string;error:string|null;updated_at:string;actor_id:string}>();
      if(workflowError)return NextResponse.json({error:'Saved request status unavailable.'},{status:503});
      if(workflow){
        const waitingForRunpod=workflow.status==='paused'&&
          Boolean(workflow.error?.includes('standalone_runpod_in_progress'));
        if(['pending','running'].includes(workflow.status)||waitingForRunpod)
          return NextResponse.json({requestId,chatId,status:'processing',
            waitingForRunpod,assistantMessageId:null,updatedAt:workflow.updated_at},
            {headers:{'Cache-Control':'no-store'}});
        if(workflow.status==='failed')
          return NextResponse.json({requestId,chatId,status:'failed',
            error:'The saved image-processing request failed. Review the original request in Usage.'},
            {headers:{'Cache-Control':'no-store'}});
      }
    }
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
  // A chat_requests receipt can remain 'processing' after the durable
  // standalone workflow has paused on an uncertain provider outcome.
  // The workflow is authoritative for recovery; never poll it as live work.
  // This is status-only: no provider retry, spending approval or state update.
  if (record.status === "processing") {
    const { data: saved, error: savedError } = await getSupabaseAdminClient()
      .from("standalone_workflows")
      .select("status,error,updated_at")
      .eq("request_id", requestId)
      .eq("chat_id", chatId)
      .eq("actor_id", record.actorId)
      .maybeSingle<{ status: string; error: string | null; updated_at: string }>();
    if (!savedError && saved) {
      const recovery = classifyPausedChatWorkflow(record.status, saved);
      if (recovery) {
        return NextResponse.json({
          requestId, chatId, ...recovery,
          assistantMessageId: null,
          updatedAt: saved.updated_at,
        }, { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } });
      }
    }
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

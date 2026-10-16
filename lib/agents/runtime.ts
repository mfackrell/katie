import type { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { listChatsByActorId, getMessages } from "@/lib/data/persistence-store";
import { loadConversationAttachmentCatalog } from "@/lib/uploads/stored-uploads";
import { agentConfigSchema, type AgentTask } from "./policy";

const managedRequest = z.object({
  actorId: z.string().uuid(), chatId: z.string().uuid(), message: z.string().min(1).max(16000),
  images: z.array(z.never()).max(0).optional(), fileReferences: z.array(z.never()).max(0).optional(),
  repoInjectionEnabled: z.literal(false).optional(), activeRepoId: z.never().optional(),
  routingTraceEnabled: z.boolean().optional(),
}).strict();
export async function authorizeManagedChat(request: NextRequest, payload: { actorId: string; chatId: string; message: string }): Promise<AgentTask | null> {
  // SQL is the authority, including for a direct /api/chat request. Lookup errors fail closed.
  const { data, error } = await getSupabaseAdminClient().rpc<AgentTask | null>("check_agent_chat", {
    p_actor: payload.actorId, p_chat: payload.chatId, p_request: request.headers.get("x-request-id") ?? "",
  });
  if (error) throw new Error("Managed task authorization unavailable or denied");
  if (!data) return null;
  const config = agentConfigSchema.parse(data.snapshot);
  if (!request.headers.get("content-type")?.includes("application/json")) throw new Error("Managed tasks require JSON requests");
  const raw = managedRequest.parse(await request.clone().json());
  if (raw.message !== data.input || raw.message.length > config.maxInputChars) throw new Error("Task input does not match saved turn");
  if (!config.attachments) {
    if (raw.images?.length || raw.fileReferences?.length) throw new Error("Attachments are disabled for this task");
    // Do not allow inspection of previously saved sources, even if inserted through another UI.
    for (const chat of await listChatsByActorId(data.actor_id)) {
      const [files, messages] = await Promise.all([loadConversationAttachmentCatalog(chat.id, async () => []), getMessages(chat.id)]);
      if (files.length || messages.some(m => m.attachments?.length)) throw new Error("Saved attachment access is disabled for this task");
    }
  }
  return { ...data, snapshot: config };
}

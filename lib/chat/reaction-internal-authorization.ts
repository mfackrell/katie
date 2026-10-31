import { AsyncLocalStorage } from "node:async_hooks";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";

type VerifiedReaction = { ownerId: string; actorId: string; chatId: string; requestId: string };
const scope = new AsyncLocalStorage<VerifiedReaction>();

/** Only a database-claimed and lease-valid reaction job may enter this server scope. */
export async function runWithVerifiedReactionReply<T>(
  job: { id: number; request_id: string; actor_id: string; chat_id: string },
  operation: () => Promise<T>,
): Promise<T> {
  const { data, error } = await getSupabaseAdminClient().rpc<string>(
    "standalone_reaction_reply_owner",
    { p_job: job.id, p_request: job.request_id, p_actor: job.actor_id, p_chat: job.chat_id },
  );
  if (error || !data) throw new Error("Verified reaction owner unavailable.");
  return scope.run(Object.freeze({
    ownerId: data, actorId: job.actor_id, chatId: job.chat_id, requestId: job.request_id,
  }), operation);
}

export function verifiedReactionOwner(
  actorId: string, chatId: string, requestId: string, resumed: boolean,
): string | null {
  const current = scope.getStore();
  if (!current) return null;
  if (resumed || current.actorId !== actorId || current.chatId !== chatId ||
      current.requestId !== requestId) {
    throw new Error("Reaction reply execution scope mismatch.");
  }
  return current.ownerId;
}

import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { emptyTaskProgress, type TaskProgressState } from "@/lib/chat/task-progress";

type StoredRow = { state: TaskProgressState };

function isProgress(value: unknown): value is TaskProgressState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<TaskProgressState>;
  return state.version === 1 &&
    Array.isArray(state.pending) &&
    Array.isArray(state.answered) &&
    ["working", "awaiting_user_answer", "answers_received"].includes(String(state.stage));
}

/** Service-role only. The caller has already verified chat ownership. */
export async function loadTaskProgress(actorId: string, chatId: string): Promise<TaskProgressState | null> {
  const { data, error } = await getSupabaseAdminClient().from("chat_task_progress")
    .select("state").eq("actor_id", actorId).eq("chat_id", chatId)
    .maybeSingle<StoredRow>();
  if (error) {
    console.warn("[TaskProgress] Failed to load task progress", { actorId, chatId, reason: error.message });
    return null;
  }
  return isProgress(data?.state) ? data.state : null;
}

/** Upsert the source-linked ledger only after the corresponding message is saved. */
export async function saveTaskProgress(
  actorId: string, chatId: string, state: TaskProgressState,
): Promise<boolean> {
  if (!isProgress(state)) return false;
  const { error } = await getSupabaseAdminClient().from("chat_task_progress")
    .upsert({
      actor_id: actorId,
      chat_id: chatId,
      state,
      updated_at: new Date().toISOString(),
    }, { onConflict: "actor_id,chat_id" });
  if (error) {
    console.warn("[TaskProgress] Failed to persist source-linked task state", { actorId, chatId, reason: error.message });
    return false;
  }
  return true;
}

export function resetInvalidTaskProgress(): TaskProgressState {
  return emptyTaskProgress();
}

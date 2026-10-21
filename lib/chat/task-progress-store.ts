import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { emptyTaskProgress, type TaskProgressState, type ProjectSnapshot, mergeTaskProjects } from "@/lib/chat/task-progress";

type StoredRow = { state: TaskProgressState };

function isProgress(value: unknown): value is TaskProgressState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<TaskProgressState>;
  const validSource = (source: unknown) => Boolean(source && typeof source === "object" &&
    typeof (source as {text?:unknown}).text === "string" &&
    typeof (source as {userMessageId?:unknown}).userMessageId === "string");
  const validProjects = state.projects === undefined || (Array.isArray(state.projects) &&
    state.projects.every(project => project && validSource(project.projectContext) &&
      (project.objective === null || validSource(project.objective)) &&
      Array.isArray(project.pending) && Array.isArray(project.answered)));
  return validProjects && state.version === 1 &&
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


/** Read only projects owned by this actor; callers must never select one implicitly. */
export async function loadActorTaskProjects(actorId: string): Promise<ProjectSnapshot[]> {
  const {data,error} = await getSupabaseAdminClient().from("chat_task_progress")
    .select("chat_id,state,updated_at").eq("actor_id",actorId).order("updated_at",{ascending:true});
  if (error) throw new Error("Saved project catalog unavailable");
  return ((data ?? []) as Array<{chat_id:string;state:unknown;updated_at:string}>).flatMap(row => {
    if (!isProgress(row.state)) return [];
    return (mergeTaskProjects(row.state, []).projects ?? []).map(project => ({
      ...project, sourceChatId: project.sourceChatId ?? row.chat_id,
      updatedAt: project.updatedAt ?? row.updated_at,
    }));
  });
}

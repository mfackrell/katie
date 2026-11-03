import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import {
  emptyTaskProgress, hasProjectAuthority, isUserWorkAssignment, mergeTaskProjects,
  type ProjectAuthority, type ProjectSnapshot, type TaskProgressState,
} from "@/lib/chat/task-progress";

type StoredRow = { state: TaskProgressState };
type UserSource = { id: string; chat_id: string; role: string; content: string };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** Resolve legacy project provenance only from actor-owned persisted user turns. */
async function readUserSources(actorId: string, sourceIds: string[]): Promise<Map<string, UserSource>> {
  const ids = [...new Set(sourceIds.filter(id => UUID.test(id)))];
  if (!ids.length) return new Map();
  const sources = new Map<string, UserSource>();
  for (let index = 0; index < ids.length; index += 100) {
    const { data, error } = await getSupabaseAdminClient().from("messages")
      .select("id,chat_id,role,content").eq("actor_id", actorId)
      .in("id", ids.slice(index, index + 100));
    if (error) throw new Error("Task-progress source verification unavailable");
    for (const message of (data ?? []) as UserSource[]) {
      if (message.role === "user") sources.set(message.id, message);
    }
  }
  return sources;
}

function qualifySource(project: { projectContext: {userMessageId: string; text: string};
  projectAuthority?: ProjectAuthority }, expectedChatId: string, sources: Map<string, UserSource>):
  { authority: ProjectAuthority; text: string } | null {
  const id = project.projectContext.userMessageId;
  if (hasProjectAuthority(project.projectContext, project.projectAuthority))
    return { authority: project.projectAuthority!, text: project.projectContext.text };
  const source = sources.get(id);
  if (!source || source.chat_id !== expectedChatId || !isUserWorkAssignment(source.content))
    return null;
  return { authority: { kind: "user-work", sourceMessageId: id }, text: source.content };
}

/** Invalid active bindings may remain in historical snapshots for audit, but never govern future work. */
function retireUnverifiedActive(state: TaskProgressState): TaskProgressState {
  return { ...state, projectContext: null, projectAuthority: undefined,
    objective: null, pending: [], answered: [], workProduct: undefined,
    projectClarification: undefined, stage: "working", nextAction: "continue_original_goal",
    lastUserIntent: "conversation" };
}

async function qualifyActiveState(actorId: string, chatId: string, state: TaskProgressState): Promise<TaskProgressState> {
  const context = state.projectContext;
  if (!context) return state;
  if (hasProjectAuthority(context, state.projectAuthority)) return state;
  const snapshot = state.projects?.find(project => project.projectContext.userMessageId === context.userMessageId);
  const sources = await readUserSources(actorId, [context.userMessageId]);
  const evidence = qualifySource({ projectContext: context }, snapshot?.sourceChatId ?? chatId, sources);
  return evidence ? { ...state, projectAuthority: evidence.authority,
    projectContext: { ...context, text: evidence.text } } : retireUnverifiedActive(state);
}

function isProgress(value: unknown): value is TaskProgressState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<TaskProgressState>;
  const validSource = (source: unknown) => Boolean(source && typeof source === "object" &&
    typeof (source as {text?:unknown}).text === "string" &&
    typeof (source as {userMessageId?:unknown}).userMessageId === "string");
  const validAuthority = (value: unknown, source: unknown) => value === undefined ||
    Boolean(source && typeof source === "object" && value && typeof value === "object" &&
      (value as ProjectAuthority).kind === "user-work" &&
      (value as ProjectAuthority).sourceMessageId === (source as { userMessageId?: string }).userMessageId);
  const validProjects = state.projects === undefined || (Array.isArray(state.projects) &&
    state.projects.every(project => project && validSource(project.projectContext) &&
      (project.objective === null || validSource(project.objective)) &&
      validAuthority(project.projectAuthority, project.projectContext) &&
      Array.isArray(project.pending) && Array.isArray(project.answered)));
  return validProjects && validAuthority(state.projectAuthority, state.projectContext) &&
    state.version === 1 &&
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
  if (!isProgress(data?.state)) return null;
  try { return await qualifyActiveState(actorId, chatId, data.state); }
  catch (error) {
    console.warn("[TaskProgress] Source verification unavailable; withholding active binding", {
      actorId, chatId, reason: error instanceof Error ? error.message : String(error),
    });
    return retireUnverifiedActive(data.state);
  }
}

/** Upsert the source-linked ledger only after the corresponding message is saved. */
export async function saveTaskProgress(
  actorId: string, chatId: string, state: TaskProgressState,
): Promise<boolean> {
  if (!isProgress(state)) return false;
  // Retries and older workflow checkpoints must pass the same provenance gate
  // as reads; never write a synthetic active project back into authority.
  let safeState: TaskProgressState;
  try { safeState = await qualifyActiveState(actorId, chatId, state); }
  catch (error) {
    console.warn("[TaskProgress] Cannot verify legacy active source before save", {
      actorId, chatId, reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  const { error } = await getSupabaseAdminClient().from("chat_task_progress")
    .upsert({
      actor_id: actorId,
      chat_id: chatId,
      state: safeState,
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
  const candidates = ((data ?? []) as Array<{chat_id:string;state:unknown;updated_at:string}>)
    .flatMap(row => !isProgress(row.state) ? [] :
      (mergeTaskProjects(row.state, []).projects ?? []).map(project => ({
        project, chatId: row.chat_id, updatedAt: row.updated_at,
      })));
  const sources = await readUserSources(actorId, candidates
    .filter(item => !hasProjectAuthority(item.project.projectContext, item.project.projectAuthority))
    .map(item => item.project.projectContext.userMessageId));
  return candidates.flatMap(({project,chatId,updatedAt}) => {
    const verified = qualifySource(project, project.sourceChatId ?? chatId, sources);
    if (!verified) return []; // Retained in storage, never silently resumable.
    return [{ ...project, projectAuthority: verified.authority,
      projectContext: { ...project.projectContext, text: verified.text },
      sourceChatId: project.sourceChatId ?? chatId,
      updatedAt: project.updatedAt ?? updatedAt }];
  });
}

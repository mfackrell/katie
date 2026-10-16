import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { getChatById } from "@/lib/data/persistence-store";
import { getChatRequest } from "@/lib/chat/request-idempotency";
import { agentConfigSchema, type AgentTask, type ManagedAgent } from "./policy";

export async function agentRpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await getSupabaseAdminClient().rpc<T>(name, args);
  if (result.error || result.data === null || result.data === undefined) throw new Error("Agent operation failed: " + (result.error?.message ?? "missing result"));
  return result.data;
}
export async function managedActor(actorId: string): Promise<ManagedAgent | null> {
  const { data, error } = await getSupabaseAdminClient().from("managed_agents").select("*").eq("actor_id", actorId).maybeSingle<ManagedAgent>();
  if (error) throw new Error("Agent configuration unavailable");
  if (data) agentConfigSchema.parse(data.config);
  return data;
}
export async function readTask(id: string): Promise<AgentTask> {
  const { data: task, error } = await getSupabaseAdminClient().from("agent_tasks").select("*").eq("id", id).maybeSingle<AgentTask>();
  if (error || !task) throw new Error("Task unavailable");
  const [agent, chat] = await Promise.all([managedActor(task.actor_id), getChatById(task.chat_id)]);
  if (!agent || agent.id !== task.agent_id || chat?.actorId !== task.actor_id) throw new Error("Task association invalid");
  agentConfigSchema.parse(task.snapshot);
  return task;
}
export async function refreshTask(id: string) {
  const task = await readTask(id);
  if (task.kind !== "general") return task;
  if (task.status === "running" && await agentRpc<boolean>("recover_agent_execution", { p_id: task.id, p_request: task.request_id })) return readTask(id);
  const record = await getChatRequest(task.request_id);
  if (!record) return task;
  if (record.actorId !== task.actor_id || record.chatId !== task.chat_id) throw new Error("Request association invalid");
  const { data, error } = await getSupabaseAdminClient().from("chat_requests").select("review_audit").eq("request_id", task.request_id).maybeSingle<{ review_audit?: { pendingClarification?: { resolvedAt?: string }; status?: string } }>();
  if (error) throw new Error("Review status unavailable");
  const audit = data?.review_audit;
  const { data: progress, error: progressError } = await getSupabaseAdminClient().from("chat_task_progress").select("state").eq("actor_id", task.actor_id).eq("chat_id", task.chat_id).maybeSingle<{ state?: { pending?: unknown[] } }>();
  if (progressError) throw new Error("Task progress unavailable");
  const pending = Boolean(progress?.state?.pending?.length) || Boolean(audit?.pendingClarification && !audit.pendingClarification.resolvedAt) || Boolean(audit && !["approved", "revised"].includes(audit.status ?? ""));
  const status = record.status === "completed" ? (pending ? "pending" : "completed") : record.status === "failed" ? "failed" : "running";
  const { error: updateError } = await getSupabaseAdminClient().from("agent_tasks").eq("id", id).eq("request_id", task.request_id).eq("status", task.status).update({ status, details: record.errorMessage ?? (pending ? "Review or pending conversation questions need continuation in this chat." : null), updated_at: new Date().toISOString() });
  if (updateError) throw new Error("Task status could not be saved");
  const verified = await readTask(id);
  if (verified.request_id !== task.request_id) return { ...verified, details: "Task advanced to another saved turn. Refresh its status." };
  if (verified.status !== status) return verified;
  return { ...verified, status, review: audit ?? null, progress: progress?.state ?? null, output: record.assistantContent ?? null, details: record.errorMessage ?? (pending ? "Review or conversation pending" : null) };
}

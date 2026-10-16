import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { isSavedDraftVerificationRetry, type PendingReviewClarification } from "@/lib/collaboration/review-completion";
import type { ProgressMessage, TaskProgressState, TaskQuestion } from "@/lib/chat/task-progress";

type AuditRow = {
  request_id: string;
  assistant_message_id?: string | null;
  review_audit: {
    status?: string;
    pendingClarification?: PendingReviewClarification;
    [key: string]: unknown;
  } | null;
  updated_at: string;
};

export type ReviewContinuationContext = {
  message: string;
  /** The ledger after applying this literal user turn, not an old cached state. */
  progress: TaskProgressState;
  history: ProgressMessage[];
  projectRelation?: "new_project" | "same_project";
};

export type SelectedReviewContinuation = {
  requestId: string;
  pending: PendingReviewClarification;
  questionMessageId: string;
  continuation: "answer" | "verification_retry";
};

/** Bind the audit before saving the assistant message that asks its question. */
export function bindPendingReviewClarification(
  pending: PendingReviewClarification,
  progress: TaskProgressState,
  questionMessageId: string,
): PendingReviewClarification {
  if (!progress.objective || !questionMessageId) return pending;
  return {
    ...pending,
    binding: {
      projectId: (progress.projectContext ?? progress.objective).userMessageId,
      taskId: progress.objective.userMessageId,
      questionMessageId,
    },
  };
}

const normalizedQuestion = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function sameQuestion(question: TaskQuestion, pending: PendingReviewClarification): boolean {
  const visible = normalizedQuestion(question.text);
  const saved = normalizedQuestion(pending.question);
  // Formatting labels such as "One question:" are not part of the question.
  return visible.length >= 12 && saved.length >= 12 && (visible.includes(saved) || saved.includes(visible));
}

function selectContinuation(row: AuditRow, context: ReviewContinuationContext): SelectedReviewContinuation | null {
  const pending = row.review_audit?.pendingClarification;
  if (row.review_audit?.status !== "needs_user_input" || !pending?.question || pending.resolvedAt) return null;
  const { progress } = context;
  if (!progress.objective) return null;
  const projectId = (progress.projectContext ?? progress.objective).userMessageId;
  const taskId = progress.objective.userMessageId;
  if (pending.binding && (pending.binding.projectId !== projectId || pending.binding.taskId !== taskId)) return null;
  const questionMessageId = pending.binding?.questionMessageId ?? row.assistant_message_id;
  // Legacy audits may be recovered only by their exact durable visible
  // question. Being in the same chat, similar wording or a generic "yes" is
  // insufficient to revive an unbound draft.
  if (!questionMessageId) return null;
  const questions = [
    ...progress.pending,
    ...progress.answered.filter(answer => answer.userMessageId === progress.lastUserMessageId && !answer.partial),
  ];
  const question = questions.find(item => item.assistantMessageId === questionMessageId &&
    (!item.projectId || item.projectId === projectId) && (!item.taskId || item.taskId === taskId) && sameQuestion(item, pending));
  if (!question) return null;
  const visible = context.history.find(turn => turn.id === questionMessageId && turn.role === "assistant");
  if (!visible || !normalizedQuestion(visible.content).includes(normalizedQuestion(question.text))) return null;
  const verificationRetry = isSavedDraftVerificationRetry(pending, context.message);
  if (/retry verification with the saved draft/i.test(pending.question) && !verificationRetry) return null;
  return { requestId: row.request_id, pending, questionMessageId, continuation: verificationRetry ? "verification_retry" : "answer" };
}

/**
 * Resume data lives in the same durable audit as the reviewer findings and draft.
 * Actor/chat lookup is only the outer scope: project, task and question identity
 * must also match before saved context or a candidate can enter this request.
 */
export async function getPendingReviewClarification(
  actorId: string,
  chatId: string,
  context?: ReviewContinuationContext,
): Promise<SelectedReviewContinuation | null> {
  if (!context || context.projectRelation === "new_project" ||
    ["new_task", "revision", "feedback", "clarification", "conversation"].includes(context.progress.lastUserIntent ?? "")) return null;
  const { data, error } = await getSupabaseAdminClient().from("chat_requests")
    .select("request_id,assistant_message_id,review_audit,updated_at")
    .eq("actor_id", actorId).eq("chat_id", chatId)
    .order("created_at", { ascending: false }).limit(20);
  if (error) {
    console.warn("[ReviewContinuity] Unable to look up pending clarification", { chatId, reason: error.message });
    return null;
  }
  for (const row of (data as AuditRow[] | null) ?? []) {
    const selected = selectContinuation(row, context);
    if (selected) return selected;
  }
  return null;
}

/**
 * Mark the old request resolved only after the new response has been saved.
 * A failed generation leaves the original draft and question resumable.
 */
export async function resolvePendingReviewClarification(input: {
  requestId: string;
  actorId: string;
  chatId: string;
  resumedByRequestId: string;
  /** True only after the selected task's finished answer and progress are durable. */
  completed: boolean;
}): Promise<boolean> {
  if (!input.completed) return false;
  const client = getSupabaseAdminClient();
  const { data, error } = await client.from("chat_requests")
    .select("review_audit,updated_at")
    .eq("request_id", input.requestId)
    .eq("actor_id", input.actorId).eq("chat_id", input.chatId)
    .maybeSingle<Pick<AuditRow,"review_audit" | "updated_at">>();
  if (error || !data?.review_audit?.pendingClarification || data.review_audit.pendingClarification.resolvedAt) return false;
  const changed = {
    ...data.review_audit,
    pendingClarification: {
      ...data.review_audit.pendingClarification,
      resolvedAt: new Date().toISOString(),
      resumedByRequestId: input.resumedByRequestId,
    },
  };
  const { error: updateError } = await client.from("chat_requests")
    .eq("request_id", input.requestId).eq("actor_id", input.actorId)
    .eq("chat_id", input.chatId).eq("updated_at", data.updated_at)
    .update({ review_audit: changed });
  if (updateError) {
    console.warn("[ReviewContinuity] Clarification resolution failed", {
      requestId: input.requestId, reason: updateError.message,
    });
    return false;
  }
  // The minimal Supabase admin wrapper has no affected-row count for UPDATE.
  // Read back to avoid reporting success when an optimistic filter matched zero rows.
  const { data: verified, error: verifyError } = await client.from("chat_requests").select("review_audit")
    .eq("request_id", input.requestId).eq("actor_id", input.actorId)
    .eq("chat_id", input.chatId).maybeSingle<{ review_audit: AuditRow["review_audit"] }>();
  if (verifyError || verified?.review_audit?.pendingClarification?.resumedByRequestId !== input.resumedByRequestId) {
    console.warn("[ReviewContinuity] Clarification update was not confirmed", { requestId: input.requestId });
    return false;
  }
  return true;
}


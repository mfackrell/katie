import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import type { PendingReviewClarification } from "@/lib/collaboration/review-completion";

type AuditRow = {
  request_id: string;
  review_audit: {
    status?: string;
    pendingClarification?: PendingReviewClarification;
    [key: string]: unknown;
  } | null;
  updated_at: string;
};

/**
 * Resume data lives in the same durable audit as the reviewer findings and draft.
 * Actor/chat scoping prevents an unrelated chat or actor from consuming the task.
 */
export async function getPendingReviewClarification(actorId: string, chatId: string): Promise<{
  requestId: string;
  pending: PendingReviewClarification;
} | null> {
  const { data, error } = await getSupabaseAdminClient().from("chat_requests")
    .select("request_id,review_audit,updated_at")
    .eq("actor_id", actorId).eq("chat_id", chatId)
    .order("created_at", { ascending: false }).limit(20);
  if (error) {
    console.warn("[ReviewContinuity] Unable to look up pending clarification", { chatId, reason: error.message });
    return null;
  }
  const row = (data as AuditRow[] | null)?.find(item =>
    item.review_audit?.status === "needs_user_input" &&
    item.review_audit.pendingClarification?.question &&
    !item.review_audit.pendingClarification.resolvedAt
  );
  if (!row?.review_audit?.pendingClarification) return null;
  return { requestId: row.request_id, pending: row.review_audit.pendingClarification };
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
}): Promise<void> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client.from("chat_requests")
    .select("review_audit,updated_at")
    .eq("request_id", input.requestId)
    .eq("actor_id", input.actorId).eq("chat_id", input.chatId)
    .maybeSingle<Pick<AuditRow,"review_audit" | "updated_at">>();
  if (error || !data?.review_audit?.pendingClarification || data.review_audit.pendingClarification.resolvedAt) return;
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
    return;
  }
  // The minimal Supabase admin wrapper has no affected-row count for UPDATE.
  // Read back to avoid reporting success when an optimistic filter matched zero rows.
  const { data: verified } = await client.from("chat_requests").select("review_audit")
    .eq("request_id", input.requestId).eq("actor_id", input.actorId)
    .eq("chat_id", input.chatId).maybeSingle<{ review_audit: AuditRow["review_audit"] }>();
  if (verified?.review_audit?.pendingClarification?.resumedByRequestId !== input.resumedByRequestId) {
    console.warn("[ReviewContinuity] Clarification update was not confirmed", { requestId: input.requestId });
  }
}


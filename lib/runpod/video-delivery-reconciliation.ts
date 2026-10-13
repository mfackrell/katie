import type { resultStore } from "./durable-results";

export const DELIVERY_ROW_LIMIT = 24;
export const DELIVERY_ATTEMPT_LIMIT = 4;

/** Durable least-recently-touched scheduling, independent of process lifetime.
 * Other workers may also touch updated_at; they only defer that request while
 * untouched deliveries move forward. Never change outcome or lease fields here.
 */
export async function reconcileVideoDeliveries(
  client: ReturnType<typeof resultStore>,
  publish: (requestId: string) => Promise<{ status: string }>,
  now: () => string = () => new Date().toISOString(),
  onError: (requestId: string, error: unknown) => void = (requestId, error) => {
    console.error("[Video Reconcile] Chat delivery will retry", { requestId, error });
  },
) {
  const { data, error } = await client.from("video_analysis_jobs")
    .select("chat_request_id")
    .not("chat_request_id", "is", null).is("response_delivered_at", null)
    .order("updated_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true }).limit(DELIVERY_ROW_LIMIT);
  if (error) throw new Error("Cannot inspect pending video deliveries");
  const ids = [...new Set((data ?? []).map(row => row.chat_request_id)
    .filter((id): id is string => typeof id === "string"))];
  let deliveryAttempted = 0, published = 0, deliveryFailed = 0;
  await Promise.all(ids.slice(0, DELIVERY_ATTEMPT_LIMIT).map(async id => {
    try {
      // Touch the entire batch before publishing, including throwing/unready
      // requests. A killed invocation also yields its place on the next run.
      const { error: touchError } = await client.from("video_analysis_jobs")
        .update({ updated_at: now() }).eq("chat_request_id", id)
        .is("response_delivered_at", null);
      if (touchError) throw new Error("Cannot persist video delivery scheduling");
      deliveryAttempted++;
      const result = await publish(id);
      if (result.status === "delivered") published++;
    } catch (error) {
      deliveryFailed++;
      onError(id, error);
    }
  }));
  return {
    deliveryAttempted, deliveryFailed, published,
    // This is a bounded candidate window, not a total backlog count.
    pendingConversations: ids.length, deliveryCandidateRows: (data ?? []).length,
    deliveryWindowFull: (data ?? []).length === DELIVERY_ROW_LIMIT,
  };
}

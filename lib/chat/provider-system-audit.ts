import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import type { ProviderSystemAudit } from "@/lib/providers/types";

const MAX_SYSTEM_CHARS = 240_000;

export type StoredProviderSystemAudit = ProviderSystemAudit & {
  capturedAt: string;
  truncated: boolean;
};

export function boundProviderSystemAudit(audit: ProviderSystemAudit): StoredProviderSystemAudit {
  let remaining = MAX_SYSTEM_CHARS;
  let truncated = false;
  const systemMessages = audit.systemMessages.map(section => {
    const available = Math.max(0, remaining);
    if (section.length > available) truncated = true;
    const text = section.slice(0, available);
    remaining -= text.length;
    return text;
  });
  return {
    provider: audit.provider,
    model: audit.model,
    endpoint: audit.endpoint,
    systemMessages,
    capturedAt: new Date().toISOString(),
    truncated,
  };
}

/**
 * Snapshots only literal provider system messages, never Authorization
 * headers, user image bytes, file objects, provider tokens or raw requests.
 * It is bound to a request ID, actor AND chat, with no cross-chat lookup.
 */
export async function saveProviderSystemAudit(
  actorId: string,
  chatId: string,
  requestId: string,
  audit: ProviderSystemAudit,
): Promise<void> {
  const bounded = boundProviderSystemAudit(audit);
  const { error } = await getSupabaseAdminClient().from("chat_requests")
    .eq("request_id", requestId)
    .eq("actor_id", actorId)
    .eq("chat_id", chatId)
    .update({ provider_system_audit: bounded });
  if (error) {
    console.warn("[Prompt Inspection] Could not persist provider system audit", {
      requestId,
      reason: error.message,
    });
  } else {
    console.info("[Prompt Inspection] provider system messages captured", {
      requestId, provider: audit.provider, model: audit.model,
      endpoint: audit.endpoint, count: bounded.systemMessages.length,
      truncated: bounded.truncated,
    });
  }
}

export async function latestProviderSystemAudit(actorId: string, chatId: string): Promise<
  { requestId: string; snapshot: StoredProviderSystemAudit } | null
> {
  const { data, error } = await getSupabaseAdminClient().from("chat_requests")
    .select("request_id,provider_system_audit,created_at")
    .eq("actor_id", actorId)
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(50)
    .returns<Array<{ request_id: string; provider_system_audit: unknown }>>();
  if (error) {
    console.warn("[Prompt Inspection] Cannot read previous provider payload", { reason: error.message });
    return null;
  }
  for (const row of data ?? []) {
    const audit = row.provider_system_audit;
    if (!audit || typeof audit !== "object") continue;
    const a = audit as Partial<StoredProviderSystemAudit>;
    if (!Array.isArray(a.systemMessages) || !a.systemMessages.every(section => typeof section === "string") ||
        typeof a.provider !== "string" || typeof a.model !== "string" ||
        typeof a.endpoint !== "string") continue;
    return { requestId: row.request_id, snapshot: a as StoredProviderSystemAudit };
  }
  return null;
}

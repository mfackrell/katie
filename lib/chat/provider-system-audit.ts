import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import type { ProviderSystemAudit } from "@/lib/providers/types";

const MAX_SYSTEM_CHARS = 240_000;
const MAX_AUTHORIZED_DIAGNOSTIC_CHARS = 750_000;

export type StoredProviderSystemAudit = Omit<ProviderSystemAudit, "requestDiagnostic"> & {
  requestDiagnostic?: ProviderSystemAudit["requestDiagnostic"] | { status: "capture-too-large"; charCount: number };
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
    ...(typeof audit.imagePrompt === "string" ? { imagePrompt: audit.imagePrompt.slice(0, 2048) } : {}),
    ...(audit.contextSynthesis ? { contextSynthesis: audit.contextSynthesis } : {}),
    ...(audit.requestDiagnostic ? (() => {
      const charCount = JSON.stringify(audit.requestDiagnostic).length;
      return { requestDiagnostic: charCount <= MAX_AUTHORIZED_DIAGNOSTIC_CHARS
        ? audit.requestDiagnostic
        : { status: "capture-too-large", charCount } };
    })() : {}),
    capturedAt: new Date().toISOString(),
    truncated,
  };
}

/**
 * Ordinary snapshots contain system messages only. A separate, explicit, owner-
 * authorized text-only diagnostic may also capture the prepared first-pass body.
 * Never capture authorization headers, image bytes, provider tokens, or files.
 * It is bound to a request ID, actor AND chat, with no cross-chat lookup.
 */
export async function saveProviderSystemAudit(
  actorId: string,
  chatId: string,
  requestId: string,
  audit: ProviderSystemAudit,
): Promise<void> {
  const bounded = boundProviderSystemAudit(audit);
  try {
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
  } catch (error) {
    // Transparency is diagnostic and must never block an otherwise valid
    // user request or trigger a provider reroute on database timeouts.
    console.warn("[Prompt Inspection] audit write unavailable", {
      requestId, reason: error instanceof Error ? error.message : String(error),
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
    .returns<{ request_id: string; provider_system_audit: unknown }>();
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
    // Generic prompt inspection must not expose the opt-in owner-only wire payload.
    const { requestDiagnostic: _privateDiagnostic, ...safeAudit } = a;
    void _privateDiagnostic;
    return { requestId: row.request_id, snapshot: safeAudit as StoredProviderSystemAudit };
  }
  return null;
}

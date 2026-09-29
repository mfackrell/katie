import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import type { LlmProvider } from "@/lib/providers/types";
import {
  classifyGenerationFailure,
  describeGenerationFailure,
} from "@/lib/router/provider-error";

type ProviderHealthRow = {
  provider_name: LlmProvider["name"];
  status: "blocked" | "healthy";
  reason: string | null;
  failure_count: number;
  blocked_until: string | null;
  updated_at: string;
};

function blockDurationMs(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (/no credits remaining|insufficient[_ -]?quota|billing|payment required|credit balance/i.test(message)) {
    return 15 * 60 * 1000;
  }
  if (/authentication|unauthorized|invalid api key|invalid_api_key/i.test(message)) {
    return 15 * 60 * 1000;
  }
  if (/rate.?limit|too many requests|\b429\b/i.test(message)) {
    return 45 * 1000;
  }

  return 2 * 60 * 1000;
}

export async function filterProvidersBySharedHealth(
  providers: LlmProvider[],
): Promise<{
  providers: LlmProvider[];
  blocked: Array<{ provider: LlmProvider["name"]; reason: string; blockedUntil: string }>;
  available: boolean;
}> {
  if (providers.length <= 1) {
    return { providers, blocked: [], available: true };
  }

  try {
    const client = getSupabaseAdminClient();
    const names = providers.map((provider) => provider.name);
    const { data, error } = await client
      .from("provider_health")
      .select("provider_name,status,reason,failure_count,blocked_until,updated_at")
      .in("provider_name", names)
      .returns<ProviderHealthRow>();

    if (error) {
      console.warn("[ProviderHealth] Shared health lookup unavailable; failing open.", {
        reason: error.message,
      });
      return { providers, blocked: [], available: false };
    }

    const now = Date.now();
    const blockedRows = (data ?? []).filter((row) => {
      if (row.status !== "blocked" || !row.blocked_until) {
        return false;
      }
      const blockedUntil = Date.parse(row.blocked_until);
      return Number.isFinite(blockedUntil) && blockedUntil > now;
    });

    const blockedNames = new Set(blockedRows.map((row) => row.provider_name));
    const healthyProviders = providers.filter(
      (provider) => !blockedNames.has(provider.name),
    );

    // Never convert a partial provider outage into a total outage. If every
    // configured provider is blocked, let the normal router probe/recover.
    if (healthyProviders.length === 0) {
      return {
        providers,
        blocked: blockedRows.map((row) => ({
          provider: row.provider_name,
          reason: row.reason ?? "temporarily unavailable",
          blockedUntil: row.blocked_until as string,
        })),
        available: true,
      };
    }

    return {
      providers: healthyProviders,
      blocked: blockedRows.map((row) => ({
        provider: row.provider_name,
        reason: row.reason ?? "temporarily unavailable",
        blockedUntil: row.blocked_until as string,
      })),
      available: true,
    };
  } catch (error) {
    console.warn("[ProviderHealth] Shared health lookup failed; failing open.", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return { providers, blocked: [], available: false };
  }
}

export async function recordSharedProviderFailure(
  providerName: LlmProvider["name"],
  errorValue: unknown,
): Promise<void> {
  if (classifyGenerationFailure(errorValue) !== "provider") {
    return;
  }

  try {
    const client = getSupabaseAdminClient();
    const existing = await client
      .from("provider_health")
      .select("provider_name,status,reason,failure_count,blocked_until,updated_at")
      .eq("provider_name", providerName)
      .maybeSingle<ProviderHealthRow>();

    if (existing.error) {
      console.warn("[ProviderHealth] Unable to read provider health; skipping shared circuit update.", {
        provider: providerName,
        reason: existing.error.message,
      });
      return;
    }

    const now = Date.now();
    const blockedUntil = new Date(now + blockDurationMs(errorValue)).toISOString();
    const reason = describeGenerationFailure(errorValue);
    const failureCount = Math.max(0, existing.data?.failure_count ?? 0) + 1;

    const { error } = await client
      .from("provider_health")
      .upsert(
        {
          provider_name: providerName,
          status: "blocked",
          reason,
          failure_count: failureCount,
          blocked_until: blockedUntil,
          updated_at: new Date(now).toISOString(),
        },
        { onConflict: "provider_name" },
      );

    if (error) {
      console.warn("[ProviderHealth] Failed to update shared circuit breaker.", {
        provider: providerName,
        reason: error.message,
      });
      return;
    }

    console.warn("[ProviderHealth] Provider temporarily blocked across requests.", {
      provider: providerName,
      reason,
      blockedUntil,
      failureCount,
    });
  } catch (error) {
    console.warn("[ProviderHealth] Shared circuit update failed.", {
      provider: providerName,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

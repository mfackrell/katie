import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { classifyGenerationFailure } from "@/lib/router/provider-error";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();

  try {
    const client = getSupabaseAdminClient();
    const [chatRequests, providerHealth] = await Promise.all([
      client
        .from("chat_requests")
        .select("request_id,status,updated_at")
        .limit(1)
        .returns<{ request_id: string; status: string; updated_at: string }>(),
      client
        .from("provider_health")
        .select("provider_name,status,blocked_until,updated_at")
        .limit(1)
        .returns<{
          provider_name: string;
          status: string;
          blocked_until: string | null;
          updated_at: string;
        }>(),
    ]);

    const checks = {
      chatRequestsTable: !chatRequests.error,
      providerHealthTable: !providerHealth.error,
      rateLimitIsProviderWide:
        classifyGenerationFailure(
          new Error("429 Too many requests: rate limit exceeded"),
        ) === "provider",
      quotaFailureIsProviderWide:
        classifyGenerationFailure(
          new Error("429 You have no credits remaining."),
        ) === "provider",
      modelNotFoundIsModelScoped:
        classifyGenerationFailure(
          new Error("404 The model does not exist or you do not have access to it."),
        ) === "model",
    };

    const ok = Object.values(checks).every(Boolean);

    return NextResponse.json(
      {
        ok,
        checks,
        durationMs: Date.now() - startedAt,
      },
      {
        status: ok ? 200 : 500,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";

type DiagnosticModel = {
  provider_name: string;
  model_id: string;
  is_active: boolean;
  discovery_status: string;
  capability_status: string;
  pricing_status: string;
  routing_eligibility: string;
  reasoning_tier: string | null;
  supports_text: boolean | null;
  capability_verified_at: string | null;
  pricing_verified_at: string | null;
  failure_reason: string | null;
  source_metadata: Record<string, unknown> | null;
};

function evidenceAgeHours(value: string | null, now: number): number | null {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) && timestamp <= now
    ? Math.round((now - timestamp) / 36000) / 100 : null;
}

/** Protected operations inspection: read only; never reveal API keys or user messages. */
export async function GET(request: NextRequest) {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token || request.headers.get("x-internal-token") !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const {data, error} = await getSupabaseAdminClient()
    .from("model_registry")
    .select("provider_name,model_id,is_active,discovery_status,capability_status,pricing_status,routing_eligibility,reasoning_tier,supports_text,capability_verified_at,pricing_verified_at,failure_reason,source_metadata")
    .order("provider_name", { ascending: true }).order("model_id", { ascending: true }).limit(1000)
    .returns<DiagnosticModel>();
  if (error) {
    return NextResponse.json({error: "Registry diagnostics unavailable"}, {status: 503});
  }
  const now = Date.now();
  const models = (data ?? []).map(row => {
    const metadata = row.source_metadata ?? {};
    const capabilityAge = evidenceAgeHours(row.capability_verified_at, now);
    const pricingAge = evidenceAgeHours(row.pricing_verified_at, now);
    const capabilityCurrent = row.capability_status === "verified" &&
      capabilityAge !== null && capabilityAge < 24;
    const pricingCurrent = row.pricing_status === "verified" &&
      pricingAge !== null && pricingAge < 24;
    const reasons = [
      ...(!row.is_active ? [row.failure_reason || "not_active_or_quarantined"] : []),
      ...(row.capability_status !== "verified" ? ["capabilities_not_authoritatively_verified"] : []),
      ...(row.capability_status === "verified" && !capabilityCurrent ? ["capability_evidence_stale"] : []),
      ...(row.pricing_status !== "verified" ? ["pricing_not_authoritatively_verified"] : []),
      ...(row.pricing_status === "verified" && !pricingCurrent ? ["pricing_evidence_stale"] : []),
      ...(row.is_active && row.routing_eligibility === "manual_override_only" ? ["manual_override_required"] : []),
      ...(row.is_active && row.routing_eligibility === "disabled" ? ["explicitly_disabled"] : [])
    ];
    return {
      provider: row.provider_name,
      model_id: row.model_id,
      discovered: row.discovery_status === "discovered",
      active: row.is_active,
      capability_status: row.capability_status,
      pricing_status: row.pricing_status,
      routing_eligibility: row.routing_eligibility,
      reasoning_tier: row.reasoning_tier,
      manual_selection_visible: row.is_active,
      ordinary_text_candidate: row.is_active &&
        row.supports_text === true &&
        ["verified", "restricted"].includes(row.routing_eligibility),
      complex_text_documented: row.is_active &&
        row.supports_text === true && row.reasoning_tier === "high" &&
        row.capability_status === "verified",
      capability_age_hours: capabilityAge,
      pricing_age_hours: pricingAge,
      capability_source: metadata.capability_verification_source ?? metadata.capability_source ?? "unknown",
      pricing_source: metadata.pricing_verification_source ?? metadata.pricing_source ?? "unknown",
      endpoint_support: metadata.supported_endpoints ?? "unverified",
      context_window_tokens: metadata.context_window_tokens ?? null,
      max_output_tokens: metadata.max_output_tokens ?? null,
      price_scope: metadata.price_verified_scope ?? null,
      inference_account_verified: metadata.inference_account_verified === true,
      status_reasons: reasons.length ? reasons : ["eligible_subject_to_endpoint_and_spending_controls"]
    };
  });
  return NextResponse.json({
    observed_at: new Date(now).toISOString(),
    model_count: models.length,
    models
  }, { headers: { "Cache-Control": "no-store" } });
}
export const runtime = "nodejs";

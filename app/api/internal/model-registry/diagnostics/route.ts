import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { buildRegistryDiagnostic, type RegistryDiagnosticRow } from "@/lib/models/registry";

/** Protected, read-only operations inspection. Report the router's EFFECTIVE eligibility. */
export async function GET(request: NextRequest) {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token || request.headers.get("x-internal-token") !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data, error } = await getSupabaseAdminClient()
    .from("model_registry")
    .select("provider_name,model_id,is_active,discovery_status,capability_status,pricing_status,routing_eligibility,reasoning_tier,supports_text,pricing_input_per_1m,pricing_output_per_1m,capability_verified_at,pricing_verified_at,failure_reason,source_metadata")
    .order("provider_name", { ascending: true })
    .order("model_id", { ascending: true })
    .limit(1000)
    .returns<RegistryDiagnosticRow>();
  if (error) {
    return NextResponse.json({ error: "Registry diagnostics unavailable" }, { status: 503 });
  }
  const observedAt = new Date().toISOString();
  const models = (data ?? []).map((row) => buildRegistryDiagnostic(row, observedAt));
  return NextResponse.json({
    observed_at: observedAt,
    model_count: models.length,
    models
  }, { headers: { "Cache-Control": "no-store" } });
}
export const runtime = "nodejs";

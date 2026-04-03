import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import type { LlmProvider } from "@/lib/providers/types";

export type RoutingEligibility = "verified" | "restricted" | "manual_override_only" | "disabled";
export type ConfidenceTier = "high" | "medium" | "low";

export type RegistryCapabilitySource = "provider" | "pricing_catalog" | "heuristic" | "unknown";

export type ModelRegistryRecord = {
  provider_name: LlmProvider["name"];
  model_id: string;
  normalized_model_id: string;
  first_seen_at: string;
  last_seen_at: string;
  discovered_at: string;
  is_active: boolean;
  discovery_status: "discovered" | "provider_error";
  pricing_status: "verified" | "estimated" | "missing" | "error";
  capability_status: "verified" | "heuristic" | "missing" | "conflict";
  routing_eligibility: RoutingEligibility;
  confidence_score: number;
  confidence_tier: ConfidenceTier;
  source_metadata: Record<string, unknown>;
  pricing_input_per_1m: number | null;
  pricing_output_per_1m: number | null;
  supports_text: boolean | null;
  supports_vision: boolean | null;
  supports_web_search: boolean | null;
  supports_image_generation: boolean | null;
  supports_video: boolean | null;
  reasoning_tier: "high" | "medium" | "low" | null;
  speed_tier: "fast" | "medium" | "slow" | null;
  cost_tier: "low" | "medium" | "high" | null;
  capability_verified_at: string | null;
  pricing_verified_at: string | null;
  verification_updated_at: string | null;
  failure_reason: string | null;
  exception_count: number;
  last_exception_at: string | null;
};

export type RegistryRoutingModel = Pick<
  ModelRegistryRecord,
  | "provider_name"
  | "model_id"
  | "routing_eligibility"
  | "confidence_tier"
  | "confidence_score"
  | "supports_text"
  | "supports_vision"
  | "supports_web_search"
  | "supports_image_generation"
  | "supports_video"
  | "reasoning_tier"
  | "speed_tier"
  | "cost_tier"
>;

const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

async function logRegistryException(args: {
  providerName: LlmProvider["name"];
  modelId?: string;
  exceptionType: string;
  reason: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const client = getSupabaseAdminClient();
    const normalized = args.modelId ? normalizeModelId(args.modelId) : "provider-scope";
    await client.from("model_registry_exceptions").insert({
      provider_name: args.providerName,
      model_id: args.modelId ?? null,
      normalized_model_id: normalized,
      exception_type: args.exceptionType,
      exception_reason: args.reason,
      metadata: args.metadata ?? {}
    });
  } catch {
    // no-op: exception logging must never block refresh
  }
}

async function createRefreshRun(status: "running" | "completed" | "failed", providers: LlmProvider["name"][]): Promise<string | null> {
  try {
    const client = getSupabaseAdminClient();
    const { data } = await client
      .from("model_registry_refresh_runs")
      .insert({
        status,
        providers,
        summary: { provider_count: providers.length }
      })
      .select("id")
      .single<{ id: string }>();
    return data?.id ?? null;
  } catch {
    return null;
  }
}

async function completeRefreshRun(runId: string | null, status: "completed" | "failed", summary: Record<string, unknown>): Promise<void> {
  if (!runId) {
    return;
  }

  try {
    const client = getSupabaseAdminClient();
    await client
      .from("model_registry_refresh_runs")
      .eq("id", runId)
      .update({
        status,
        summary,
        finished_at: new Date().toISOString()
      });
  } catch {
    // no-op
  }
}

function toConfidenceTier(score: number): ConfidenceTier {
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "medium";
  return "low";
}

export function normalizeModelId(modelId: string): string {
  return modelId.trim().replace(/^models\//i, "").toLowerCase();
}

function heuristicCapabilities(providerName: LlmProvider["name"], modelId: string): {
  supports_text: boolean;
  supports_vision: boolean;
  supports_web_search: boolean;
  supports_image_generation: boolean;
  supports_video: boolean;
  reasoning_tier: "high" | "medium" | "low";
  speed_tier: "fast" | "medium" | "slow";
  cost_tier: "low" | "medium" | "high";
} {
  const m = modelId.toLowerCase();
  const supportsImage = /image|imagine|banana/.test(m);
  const supportsVision = !supportsImage && /vision|gpt-4o|gpt-5|gemini|claude|grok-4|grok-3|o3/.test(m);
  const supportsWebSearch = providerName === "grok" || /search/.test(m);
  const supportsVideo = providerName === "google" && /gemini/.test(m);
  const reasoning = /o3|opus|sonnet|pro|codex|gpt-5/.test(m) ? "high" : /mini|flash|haiku/.test(m) ? "low" : "medium";
  const speed = /mini|flash|haiku|nano/.test(m) ? "fast" : /o3|opus/.test(m) ? "slow" : "medium";
  const cost = /mini|flash|haiku|nano/.test(m) ? "low" : /o3|opus|pro|gpt-5/.test(m) ? "high" : "medium";

  return {
    supports_text: !supportsImage,
    supports_vision: supportsVision,
    supports_web_search: supportsWebSearch,
    supports_image_generation: supportsImage,
    supports_video: supportsVideo,
    reasoning_tier: reasoning,
    speed_tier: speed,
    cost_tier: cost
  };
}

export function computeRoutingEligibility(input: {
  capability_status: ModelRegistryRecord["capability_status"];
  pricing_status: ModelRegistryRecord["pricing_status"];
  confidence_score: number;
}): RoutingEligibility {
  if (input.capability_status === "conflict") {
    return "disabled";
  }

  if (input.capability_status === "verified" && input.pricing_status !== "missing" && input.confidence_score >= 0.8) {
    return "verified";
  }

  if (["verified", "heuristic"].includes(input.capability_status)) {
    return "restricted";
  }

  return "manual_override_only";
}

async function fetchLiteLlmPricingCatalog(): Promise<Record<string, { input_cost_per_token?: number; output_cost_per_token?: number }>> {
  try {
    const response = await fetch(LITELLM_PRICING_URL, { signal: AbortSignal.timeout(2000), cache: "no-store" });
    if (!response.ok) {
      throw new Error(`status=${response.status}`);
    }
    return (await response.json()) as Record<string, { input_cost_per_token?: number; output_cost_per_token?: number }>;
  } catch (error) {
    console.warn("[ModelRegistry] pricing_catalog_fetch_failed", { error: error instanceof Error ? error.message : String(error) });
    return {};
  }
}

function toPricingPer1M(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Number((value * 1_000_000).toFixed(4));
}

function enrichModelRecord(providerName: LlmProvider["name"], modelId: string, pricingCatalog: Record<string, { input_cost_per_token?: number; output_cost_per_token?: number }>, nowIso: string) {
  const normalizedModelId = normalizeModelId(modelId);
  const heuristic = heuristicCapabilities(providerName, modelId);
  const pricing = pricingCatalog[normalizedModelId] ?? pricingCatalog[`${providerName}/${normalizedModelId}`] ?? null;
  const pricingInput = toPricingPer1M(pricing?.input_cost_per_token);
  const pricingOutput = toPricingPer1M(pricing?.output_cost_per_token);
  const pricingStatus: ModelRegistryRecord["pricing_status"] = pricingInput !== null || pricingOutput !== null ? "estimated" : "missing";
  const capabilityStatus: ModelRegistryRecord["capability_status"] = "heuristic";
  const confidenceScore = pricingStatus === "estimated" ? 0.65 : 0.45;
  const routingEligibility = computeRoutingEligibility({
    capability_status: capabilityStatus,
    pricing_status: pricingStatus,
    confidence_score: confidenceScore
  });

  return {
    provider_name: providerName,
    model_id: modelId,
    normalized_model_id: normalizedModelId,
    discovered_at: nowIso,
    last_seen_at: nowIso,
    is_active: true,
    discovery_status: "discovered" as const,
    pricing_status: pricingStatus,
    capability_status: capabilityStatus,
    routing_eligibility: routingEligibility,
    confidence_score: confidenceScore,
    confidence_tier: toConfidenceTier(confidenceScore),
    source_metadata: {
      capability_source: "heuristic" as RegistryCapabilitySource,
      pricing_source: pricing ? "pricing_catalog" : "unknown",
      normalized_model_id: normalizedModelId,
      pipeline_version: "registry-v1"
    },
    pricing_input_per_1m: pricingInput,
    pricing_output_per_1m: pricingOutput,
    supports_text: heuristic.supports_text,
    supports_vision: heuristic.supports_vision,
    supports_web_search: heuristic.supports_web_search,
    supports_image_generation: heuristic.supports_image_generation,
    supports_video: heuristic.supports_video,
    reasoning_tier: heuristic.reasoning_tier,
    speed_tier: heuristic.speed_tier,
    cost_tier: heuristic.cost_tier,
    capability_verified_at: null,
    pricing_verified_at: pricing ? nowIso : null,
    verification_updated_at: nowIso,
    failure_reason: pricing ? null : "missing_pricing",
    last_exception_at: pricing ? null : nowIso
  };
}

export async function refreshModelRegistry(providers: LlmProvider[]): Promise<void> {
  const client = getSupabaseAdminClient();
  const nowIso = new Date().toISOString();
  const pricingCatalog = await fetchLiteLlmPricingCatalog();
  const runId = await createRefreshRun("running", providers.map((provider) => provider.name));
  let providerFailures = 0;
  let discoveredTotal = 0;

  for (const provider of providers) {
    try {
      const discovered = await provider.listModels();
      discoveredTotal += discovered.length;
      const rows = discovered.map((modelId) => enrichModelRecord(provider.name, modelId, pricingCatalog, nowIso));

      if (rows.length) {
        const { error } = await client.from("model_registry").upsert(rows, { onConflict: "provider_name,normalized_model_id" });
        if (error) {
          throw new Error(error.message);
        }
      }

      const discoveredNormalized = new Set(discovered.map((modelId) => normalizeModelId(modelId)));
      const { data, error: selectError } = await client
        .from("model_registry")
        .select("provider_name,normalized_model_id")
        .eq("provider_name", provider.name)
        .eq("is_active", true)
        .returns<{ provider_name: LlmProvider["name"]; normalized_model_id: string }>();

      if (selectError) {
        throw new Error(selectError.message);
      }

      const toDisable = (data ?? []).filter((record) => !discoveredNormalized.has(record.normalized_model_id));
      for (const disabled of toDisable) {
        const { error: updateError } = await client
          .from("model_registry")
          .eq("provider_name", disabled.provider_name)
          .eq("normalized_model_id", disabled.normalized_model_id)
          .update({ is_active: false, routing_eligibility: "disabled", last_seen_at: nowIso, failure_reason: "model_not_listed" });

        if (updateError) {
          throw new Error(updateError.message);
        }
      }

      console.info("[ModelRegistry] provider_discovery_complete", {
        provider: provider.name,
        discovered_count: discovered.length,
        disabled_count: toDisable.length
      });
    } catch (error) {
      providerFailures += 1;
      console.error("[ModelRegistry] provider_discovery_failed", {
        provider: provider.name,
        error: error instanceof Error ? error.message : String(error)
      });
      await logRegistryException({
        providerName: provider.name,
        exceptionType: "provider_discovery_failed",
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  await completeRefreshRun(runId, providerFailures > 0 ? "failed" : "completed", {
    providers: providers.length,
    discovered_total: discoveredTotal,
    provider_failures: providerFailures
  });
}

export async function getRoutingRegistryByProvider(providers: LlmProvider[]): Promise<Map<LlmProvider["name"], RegistryRoutingModel[]>> {
  const client = getSupabaseAdminClient();
  const providerNames = providers.map((provider) => provider.name);

  if (!providerNames.length) {
    return new Map();
  }

  const { data, error } = await client
    .from("model_registry")
    .select(
      "provider_name,model_id,routing_eligibility,confidence_tier,confidence_score,supports_text,supports_vision,supports_web_search,supports_image_generation,supports_video,reasoning_tier,speed_tier,cost_tier"
    )
    .in("provider_name", providerNames)
    .eq("is_active", true)
    .returns<RegistryRoutingModel>();

  if (error) {
    throw new Error(`Failed loading model registry: ${error.message}`);
  }

  const grouped = new Map<LlmProvider["name"], RegistryRoutingModel[]>();
  for (const provider of providers) {
    grouped.set(provider.name, []);
  }

  for (const row of data ?? []) {
    const existing = grouped.get(row.provider_name) ?? [];
    existing.push(row);
    grouped.set(row.provider_name, existing);
  }

  return grouped;
}

export function snapshotToLookup(snapshot: Map<LlmProvider["name"], RegistryRoutingModel[]>) {
  const lookup = new Map<string, RegistryRoutingModel>();
  for (const [providerName, models] of snapshot.entries()) {
    for (const model of models) {
      lookup.set(`${providerName}:${normalizeModelId(model.model_id)}`, model);
    }
  }
  return lookup;
}

export function lookupRegistryModel(
  lookup: Map<string, RegistryRoutingModel> | undefined,
  providerName: LlmProvider["name"],
  modelId: string
): RegistryRoutingModel | undefined {
  if (!lookup) {
    return undefined;
  }

  return lookup.get(`${providerName}:${normalizeModelId(modelId)}`);
}

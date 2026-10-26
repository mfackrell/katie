import { isNonConversationalModel } from "./non-conversational";
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
  | "pricing_status"
  | "capability_status"
  | "pricing_input_per_1m"
  | "pricing_output_per_1m"
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
    supports_text: !supportsImage && !isNonConversationalModel(modelId),
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

// Retain independently verified pricing only while its official evidence is recent
// and the fresh catalog still agrees with BOTH billed token rates. Provider
// discovery cannot silently downgrade a trusted, identical price to "estimated".
type TrustedPricingSnapshot = Pick<ModelRegistryRecord,
  "normalized_model_id" | "pricing_status" | "pricing_input_per_1m" |
  "pricing_output_per_1m" | "pricing_verified_at" | "source_metadata">;
export function retainTrustedPricing(
  fresh: ReturnType<typeof enrichModelRecord>, prior: TrustedPricingSnapshot | undefined, nowIso: string
): ReturnType<typeof enrichModelRecord> {
  const source=prior?.source_metadata?.pricing_verification_source;
  const verifiedAt=Date.parse(prior?.pricing_verified_at ?? "");
  const now=Date.parse(nowIso);
  const age=now-verifiedAt;
  if(prior?.pricing_status!=="verified"||
     typeof source!=="string"||!/^https:\\/\\/[^\\s]+$/.test(source)||
     !Number.isFinite(age)||age<0||age>24*60*60*1000||
     fresh.pricing_status!=="estimated"||
     fresh.pricing_input_per_1m===null||fresh.pricing_output_per_1m===null||
     fresh.pricing_input_per_1m!==prior.pricing_input_per_1m||
     fresh.pricing_output_per_1m!==prior.pricing_output_per_1m)return fresh;
  return {...fresh,pricing_status:"verified",pricing_verified_at:prior.pricing_verified_at,
   source_metadata:{...fresh.source_metadata,
    pricing_verification_source:source,
    pricing_verification_date:prior.source_metadata.pricing_verification_date}};
}

/** A definitive 404 on a selected inference model must not be retried indefinitely.
 * The upstream catalog is not proof that the model can answer inference requests.
 * Transient errors (timeouts, 429, 5xx) never quarantine a model.
 */
export function isDefinitiveModelUnavailable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && (error as {status?:unknown}).status === 404);
}
export async function quarantineUnavailableModel(providerName: LlmProvider["name"], modelId: string, error: unknown): Promise<boolean> {
  if (!isDefinitiveModelUnavailable(error)) return false;
  const client = getSupabaseAdminClient();
  const {error: dbError} = await client.from("model_registry")
    .eq("provider_name",providerName).eq("normalized_model_id",normalizeModelId(modelId))
    .update({is_active:false, routing_eligibility:"disabled", failure_reason:"runtime_model_404", last_exception_at:new Date().toISOString()});
  if (dbError) throw new Error(dbError.message);
  console.warn("[ModelRegistry] model_quarantined", {provider:providerName,modelId,reason:"upstream_404"});
  return true;
}

export type ModelRefreshOutcome = {provider:LlmProvider["name"];ok:boolean;discovered:number;disabled:number;reason?:string};
export async function refreshModelRegistry(providers: LlmProvider[], options?: { verifyQuarantined?: boolean }): Promise<ModelRefreshOutcome[]> {
  const client = getSupabaseAdminClient();
  const nowIso = new Date().toISOString();
  const pricingCatalog = await fetchLiteLlmPricingCatalog();
  const outcomes: ModelRefreshOutcome[] = [];

  for (const provider of providers) {
    try {
      const discovered = await provider.listModels();
      // Preserve quarantines across discovery: listModels() can still advertise a
      // model that returns 404 for actual inference.
      const {data: quarantined, error: quarantineError} = await client.from("model_registry")
        .select("normalized_model_id,last_exception_at")
        .eq("provider_name", provider.name).eq("failure_reason","runtime_model_404")
        .eq("is_active",false)
        .returns<{normalized_model_id:string;last_exception_at:string|null}>();
      if(quarantineError) throw new Error(quarantineError.message);
      const quarantinedIds = new Set((quarantined ?? []).map(row=>row.normalized_model_id as string));
      const {data: verifiedPrices,error: verifiedPriceError}=await client.from("model_registry")
        .select("normalized_model_id,pricing_status,pricing_input_per_1m,pricing_output_per_1m,pricing_verified_at,source_metadata")
        .eq("provider_name",provider.name).eq("pricing_status","verified")
        .returns<TrustedPricingSnapshot[]>();
      if(verifiedPriceError)throw new Error(verifiedPriceError.message);
      const verifiedById=new Map((verifiedPrices??[]).map(row=>[row.normalized_model_id,row]));
      const rows = discovered.filter(modelId=>!quarantinedIds.has(normalizeModelId(modelId)))
        .map((modelId) => retainTrustedPricing(
          enrichModelRecord(provider.name,modelId,pricingCatalog,nowIso),
          verifiedById.get(normalizeModelId(modelId)),nowIso));

      const probeCandidate = (quarantined ?? []).find(row => discovered.some(id => normalizeModelId(id) === row.normalized_model_id)
        && (!row.last_exception_at || Date.now()-new Date(row.last_exception_at).getTime() >= 60*60*1000));
      if (options?.verifyQuarantined && probeCandidate) {
        const candidateId = discovered.find(id => normalizeModelId(id) === probeCandidate.normalized_model_id)!;
        try {
          // Verify the same native tool-calling capability Katie uses for self-inspection,
          // rather than merely testing ordinary text generation on a different endpoint.
          const result = provider.generateToolTurn
            ? await provider.generateToolTurn({
                modelId:candidateId, system:"Reply with OK.", messages:[{role:"user",text:"OK"}],
                tools:[{name:"ping",description:"Optional health verification",parameters:{type:"object",properties:{}}}],
                signal:AbortSignal.timeout(12000),
              })
            : await provider.generate({modelId:candidateId,name:"Model verification",persona:"Reply with OK only.",summary:"",history:[],user:"OK"});
          const valid = "response" in result
            ? Boolean(result.response.text?.trim() || result.calls.length)
            : Boolean(result.text?.trim());
          if (valid) {
            rows.push(enrichModelRecord(provider.name,candidateId,pricingCatalog,nowIso));
            console.info("[ModelRegistry] model_reverified",{provider:provider.name,modelId:candidateId});
          }
        } catch {
          await client.from("model_registry").eq("provider_name",provider.name)
            .eq("normalized_model_id",normalizeModelId(candidateId))
            .update({last_exception_at:nowIso});
          console.warn("[ModelRegistry] model_reverification_failed",{provider:provider.name,modelId:candidateId});
        }
      }
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
      outcomes.push({provider:provider.name,ok:true,discovered:discovered.length,disabled:toDisable.length});
    } catch (error) {
      console.error("[ModelRegistry] provider_discovery_failed", {
        provider: provider.name,
        error: error instanceof Error ? error.message : String(error)
      });
      outcomes.push({provider:provider.name,ok:false,discovered:0,disabled:0,reason:"discovery_failed"});
    }
  }
  return outcomes;
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
      "provider_name,model_id,pricing_status,capability_status,pricing_input_per_1m,pricing_output_per_1m,routing_eligibility,confidence_tier,confidence_score,supports_text,supports_vision,supports_web_search,supports_image_generation,supports_video,reasoning_tier,speed_tier,cost_tier"
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

import { isNonConversationalModel } from "./non-conversational";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import type { LlmProvider } from "@/lib/providers/types";
import { fetchOfficialModelEvidence, officialModelSpec, type PublishedModelEvidence } from "./provider-evidence";

export type RoutingEligibility = "verified" | "restricted" | "manual_override_only" | "disabled";
export type ConfidenceTier = "high" | "medium" | "low";

export type RegistryCapabilitySource = "provider" | "provider_documentation" | "pricing_catalog" | "heuristic" | "unknown";

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
  const reasoning = /o3|opus|sonnet|pro|codex|gpt-5|gpt-6/.test(m) ? "high" : /mini|flash|haiku/.test(m) ? "low" : "medium";
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

  if (input.capability_status === "verified" && input.pricing_status === "verified" && input.confidence_score >= 0.8) {
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
      ...(pricing ? { pricing_catalog_observed_at: nowIso } : {}),
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
    // A third-party catalog timestamp is not first-party price verification.
    pricing_verified_at: null,
    verification_updated_at: nowIso,
    failure_reason: pricing ? null : "missing_pricing",
    // Missing catalog metadata is not a provider exception.
    last_exception_at: null
  };
}

// Retain independently verified pricing only while its official evidence is recent
// and the fresh catalog still agrees with BOTH billed token rates. Provider
// discovery cannot silently downgrade a trusted, identical price to "estimated".
type TrustedPricingSnapshot = Pick<ModelRegistryRecord,
  "normalized_model_id" | "pricing_status" | "pricing_input_per_1m" |
  "pricing_output_per_1m" | "pricing_verified_at" | "source_metadata">;
type RefreshedModelRecord = Omit<ReturnType<typeof enrichModelRecord>,
  "pricing_status" | "capability_status" | "source_metadata" | "capability_verified_at" | "pricing_verified_at" |
  "supports_text" | "supports_vision" | "supports_web_search" | "supports_image_generation" |
  "supports_video" | "reasoning_tier" | "speed_tier" | "cost_tier"> &
  Pick<ModelRegistryRecord,
    "pricing_status" | "capability_status" | "source_metadata" | "capability_verified_at" | "pricing_verified_at" |
    "supports_text" | "supports_vision" | "supports_web_search" | "supports_image_generation" |
    "supports_video" | "reasoning_tier" | "speed_tier" | "cost_tier">;
export function retainTrustedPricing(
  fresh: RefreshedModelRecord, prior: TrustedPricingSnapshot | undefined, nowIso: string
): RefreshedModelRecord {
  const source=prior?.source_metadata?.pricing_verification_source;
  // Trusted model-specific first-party source only; never accept URL lookalikes.
  let officialSource=false;
  if(typeof source==="string" && fresh.provider_name==="openai"){
    try{
      const url=new URL(source);
      officialSource=url.origin==="https://developers.openai.com"&&
       url.pathname==="/api/docs/models/"+fresh.normalized_model_id&&
       !url.search&&!url.hash&&!url.username&&!url.password;
    }catch{officialSource=false}
  }
  const verifiedAt=Date.parse(prior?.pricing_verified_at ?? "");
  const now=Date.parse(nowIso);
  const age=now-verifiedAt;
  if(prior?.pricing_status!=="verified"||
     !officialSource||
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

type PriorPublishedSnapshot = TrustedPricingSnapshot & Pick<ModelRegistryRecord,
  "capability_status" | "capability_verified_at" | "supports_text" | "supports_vision" |
  "supports_web_search" | "supports_image_generation" | "supports_video" |
  "reasoning_tier" | "speed_tier" | "cost_tier">;

/** PostgREST may serialize PostgreSQL numeric rates as strings; reject non-decimal or nonfinite values. */
function verifiedNumericRate(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^(?:0|[1-9]\\d*)(?:\\.\\d+)?$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function freshOfficialEvidence(date: string | null | undefined, nowIso: string): boolean {
  const timestamp = Date.parse(date ?? "");
  const now = Date.parse(nowIso);
  return Number.isFinite(timestamp) && Number.isFinite(now) &&
    timestamp <= now && now - timestamp < 24 * 60 * 60 * 1000;
}

/**
 * Documentation proves published capabilities and base rates, never account permission,
 * live endpoint execution, task-quality superiority, or owner spending authorization.
 * Missing/failing source refresh preserves the evidence and ORIGINAL timestamp, but
 * expired evidence cannot remain fully eligible for strict protected routing.
 */
export function retainOfficialModelEvidence(
  fresh: RefreshedModelRecord,
  prior: PriorPublishedSnapshot | undefined,
  published: PublishedModelEvidence | null,
  nowIso: string
): RefreshedModelRecord {
  const spec = officialModelSpec(fresh.provider_name, fresh.model_id);
  if (!spec) return fresh;
  const row: RefreshedModelRecord = { ...fresh };
  const meta = prior?.source_metadata ?? {};
  const priorMatches = Boolean(
    prior?.normalized_model_id === fresh.normalized_model_id &&
    prior?.capability_status === "verified" &&
    meta.capability_evidence_basis === "first_party_model_documentation" &&
    meta.capability_verification_source === spec.documentUrl &&
    Number.isFinite(Date.parse(prior.capability_verified_at ?? ""))
  );

  if (priorMatches && prior) {
    row.capability_status = "verified";
    row.capability_verified_at = prior.capability_verified_at;
    row.supports_text = prior.supports_text;
    row.supports_vision = prior.supports_vision;
    row.supports_web_search = prior.supports_web_search;
    row.supports_image_generation = prior.supports_image_generation;
    row.supports_video = prior.supports_video;
    row.reasoning_tier = prior.reasoning_tier;
    row.speed_tier = prior.speed_tier;
    row.cost_tier = prior.cost_tier;
    row.source_metadata = { ...fresh.source_metadata, ...meta };
    if (prior.pricing_status === "verified" &&
        meta.pricing_verification_source === spec.documentUrl &&
        freshOfficialEvidence(prior.pricing_verified_at, nowIso) &&
        verifiedNumericRate(prior.pricing_input_per_1m) !== null &&
        verifiedNumericRate(prior.pricing_output_per_1m) !== null) {
      row.pricing_status = "verified";
      row.pricing_input_per_1m = verifiedNumericRate(prior.pricing_input_per_1m);
      row.pricing_output_per_1m = verifiedNumericRate(prior.pricing_output_per_1m);
      row.pricing_verified_at = prior.pricing_verified_at;
    } else {
      row.source_metadata = {
        ...row.source_metadata,
        previous_pricing_verified_at: prior.pricing_verified_at,
        pricing_revalidation_status: "requires_current_first_party_evidence"
      };
    }
  }

  if (published && published.documentUrl === spec.documentUrl &&
      published.documentedModelId === spec.modelId) {
    row.capability_status = "verified";
    row.capability_verified_at = nowIso;
    row.reasoning_tier = published.reasoningTier;
    row.supports_text = published.supportsText;
    row.supports_vision = published.supportsVision;
    row.supports_web_search = published.supportsWebSearch;
    row.supports_image_generation = false;
    row.supports_video = false;
    row.confidence_score = 0.95;
    row.source_metadata = {
      ...fresh.source_metadata,
      capability_source: "provider_documentation",
      capability_evidence_basis: "first_party_model_documentation",
      capability_verification_source: published.documentUrl,
      capability_verification_observed_at: nowIso,
      provider_documented_model_id: published.documentedModelId,
      supported_endpoints: published.supportedEndpoints,
      structured_output_documented: published.supportsStructuredOutput,
      tool_calling_documented: published.supportsToolCalling,
      context_window_tokens: published.contextWindowTokens,
      max_output_tokens: published.maxOutputTokens,
      pricing_tier: published.pricingTier,
      has_variable_long_context_rates: published.hasVariableLongContextRates,
      price_verified_scope: "published_base_standard_rates_only",
      published_base_input_per_1m: published.inputPer1m,
      published_base_output_per_1m: published.outputPer1m,
      // Documentation verification does not prove that a live request succeeds.
      inference_account_verified: false
    };
    if (published.pricingMatchesApprovedSchedule) {
      row.pricing_status = "verified";
      row.pricing_input_per_1m = published.inputPer1m;
      row.pricing_output_per_1m = published.outputPer1m;
      row.pricing_verified_at = nowIso;
      row.source_metadata = {
        ...row.source_metadata,
        pricing_source: "provider_documentation",
        pricing_verification_source: published.documentUrl,
        pricing_verification_observed_at: nowIso
      };
    } else {
      row.pricing_status = fresh.pricing_status;
      row.pricing_input_per_1m = fresh.pricing_input_per_1m;
      row.pricing_output_per_1m = fresh.pricing_output_per_1m;
      row.pricing_verified_at = null;
      row.source_metadata = {
        ...row.source_metadata,
        pricing_source: fresh.source_metadata.pricing_source,
        pricing_revalidation_status: "published_rates_changed_requires_review"
      };
    }
  }
  if (row.capability_status === "verified") {
    row.confidence_score = 0.95;
    row.confidence_tier = "high";
    const current = freshOfficialEvidence(row.capability_verified_at, nowIso) &&
      row.pricing_status === "verified" && freshOfficialEvidence(row.pricing_verified_at, nowIso);
    row.routing_eligibility = current ? "verified" : "restricted";
    row.failure_reason = current ? null : "verified_evidence_stale_or_pricing_unverified";
    row.source_metadata = {
      ...row.source_metadata,
      capability_evidence_current: freshOfficialEvidence(row.capability_verified_at, nowIso),
      pricing_evidence_current: row.pricing_status === "verified" &&
        freshOfficialEvidence(row.pricing_verified_at, nowIso),
      registry_evaluated_at: nowIso
    };
  }
  return row;
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
export async function refreshModelRegistry(providers: LlmProvider[], options?: { verifyPublishedSources?: boolean }): Promise<ModelRefreshOutcome[]> {
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
      // Read all prior evidence, not just recently verified pricing. Transient source
      // downtime must not erase an earlier independent capability verification.
      const { data: priorRows, error: priorError } = await client.from("model_registry")
        .select("normalized_model_id,pricing_status,capability_status,pricing_input_per_1m,pricing_output_per_1m,pricing_verified_at,capability_verified_at,source_metadata,supports_text,supports_vision,supports_web_search,supports_image_generation,supports_video,reasoning_tier,speed_tier,cost_tier")
        .eq("provider_name", provider.name)
        .returns<PriorPublishedSnapshot>();
      if (priorError) throw new Error(priorError.message);
      const priorById = new Map((priorRows ?? []).map((row) => [row.normalized_model_id, row]));
      const verifiedById = new Map((priorRows ?? [])
        .filter((row) => row.pricing_status === "verified")
        .map((row) => [row.normalized_model_id, row]));
      const publishedById = new Map<string, PublishedModelEvidence>();

      if (options?.verifyPublishedSources) {
        const candidates = discovered.filter((modelId) => {
          const normalized = normalizeModelId(modelId);
          const prior = priorById.get(normalized);
          const spec = officialModelSpec(provider.name, normalized);
          if (!spec || quarantinedIds.has(normalized)) return false;
          // Verify first-party model pages at most once in 20 hours for records
          // whose price and capability evidence is still current.
          const previous = Math.min(
            Date.parse(prior?.capability_verified_at ?? "") || 0,
            Date.parse(prior?.pricing_verified_at ?? "") || 0
          );
          const matchingSource = prior?.source_metadata?.capability_verification_source === spec.documentUrl &&
            prior?.source_metadata?.pricing_verification_source === spec.documentUrl;
          return !matchingSource || !Number.isFinite(previous) ||
            Date.now() - previous >= 20 * 60 * 60 * 1000;
        });
        await Promise.all(candidates.map(async (modelId) => {
          const normalized = normalizeModelId(modelId);
          const spec = officialModelSpec(provider.name, normalized);
          if (!spec) return;
          try {
            const evidence = await fetchOfficialModelEvidence(spec, normalized);
            if (evidence) publishedById.set(normalized, evidence);
            else console.warn("[ModelRegistry] published_model_evidence_not_qualified", {
              provider: provider.name, modelId: normalized
            });
          } catch (error) {
            console.warn("[ModelRegistry] official_documentation_unavailable", {
              provider: provider.name, modelId: normalized,
              reason: error instanceof Error ? error.name : "fetch_failure"
            });
          }
        }));
      }
      const rows = discovered.filter((modelId) => !quarantinedIds.has(normalizeModelId(modelId)))
        .map((modelId) => {
          const normalized = normalizeModelId(modelId);
          return retainOfficialModelEvidence(
            retainTrustedPricing(enrichModelRecord(provider.name, modelId, pricingCatalog, nowIso),
              verifiedById.get(normalized), nowIso),
            priorById.get(normalized),
            publishedById.get(normalized) ?? null,
            nowIso
          );
        });

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

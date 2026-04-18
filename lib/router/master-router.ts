import {
  buildCandidateMetadata,
  buildRoutingPreferenceProfile,
  chooseRoutingWithLLM,
  CandidateScoreBreakdown,
  filterCandidatesForIntent,
  inferRequestClassification,
  inferRequestIntent,
  LlmRoutingResult,
  RequestIntent,
  scoreModelCandidateWithBreakdown,
  scoreModelsForIntent,
  validateRoutingDecision
} from "@/lib/router/model-intent";
import { isBlockedRoutingModel } from "@/lib/router/routing-model-filters";
import { isControlPlaneInstructionCompatibleModel } from "@/lib/router/control-plane-compat";
import { evaluatePolicyRouting, getPolicyConfig } from "@/lib/router/policy-engine";
import { LlmProvider } from "@/lib/providers/types";
import {
  getRoutingRegistryByProvider,
  refreshModelRegistry,
  snapshotToLookup,
  type RegistryRoutingModel
} from "@/lib/models/registry";
import type { ActorRoutingProfile } from "@/lib/types/chat";

export type RoutingDecision = {
  provider: LlmProvider;
  modelId: string;
  fallbackChain: Array<{ provider: LlmProvider; modelId: string; score: number }>;
  reasoning: string;
  routerModel: string;
  resolvedIntent: ResolvedRoutingIntent;
  explainer?: SelectionExplainer;
};
export type ResolvedRoutingIntent = {
  intent: RequestIntent;
  preferredProvider: LlmProvider["name"] | null;
  intentSource: "upstream" | "router-fallback";
};
export type SelectionExplainer = {
  selected_model?: string;
  selected_provider?: string;
  intent?: { label?: string; confidence?: number | null };
  summary?: string;
  preference_profile_applied?: string;
  top_factors?: Array<{ label: string; detail?: string; delta?: number | null }>;
  top_candidates?: Array<{ model?: string; provider?: string; score?: number | null; why_not_selected?: string }> | null;
  selected_source?: "llm-primary" | "deterministic-fallback";
  top_candidate_score?: number | null;
  hard_rule_applied?: string | null;
  fallback_used?: boolean;
  fallback_reason?: string | null;
  override?: { applied?: boolean; reason?: string | null } | null;
  actor_routing?: {
    actor_id?: string | null;
    applied?: boolean;
    summary?: string;
    adjustments?: Array<{ model?: string; provider?: string; delta?: number }>;
  } | null;
};
type RoutingTrace = {
  request_id: string;
  timestamp: string;
  intent: {
    value: Awaited<ReturnType<typeof inferRequestIntent>>;
    confidence: number | null;
    source: ResolvedRoutingIntent["intentSource"];
  };
  prompt_features: {
    prompt_length: number;
    has_images: boolean;
    has_video_input: boolean;
    has_context: boolean;
    context_length: number;
  };
  actor_routing: {
    actor_id: string | null;
    applied: boolean;
    profile: ActorRoutingProfile | null;
  };
  candidates: Array<{
    provider: string;
    model_id: string;
    base_score: number | null;
    adjustments: Array<{ label: string; delta: number }>;
    final_score: number;
    excluded: boolean;
    exclusion_reason: string | null;
  }>;
  selection: {
    ranked_candidates: Array<{ provider: string; model_id: string; score: number }>;
    top_ranked: { provider: string; model_id: string; score: number } | null;
    selected_model: { provider: string; model_id: string };
    llm_primary_used: boolean;
    deterministic_fallback_used: boolean;
    override_happened: boolean;
    override_reason: string | null;
    llm_preference_profile: ReturnType<typeof buildRoutingPreferenceProfile>;
    llm_candidates: Array<ReturnType<typeof buildCandidateMetadata>>;
  };
  policy: {
    router_version: string | null;
    scoring_policy_version: string | null;
  };
};

const CONTROL_PLANE_PROVIDER_PRIORITY: LlmProvider["name"][] = ["google", "openai", "anthropic", "grok"];

const CONTROL_PLANE_CURATED_MODELS: Record<LlmProvider["name"], string[]> = {
  google: ["gemini-3.1-pro", "gemini-3.1-pro-latest", "gemini-3-pro"],
  openai: ["gpt-5.3-codex", "gpt-5.2-unified", "gpt-5.2", "o3-pro"],
  anthropic: ["claude-4.6-opus", "claude-4.5-sonnet", "claude-4-opus"],
  grok: ["grok-4-0709", "grok-4"]
};
const CONTROL_PLANE_BLOCKED_MODELS: Record<LlmProvider["name"], string[]> = {
  google: ["gemini-2.0-flash"],
  openai: [],
  anthropic: [],
  grok: []
};
function isEligibleControlPlaneModel(
  providerName: LlmProvider["name"],
  modelId: string,
  registryLookup?: Map<string, RegistryRoutingModel>
): boolean {
  const metadata = buildCandidateMetadata(providerName, modelId, "general-text", { registryLookup });
  return metadata.supports_text && !metadata.supports_image_generation && isControlPlaneInstructionCompatibleModel(providerName, modelId);
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function isBlockedControlPlaneModel(providerName: LlmProvider["name"], modelId: string): boolean {
  const normalized = normalizeModelId(modelId);
  return CONTROL_PLANE_BLOCKED_MODELS[providerName].some((blocked) => normalizeModelId(blocked) === normalized);
}

function selectControlPlaneDecisionModelForProvider(
  providerName: LlmProvider["name"],
  models: string[],
  registryLookup?: Map<string, RegistryRoutingModel>,
  routingRequestId = "unknown"
): { modelId: string | null; skipped: string[] } {
  const skipped: string[] = [];
  const normalizedToModel = new Map<string, string>();
  for (const modelId of models) {
    if (isBlockedControlPlaneModel(providerName, modelId)) {
      skipped.push(`${providerName}:${modelId}:blocked`);
      continue;
    }
    if (!isControlPlaneInstructionCompatibleModel(providerName, modelId)) {
      skipped.push(`${providerName}:${modelId}:incompatible_instruction_mode`);
      continue;
    }
    if (!isEligibleControlPlaneModel(providerName, modelId, registryLookup)) {
      skipped.push(`${providerName}:${modelId}:ineligible`);
      continue;
    }
    normalizedToModel.set(normalizeModelId(modelId), modelId);
  }

  for (const curatedModelId of CONTROL_PLANE_CURATED_MODELS[providerName]) {
    const selected = normalizedToModel.get(normalizeModelId(curatedModelId));
    if (selected) {
      return { modelId: selected, skipped };
    }
  }

  if (normalizedToModel.size > 0) {
    const rankedCuratedFallback = [...normalizedToModel.values()]
      .map((modelId) => ({
        modelId,
        score: scoreModelCandidateWithBreakdown(providerName, modelId, "social-emotional", { registryLookup }).finalScore
      }))
      .sort((a, b) => b.score - a.score || a.modelId.localeCompare(b.modelId));
    const selected = rankedCuratedFallback[0]?.modelId ?? null;
    console.warn(
      `[ControlPlane] requestId=${routingRequestId} provider=${providerName} selected_non_curated_fallback=${selected ?? "none"}`
    );
    return { modelId: selected, skipped };
  }

  return { modelId: null, skipped };
}

export function selectControlPlaneDecisionModels(
  modelEntries: Array<{ provider: LlmProvider; models: string[] }>,
  registryLookup?: Map<string, RegistryRoutingModel>,
  routingRequestId = "unknown"
): Array<{ provider: LlmProvider; modelId: string }> {
  const entriesByProvider = new Map(modelEntries.map((entry) => [entry.provider.name, entry]));
  const selectedProviders: Array<{ provider: LlmProvider; modelId: string }> = [];

  for (const providerName of CONTROL_PLANE_PROVIDER_PRIORITY) {
    const providerEntry = entriesByProvider.get(providerName);
    if (!providerEntry) {
      continue;
    }

    const selection = selectControlPlaneDecisionModelForProvider(providerName, providerEntry.models, registryLookup, routingRequestId);
    if (selection.skipped.length) {
      console.info(`[ControlPlane] requestId=${routingRequestId} skipped=${selection.skipped.join(",")}`);
    }
    if (!selection.modelId) {
      if (providerName === "google") {
        console.info(
          `[ControlPlane] requestId=${routingRequestId} provider=google status=excluded reason=no_verified_control_plane_instruction_compatible_model`
        );
      }
      console.info(`[ControlPlane] requestId=${routingRequestId} provider=${providerName} status=no_eligible_decision_model`);
      continue;
    }

    selectedProviders.push({ provider: providerEntry.provider, modelId: selection.modelId });
  }

  return selectedProviders;
}

function topRoutingCandidates(
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  intent: Awaited<ReturnType<typeof inferRequestIntent>>,
  preferredProvider: LlmProvider["name"] | null,
  registryLookup?: Map<string, RegistryRoutingModel>,
  actorRoutingProfile?: ActorRoutingProfile
): string {
  return scoreModelsForIntent(availableByProvider, intent, { registryLookup, preferredProvider, actorRoutingProfile })
    .slice(0, 3)
    .map(({ provider, modelId, score }) => `${provider.name}:${modelId}(${score})`)
    .join(", ");
}

function logRoutingDecision(
  intent: Awaited<ReturnType<typeof inferRequestIntent>>,
  intentSource: ResolvedRoutingIntent["intentSource"],
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  preferredProvider: LlmProvider["name"] | null,
  selectedProviderName: string,
  selectedModelId: string,
  registryLookup?: Map<string, RegistryRoutingModel>,
  actorRoutingProfile?: ActorRoutingProfile
): void {
  const candidates = topRoutingCandidates(availableByProvider, intent, preferredProvider, registryLookup, actorRoutingProfile) || "none";
  console.info(`[Router] intent=${intent} intent_source=${intentSource} top_candidates=${candidates} selected=${selectedProviderName}:${selectedModelId}`);
}

function logFullRanking(
  requestId: string,
  intent: Awaited<ReturnType<typeof inferRequestIntent>>,
  rankedCandidates: Array<{ provider: LlmProvider; modelId: string; score: number }>
): void {
  const ranking = rankedCandidates.map((candidate) => ({
    provider: candidate.provider.name,
    model: candidate.modelId,
    score: candidate.score
  }));
  console.info(`[Router RANKING] ${JSON.stringify({ requestId, intent, ranking })}`);
}

function logRoutingCandidatePool(
  requestId: string,
  intent: Awaited<ReturnType<typeof inferRequestIntent>>,
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>
): void {
  const providers = availableByProvider.map(({ provider, models }) => ({
    provider: provider.name,
    modelCount: models.length,
    sampleModels: models.slice(0, 5)
  }));
  console.info(`[Router CANDIDATE_POOL] ${JSON.stringify({ requestId, intent, providers })}`);
}

function isRoutingTraceEnabled(perRequestOverride?: boolean): boolean {
  if (perRequestOverride === true) {
    return true;
  }

  return process.env.ROUTER_TRACE_ENABLED === "true";
}

function createCandidateBreakdown(
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  intent: Awaited<ReturnType<typeof inferRequestIntent>>,
  registryLookup?: Map<string, RegistryRoutingModel>,
  actorRoutingProfile?: ActorRoutingProfile
): CandidateScoreBreakdown[] {
  return availableByProvider.flatMap(({ provider, models }) =>
    models.map((modelId) => scoreModelCandidateWithBreakdown(provider.name, modelId, intent, { registryLookup, actorRoutingProfile }))
  );
}

function buildRoutingTrace({
  requestId,
  timestamp,
  intent,
  intentSource,
  prompt,
  preferredProvider,
  hasImages,
  hasVideoInput,
  context,
  availableByProvider,
  selectedProviderName,
  selectedModelId,
  overrideReason,
  llmPrimaryUsed,
  deterministicFallbackUsed,
  llmPreferenceProfile,
  llmCandidates,
  registryLookup,
  actorId,
  actorRoutingProfile
}: {
  requestId: string;
  timestamp: string;
  intent: Awaited<ReturnType<typeof inferRequestIntent>>;
  intentSource: ResolvedRoutingIntent["intentSource"];
  prompt: string;
  preferredProvider: "openai" | "google" | "grok" | "anthropic" | null;
  hasImages: boolean;
  hasVideoInput: boolean;
  context: string;
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>;
  selectedProviderName: string;
  selectedModelId: string;
  overrideReason: string | null;
  llmPrimaryUsed: boolean;
  deterministicFallbackUsed: boolean;
  llmPreferenceProfile: ReturnType<typeof buildRoutingPreferenceProfile>;
  llmCandidates: Array<ReturnType<typeof buildCandidateMetadata>>;
  registryLookup?: Map<string, RegistryRoutingModel>;
  actorId: string | null;
  actorRoutingProfile?: ActorRoutingProfile;
}): RoutingTrace {
  const scoredCandidates = scoreModelsForIntent(availableByProvider, intent, {
    registryLookup,
    preferredProvider,
    actorRoutingProfile
  }).map(({ provider, modelId, score }) => ({
    provider: provider.name,
    model_id: modelId,
    score
  }));

  return {
    request_id: requestId,
    timestamp,
    intent: {
      value: intent,
      confidence: null,
      source: intentSource
    },
    prompt_features: {
      prompt_length: prompt.length,
      has_images: hasImages,
      has_video_input: hasVideoInput,
      has_context: Boolean(context),
      context_length: context.length
    },
    candidates: createCandidateBreakdown(availableByProvider, intent, registryLookup, actorRoutingProfile).map((candidate) => ({
      provider: candidate.providerName,
      model_id: candidate.modelId,
      base_score: candidate.baseScore,
      adjustments: candidate.adjustments,
      final_score: candidate.finalScore,
      excluded: candidate.excluded,
      exclusion_reason: candidate.exclusionReason
    })),
    selection: {
      ranked_candidates: scoredCandidates,
      top_ranked: scoredCandidates[0] ?? null,
      selected_model: {
        provider: selectedProviderName,
        model_id: selectedModelId
      },
      llm_primary_used: llmPrimaryUsed,
      deterministic_fallback_used: deterministicFallbackUsed,
      override_happened: Boolean(overrideReason),
      override_reason: overrideReason,
      llm_preference_profile: llmPreferenceProfile,
      llm_candidates: llmCandidates
    },
    actor_routing: {
      actor_id: actorId,
      applied: Boolean(actorRoutingProfile),
      profile: actorRoutingProfile ?? null
    },
    policy: {
      router_version: process.env.ROUTER_POLICY_VERSION ?? null,
      scoring_policy_version: process.env.ROUTER_SCORING_POLICY_VERSION ?? null
    }
  };
}

function logRoutingTrace(trace: RoutingTrace): void {
  console.info(`[RouterTrace] ${JSON.stringify(trace)}`);
}


function logPolicyTrace(trace: unknown): void {
  console.info(`[RouterPolicyTrace] ${JSON.stringify(trace)}`);
}

function buildSelectionExplainer({
  selectedProviderName,
  selectedModelId,
  intent,
  availableByProvider,
  rankedCandidates,
  llmCandidates,
  selectedSource,
  hardRouteRule,
  fallbackUsed,
  fallbackReason,
  preferenceProfile,
  overrideReason,
  summary,
  registryLookup,
  actorId,
  actorRoutingProfile
}: {
  selectedProviderName: string;
  selectedModelId: string;
  intent: Awaited<ReturnType<typeof inferRequestIntent>>;
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>;
  rankedCandidates: Array<{ provider: LlmProvider; modelId: string; score: number }>;
  llmCandidates: Array<ReturnType<typeof buildCandidateMetadata>>;
  selectedSource: "llm-primary" | "deterministic-fallback";
  hardRouteRule: string;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  preferenceProfile: ReturnType<typeof buildRoutingPreferenceProfile>;
  overrideReason: string | null;
  summary: string;
  registryLookup?: Map<string, RegistryRoutingModel>;
  actorId: string | null;
  actorRoutingProfile?: ActorRoutingProfile;
}): SelectionExplainer {
  const scoredCandidates = rankedCandidates.map(({ provider, modelId, score }) => ({
    model: `${provider.name}:${modelId}`,
    provider: provider.name,
    score
  }));
  const selectedKey = `${selectedProviderName}:${selectedModelId}`;
  const selectedScore = scoredCandidates.find((candidate) => candidate.model === selectedKey)?.score ?? null;
  const selectedCandidateMetadata =
    llmCandidates.find((candidate) => candidate.providerName === selectedProviderName && candidate.modelId === selectedModelId) ?? null;
  const topCandidates = scoredCandidates
    .filter((candidate) => candidate.model !== selectedKey)
    .slice(0, 3)
    .map((candidate) => {
      const candidateMetadata =
        llmCandidates.find(
          (llmCandidate) => `${llmCandidate.providerName}:${llmCandidate.modelId}` === candidate.model
        ) ?? null;
      const candidateDelta = selectedScore === null ? null : Number((selectedScore - candidate.score).toFixed(2));
      const whyNotSelected =
        candidateDelta !== null && candidateDelta > 0
          ? `Strong option, but trailed the selected model by ${candidateDelta.toFixed(2)} routing points.`
          : "Valid option, but selected model aligned better with current intent and preferences.";
      return {
        model: candidate.model.split(":")[1] ?? candidate.model,
        provider: candidate.provider,
        score: candidate.score,
        why_not_selected: candidateMetadata?.score_breakdown?.excluded
          ? "Candidate was de-prioritized by routing constraints."
          : whyNotSelected
      };
    });
  const selectedBreakdown =
    createCandidateBreakdown(availableByProvider, intent, registryLookup, actorRoutingProfile).find(
      (candidate) => candidate.providerName === selectedProviderName && candidate.modelId === selectedModelId
    ) ?? null;
  const actorAdjustments = createCandidateBreakdown(availableByProvider, intent, registryLookup, actorRoutingProfile)
    .flatMap((candidate) => {
      const actorAdjustment = candidate.adjustments.find((adjustment) => adjustment.label === "actor_routing_bias");
      if (!actorAdjustment || actorAdjustment.delta === 0) {
        return [];
      }
      return [{
        model: candidate.modelId,
        provider: candidate.providerName,
        delta: actorAdjustment.delta
      }];
    })
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 5);
  const topFactors: NonNullable<SelectionExplainer["top_factors"]> =
    selectedBreakdown?.adjustments
      .filter((factor) => factor.delta !== 0)
      .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
      .slice(0, 5)
      .map((factor) => ({
        label: factor.label.replaceAll("_", " "),
        detail:
          factor.delta > 0
            ? "Improved selection confidence for this request."
            : "Tradeoff accepted to better match higher-priority constraints.",
        delta: factor.delta
      })) ?? [];

  if (selectedCandidateMetadata?.specialization_tags?.length) {
    topFactors.unshift({
      label: "specialization match",
      detail: `Matched tags: ${selectedCandidateMetadata.specialization_tags.slice(0, 2).join(", ")}.`,
      delta: null
    });
  }

  const compactFactors = topFactors.slice(0, 5);
  const preferenceSummary = preferenceProfile.quality_over_cost_for.includes(intent)
    ? "Quality favored over cost for this task type."
    : "Balanced speed, cost, and quality preferences.";
  const hardRuleApplied = hardRouteRule !== "none" ? hardRouteRule : null;
  const sourceSummary =
    selectedSource === "llm-primary"
      ? "Chosen by routing LLM after comparing valid candidates."
      : "Deterministic fallback used due to routing validation failure.";

  return {
    selected_model: selectedModelId,
    selected_provider: selectedProviderName,
    intent: {
      label: intent,
      confidence: null
    },
    summary: `${summary} ${sourceSummary}`,
    preference_profile_applied: preferenceSummary,
    top_factors: compactFactors,
    top_candidates: topCandidates,
    selected_source: selectedSource,
    top_candidate_score: selectedScore,
    hard_rule_applied: hardRuleApplied,
    fallback_used: fallbackUsed,
    fallback_reason: fallbackReason,
    override: {
      applied: Boolean(overrideReason),
      reason: overrideReason
    },
    actor_routing: actorRoutingProfile
      ? {
          actor_id: actorId,
          applied: true,
          summary: actorRoutingProfile.summary,
          adjustments: actorAdjustments
        }
      : null
  };
}

function pickDefaultModel(provider: LlmProvider, models: string[]): string {
  if (provider.name === "google") {
    return (
      models.find((model) => model === "gemini-3.1-pro") ??
      models.find((model) => model.includes("gemini-3.1-pro")) ??
      models[0] ??
      "gemini-3.1-pro"
    );
  }

  if (provider.name === "grok") {
    return models.find((model) => model.includes("grok-2-1212")) ?? models[0] ?? "grok-2-1212";
  }

  if (provider.name === "anthropic") {
    return (
      models.find((model) => model.includes("claude-4.5-sonnet")) ??
      models.find((model) => model.includes("claude")) ??
      models[0] ??
      "claude-4.5-sonnet"
    );
  }

  return models.find((model) => model.includes("gpt-5.2")) ?? models[0] ?? "gpt-5.2";
}

type Selection = { provider: LlmProvider; modelId: string; reasoning: string; routerModel: string; summary: string; overrideReason: string | null };

function buildFallbackChain({
  scoredCandidates,
  selectedProviderName,
  selectedModelId,
  availableByProvider,
  intent,
  registryLookup,
  actorRoutingProfile
}: {
  scoredCandidates: Array<{ provider: LlmProvider; modelId: string; score: number }>;
  selectedProviderName: string;
  selectedModelId: string;
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>;
  intent: Awaited<ReturnType<typeof inferRequestIntent>>;
  registryLookup?: Map<string, RegistryRoutingModel>;
  actorRoutingProfile?: ActorRoutingProfile;
}): Array<{ provider: LlmProvider; modelId: string; score: number }> {
  const usedKeys = new Set<string>([`${selectedProviderName}:${selectedModelId}`]);
  const fallbackChain: Array<{ provider: LlmProvider; modelId: string; score: number }> = [];

  for (const candidate of scoredCandidates) {
    const validated = validateRoutingDecision(
      { providerName: candidate.provider.name, modelId: candidate.modelId },
      availableByProvider,
      intent,
      { registryLookup, actorRoutingProfile }
    );
    const key = `${validated.provider.name}:${validated.modelId}`;

    if (usedKeys.has(key)) {
      continue;
    }

    usedKeys.add(key);
    fallbackChain.push({
      provider: validated.provider,
      modelId: validated.modelId,
      score: candidate.score
    });

    if (fallbackChain.length >= 5) {
      break;
    }
  }

  return fallbackChain;
}

export async function chooseProvider(
  prompt: string,
  context: string,
  providers: LlmProvider[],
  options?: {
    hasImages?: boolean;
    hasVideoInput?: boolean;
    routingTraceEnabled?: boolean;
    routingRequestId?: string;
    resolvedIntent?: ResolvedRoutingIntent;
    requestIntent?: RequestIntent;
    modelRegistrySnapshot?: Map<LlmProvider["name"], RegistryRoutingModel[]>;
    actorId?: string;
    actorRoutingProfile?: ActorRoutingProfile;
  }
): Promise<RoutingDecision> {
  let rankedCandidates: Array<{ provider: LlmProvider; modelId: string; score: number }> = [];
  let llmPrimaryUsed = false;
  let deterministicFallbackUsed = false;
  let fallbackReason: string | null = null;
  let llmCandidatesUsed: Array<ReturnType<typeof buildCandidateMetadata>> = [];
  const preferenceProfile = buildRoutingPreferenceProfile();

  const traceEnabled = isRoutingTraceEnabled(options?.routingTraceEnabled);
  const traceRequestId = options?.routingRequestId ?? crypto.randomUUID();
  const traceTimestamp = new Date().toISOString();
  const policyConfig = getPolicyConfig();
  let registrySnapshot = options?.modelRegistrySnapshot;

  if (!registrySnapshot) {
    try {
      await refreshModelRegistry(providers);
      registrySnapshot = await getRoutingRegistryByProvider(providers);
      console.info(`[ModelRegistry] requestId=${traceRequestId} snapshot_loaded=true`);
    } catch (error) {
      console.warn(`[ModelRegistry] requestId=${traceRequestId} snapshot_load_failed`, error);
    }
  }

  const registryLookup = registrySnapshot ? snapshotToLookup(registrySnapshot) : undefined;

  const modelEntries = await Promise.all(providers.map(async (provider) => {
    if (registrySnapshot?.get(provider.name)?.length) {
      const eligibleModels = (registrySnapshot.get(provider.name) ?? [])
        .filter((record) => record.routing_eligibility !== "disabled" && record.routing_eligibility !== "manual_override_only")
        .map((record) => record.model_id);
      const restrictedForTextOnly = (registrySnapshot.get(provider.name) ?? [])
        .filter((record) => record.routing_eligibility === "restricted")
        .map((record) => record.model_id);
      console.info(
        `[ModelRegistry] requestId=${traceRequestId} provider=${provider.name} eligible=${eligibleModels.length} restricted=${restrictedForTextOnly.length}`
      );
      return { provider, models: eligibleModels.filter(() => !isBlockedRoutingModel()) };
    }

    const fallbackModels = (await provider.listModels()).filter(() => !isBlockedRoutingModel());
    console.warn(`[ModelRegistry] requestId=${traceRequestId} provider=${provider.name} using_provider_fallback=true count=${fallbackModels.length}`);
    return { provider, models: fallbackModels };
  }));

  const controlPlaneDecisionProviders = selectControlPlaneDecisionModels(modelEntries, registryLookup, traceRequestId);
  console.info(
    `[ControlPlane] decision_models=${controlPlaneDecisionProviders.map((entry) => `${entry.provider.name}:${entry.modelId}`).join(",") || "none"}`
  );

  const upstreamResolvedIntent = options?.resolvedIntent ?? (options?.requestIntent
    ? { intent: options.requestIntent, preferredProvider: null, intentSource: "upstream" as const }
    : null);

  const requestClassification = upstreamResolvedIntent
    ? null
    : await inferRequestClassification(
        prompt,
        {
          hasImages: Boolean(options?.hasImages),
          hasVideoInput: Boolean(options?.hasVideoInput)
        },
        {
          decisionProviders: controlPlaneDecisionProviders,
          registryLookup
        }
      );
  const resolvedIntent: ResolvedRoutingIntent = upstreamResolvedIntent ?? {
    intent: requestClassification?.intent ?? "general-text",
    preferredProvider: requestClassification?.preferredProvider ?? null,
    intentSource: "router-fallback"
  };
  console.info(
    `[Route Intent] caller_request_intent=${options?.requestIntent ?? options?.resolvedIntent?.intent ?? "none"} classifier_intent=${requestClassification?.intent ?? "skipped"} effective_intent=${resolvedIntent.intent} intent_source=${resolvedIntent.intentSource}`
  );
  console.info(`[Route Intent Resolved] ${JSON.stringify(resolvedIntent)}`);
  const intent = resolvedIntent.intent;
  const requestedPreferredProvider = resolvedIntent.preferredProvider;
  const actorRoutingProfile = options?.actorRoutingProfile;

  let availableByProvider = modelEntries.map(({ provider, models }) => ({
    provider,
    models: models.length ? models : [pickDefaultModel(provider, [])]
  }));
  const candidateCountBeforeFilter = availableByProvider.reduce((total, entry) => total + entry.models.length, 0);

  console.info(`[Route Policy] requestId=${traceRequestId} intent=${intent} hasVideoInput=${Boolean(options?.hasVideoInput)}`);
  let hardRouteRule = "none";

  if (options?.hasVideoInput) {
    availableByProvider = availableByProvider.filter(({ provider }) => provider.name === "google");
    hardRouteRule = "video-input-google-only";
  }

  availableByProvider = filterCandidatesForIntent(availableByProvider, intent, {
    hasVideoInput: Boolean(options?.hasVideoInput),
    registryLookup
  });

  const candidateProviders = Array.from(new Set(availableByProvider.map(({ provider }) => provider.name))).sort();
  let effectivePreferredProvider = requestedPreferredProvider;
  if (requestedPreferredProvider) {
    console.info(
      `[Provider Preference] requestId=${traceRequestId} detected=true preferred_provider=${requestedPreferredProvider} source=${resolvedIntent.intentSource}`
    );
    if (!candidateProviders.includes(requestedPreferredProvider)) {
      effectivePreferredProvider = null;
      console.info(
        `[Provider Preference] requestId=${traceRequestId} action=cleared original=${requestedPreferredProvider} reason=no_final_generation_candidates remaining_providers=${candidateProviders.join(",") || "none"}`
      );
    } else {
      console.info(
        `[Provider Preference] requestId=${traceRequestId} action=retained preferred_provider=${requestedPreferredProvider} in_final_candidate_pool=true`
      );
    }
  } else {
    console.info(`[Provider Preference] requestId=${traceRequestId} detected=false`);
  }
  const resolvedIntentForSelection: ResolvedRoutingIntent = {
    ...resolvedIntent,
    preferredProvider: effectivePreferredProvider
  };

  console.info(`[Capability Filter] requestId=${traceRequestId} candidates=${availableByProvider.reduce((total, entry) => total + entry.models.length, 0)}`);
  logRoutingCandidatePool(traceRequestId, intent, availableByProvider);

  rankedCandidates = scoreModelsForIntent(availableByProvider, intent, {
    registryLookup,
    preferredProvider: effectivePreferredProvider,
    actorRoutingProfile
  });
  const unbiasedTopCandidate = actorRoutingProfile
    ? scoreModelsForIntent(availableByProvider, intent, { registryLookup, preferredProvider: effectivePreferredProvider })[0]
    : null;
  if (actorRoutingProfile) {
    console.info(
      `[Actor Routing Bias] actor_id=${options?.actorId ?? "unknown"} applied=true biased_top=${rankedCandidates[0]?.provider.name ?? "none"}:${rankedCandidates[0]?.modelId ?? "none"} unbiased_top=${unbiasedTopCandidate?.provider.name ?? "none"}:${unbiasedTopCandidate?.modelId ?? "none"} changed_winner=${Boolean(unbiasedTopCandidate && rankedCandidates[0] && (unbiasedTopCandidate.provider.name !== rankedCandidates[0].provider.name || unbiasedTopCandidate.modelId !== rankedCandidates[0].modelId))}`
    );
  }
  console.info(
    `[Router Candidate Hygiene] requestId=${traceRequestId} before=${candidateCountBeforeFilter} after=${rankedCandidates.length}`
  );

  const applyPolicyGuardrail = (selection: Selection): RoutingDecision => {
    const fallbackChain = buildFallbackChain({
      scoredCandidates: rankedCandidates,
      selectedProviderName: selection.provider.name,
      selectedModelId: selection.modelId,
      availableByProvider,
      intent,
      registryLookup,
      actorRoutingProfile
    });

    if (!policyConfig.enabled) {
      return {
        provider: selection.provider,
        modelId: selection.modelId,
        fallbackChain,
        reasoning: selection.reasoning,
        routerModel: selection.routerModel,
        resolvedIntent: resolvedIntentForSelection,
        explainer: buildSelectionExplainer({
          selectedProviderName: selection.provider.name,
          selectedModelId: selection.modelId,
          intent,
          availableByProvider,
          rankedCandidates,
          llmCandidates: llmCandidatesUsed,
          selectedSource: llmPrimaryUsed ? "llm-primary" : "deterministic-fallback",
          hardRouteRule,
          fallbackUsed: deterministicFallbackUsed,
          fallbackReason,
          preferenceProfile,
          overrideReason: selection.overrideReason,
          summary: selection.summary,
          registryLookup,
          actorId: options?.actorId ?? null,
          actorRoutingProfile
        })
      };
    }

    const evaluation = evaluatePolicyRouting({
      prompt,
      context,
      availableByProvider,
      traceId: traceRequestId,
      currentSelection: { providerName: selection.provider.name, modelId: selection.modelId },
      resolvedIntent: intent,
      registryLookup
    });

    logPolicyTrace(evaluation.trace);

    if (!evaluation.selected || policyConfig.shadowMode) {
      return {
        provider: selection.provider,
        modelId: selection.modelId,
        fallbackChain,
        reasoning: `${selection.reasoning} Policy guardrail did not enforce reroute.`,
        routerModel: selection.routerModel,
        resolvedIntent: resolvedIntentForSelection,
        explainer: buildSelectionExplainer({
          selectedProviderName: selection.provider.name,
          selectedModelId: selection.modelId,
          intent,
          availableByProvider,
          rankedCandidates,
          llmCandidates: llmCandidatesUsed,
          selectedSource: llmPrimaryUsed ? "llm-primary" : "deterministic-fallback",
          hardRouteRule,
          fallbackUsed: deterministicFallbackUsed,
          fallbackReason,
          preferenceProfile,
          overrideReason: selection.overrideReason,
          summary: selection.summary,
          registryLookup,
          actorId: options?.actorId ?? null,
          actorRoutingProfile
        })
      };
    }

    console.info(`[Policy Guardrail] enforced=${evaluation.selected.provider.name}:${evaluation.selected.modelId}`);
    console.info(
      `[Routing Final] requestId=${traceRequestId} policy_guardrail_changed_selection=true from=${selection.provider.name}:${selection.modelId} to=${evaluation.selected.provider.name}:${evaluation.selected.modelId}`
    );
    return {
      provider: evaluation.selected.provider,
      modelId: evaluation.selected.modelId,
      fallbackChain,
      reasoning: `${selection.reasoning} Policy guardrail enforced hard constraint selection.`,
      routerModel: selection.routerModel,
      resolvedIntent: resolvedIntentForSelection,
      explainer: buildSelectionExplainer({
        selectedProviderName: evaluation.selected.provider.name,
        selectedModelId: evaluation.selected.modelId,
        intent,
        availableByProvider,
        rankedCandidates,
        llmCandidates: llmCandidatesUsed,
        selectedSource: llmPrimaryUsed ? "llm-primary" : "deterministic-fallback",
        hardRouteRule,
        fallbackUsed: deterministicFallbackUsed,
        fallbackReason,
        preferenceProfile,
        overrideReason: `policy_guardrail:${evaluation.trace.selection_summary}`,
        summary: `${selection.summary} Policy guardrail enforced hard constraints.`,
        registryLookup,
        actorId: options?.actorId ?? null,
        actorRoutingProfile
      })
    };
  };

  const fallbackToDeterministic = (reason: string): Selection => {
    deterministicFallbackUsed = true;
    fallbackReason = reason;
    const topCandidate = rankedCandidates[0];
    const provider = topCandidate?.provider ?? availableByProvider[0]?.provider ?? providers[0];
    const modelId = topCandidate?.modelId ?? pickDefaultModel(provider, availableByProvider.find((entry) => entry.provider.name === provider.name)?.models ?? []);
    const validated = validateRoutingDecision({ providerName: provider.name, modelId }, availableByProvider, intent, {
      registryLookup,
      actorRoutingProfile
    });
    console.info(`[Routing Fallback] reason=${reason} selected=${validated.provider.name}:${validated.modelId}`);
    return {
      provider: validated.provider,
      modelId: validated.modelId,
      reasoning: `Deterministic fallback selected ${validated.provider.name}:${validated.modelId}. ${validated.reasoning}`,
      routerModel: validated.modelId,
      summary: "Deterministic fallback path.",
      overrideReason: validated.changed ? `validation_adjustment:${validated.reasoning}` : null
    };
  };

  let selected: Selection;

  if (!rankedCandidates.length) {
    selected = fallbackToDeterministic("no_ranked_candidates");
  } else {
    llmCandidatesUsed = rankedCandidates.map((candidate) => {
      const metadata = buildCandidateMetadata(candidate.provider.name, candidate.modelId, intent, { registryLookup });
      const breakdown = scoreModelCandidateWithBreakdown(candidate.provider.name, candidate.modelId, intent, {
        registryLookup,
        actorRoutingProfile
      });
      return {
        ...metadata,
        score_breakdown: {
          base_score: breakdown.baseScore,
          final_score: breakdown.finalScore,
          excluded: breakdown.excluded,
          exclusion_reason: breakdown.exclusionReason,
          adjustments: breakdown.adjustments
        }
      };
    });
    console.info(`[LLM Router Preferences] ${JSON.stringify({ requestId: traceRequestId, intent, preferenceProfile })}`);
    console.info(
      `[LLM Router Candidates] ${JSON.stringify({ requestId: traceRequestId, count: llmCandidatesUsed.length, candidates: llmCandidatesUsed })}`
    );
    if (intent === "social-emotional") {
      const geminiCandidates = llmCandidatesUsed.filter((candidate) => candidate.providerName === "google");
      const geminiGeneralBonusesApplied = geminiCandidates.reduce(
        (total, candidate) =>
          total +
          (candidate.score_breakdown?.adjustments.filter((adjustment) => adjustment.label === "gemini_general_reasoning_bonus")
            .length ?? 0),
        0
      );
      console.info(
        `[Social Emotional Routing] ${JSON.stringify({
          requestId: traceRequestId,
          intent,
          preference: "quality_over_cost",
          gemini_general_reasoning_bonus_suppressed: geminiGeneralBonusesApplied === 0
        })}`
      );
      const speedFirstCandidate = rankedCandidates.find(
        (candidate) => /mini|haiku|flash/i.test(candidate.modelId)
      );
      const nuancedTopCandidate = rankedCandidates[0];
      if (
        speedFirstCandidate &&
        nuancedTopCandidate &&
        `${speedFirstCandidate.provider.name}:${speedFirstCandidate.modelId}` !==
          `${nuancedTopCandidate.provider.name}:${nuancedTopCandidate.modelId}`
      ) {
        console.info(
          `[Social Emotional Routing] requestId=${traceRequestId} nuance_model_outranked_speed_first winner=${nuancedTopCandidate.provider.name}:${nuancedTopCandidate.modelId} speed_first=${speedFirstCandidate.provider.name}:${speedFirstCandidate.modelId}`
        );
      }
    }

    const llmRouting: LlmRoutingResult = await chooseRoutingWithLLM({
      prompt,
      intent,
      modalityFlags: {
        has_images: Boolean(options?.hasImages),
        has_video_input: Boolean(options?.hasVideoInput)
      },
      hardRouteContext: {
        hard_rule_applied: hardRouteRule !== "none",
        rule: hardRouteRule
      },
      preferenceProfile,
      candidates: llmCandidatesUsed,
      decisionProviders: controlPlaneDecisionProviders,
      registryLookup
    });
    console.info(`[LLM Router] requestId=${traceRequestId} output_accepted=${llmRouting.accepted}`);

    if (!llmRouting.accepted) {
      selected = fallbackToDeterministic(`llm_router_rejected:${llmRouting.reason}`);
    } else {
      llmPrimaryUsed = true;
      const providerLookup = new Map(availableByProvider.map(({ provider }) => [provider.name, provider]));
      rankedCandidates = llmRouting.ranking
        .map((candidate) => {
          const provider = providerLookup.get(candidate.providerName);
          if (!provider) {
            return null;
          }
          return { provider, modelId: candidate.modelId, score: candidate.score };
        })
        .filter((candidate): candidate is { provider: LlmProvider; modelId: string; score: number } => Boolean(candidate));

      const selectedProvider = providerLookup.get(llmRouting.selected.providerName);
      if (!selectedProvider) {
        selected = fallbackToDeterministic("llm_router_provider_missing");
      } else {
        const validated = validateRoutingDecision(
          { providerName: llmRouting.selected.providerName, modelId: llmRouting.selected.modelId },
          availableByProvider,
          intent,
          { registryLookup, actorRoutingProfile }
        );
        if (validated.changed) {
          console.warn(`[Routing Validation] rejected_llm_selection=${llmRouting.selected.providerName}:${llmRouting.selected.modelId}`);
          selected = fallbackToDeterministic("llm_router_selection_invalid_after_validation");
        } else {
          console.info(`[LLM Router] selected=${validated.provider.name}:${validated.modelId}`);
          selected = {
            provider: validated.provider,
            modelId: validated.modelId,
            reasoning: `LLM-primary routing selected ${validated.provider.name}:${validated.modelId}.`,
            routerModel: validated.modelId,
            summary: "LLM-primary routing path.",
            overrideReason: null
          };
        }
      }
    }
  }

  if (effectivePreferredProvider && selected.provider.name !== effectivePreferredProvider) {
    const preferredCandidate = rankedCandidates.find((candidate) => candidate.provider.name === effectivePreferredProvider);
    if (preferredCandidate) {
      const validatedPreferred = validateRoutingDecision(
        { providerName: preferredCandidate.provider.name, modelId: preferredCandidate.modelId },
        availableByProvider,
        intent,
        { registryLookup, actorRoutingProfile }
      );
      console.info(
        `[Provider Preference] requestId=${traceRequestId} action=enforced preferred_provider=${effectivePreferredProvider} selected=${validatedPreferred.provider.name}:${validatedPreferred.modelId} replaced=${selected.provider.name}:${selected.modelId}`
      );
      selected = {
        provider: validatedPreferred.provider,
        modelId: validatedPreferred.modelId,
        reasoning: `${selected.reasoning} Explicit provider preference enforced final selection.`,
        routerModel: selected.routerModel,
        summary: `${selected.summary} Explicit provider preference honored.`,
        overrideReason: "explicit_provider_preference"
      };
    }
  }

  logFullRanking(traceRequestId, intent, rankedCandidates);
  logRoutingDecision(
    intent,
    resolvedIntent.intentSource,
    availableByProvider,
    effectivePreferredProvider,
    selected.provider.name,
    selected.modelId,
    registryLookup,
    actorRoutingProfile
  );
  console.info(
    `[Routing Final] requestId=${traceRequestId} selected=${selected.provider.name}:${selected.modelId} source=${llmPrimaryUsed ? "llm-primary" : "deterministic-fallback"} fallback_reason=${fallbackReason ?? "none"} post_selection_fallback=${deterministicFallbackUsed}`
  );

  if (traceEnabled) {
    logRoutingTrace(
      buildRoutingTrace({
        requestId: traceRequestId,
        timestamp: traceTimestamp,
        intent,
        intentSource: resolvedIntent.intentSource,
        prompt,
        preferredProvider: effectivePreferredProvider,
        hasImages: Boolean(options?.hasImages),
        hasVideoInput: Boolean(options?.hasVideoInput),
        context,
        availableByProvider,
        selectedProviderName: selected.provider.name,
        selectedModelId: selected.modelId,
        overrideReason: selected.overrideReason,
        llmPrimaryUsed,
        deterministicFallbackUsed,
        llmPreferenceProfile: preferenceProfile,
        llmCandidates: llmCandidatesUsed,
        registryLookup,
        actorId: options?.actorId ?? null,
        actorRoutingProfile
      })
    );
  }

  return applyPolicyGuardrail(selected);
}

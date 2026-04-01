import {
  buildCandidateMetadata,
  buildRoutingPreferenceProfile,
  chooseRoutingWithLLM,
  CandidateScoreBreakdown,
  filterCandidatesForIntent,
  inferRequestIntent,
  LlmRoutingResult,
  RequestIntent,
  scoreModelCandidateWithBreakdown,
  scoreModelsForIntent,
  validateRoutingDecision
} from "@/lib/router/model-intent";
import { isBlockedRoutingModel } from "@/lib/router/routing-model-filters";
import { evaluatePolicyRouting, getPolicyConfig } from "@/lib/router/policy-engine";
import { LlmProvider } from "@/lib/providers/types";

export type RoutingDecision = {
  provider: LlmProvider;
  modelId: string;
  fallbackChain: Array<{ provider: LlmProvider; modelId: string; score: number }>;
  reasoning: string;
  routerModel: string;
  explainer?: SelectionExplainer;
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
};
type RoutingTrace = {
  request_id: string;
  timestamp: string;
  intent: { value: Awaited<ReturnType<typeof inferRequestIntent>>; confidence: number | null };
  prompt_features: {
    prompt_length: number;
    has_images: boolean;
    has_video_input: boolean;
    has_context: boolean;
    context_length: number;
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
    llm_candidates: Array<Awaited<ReturnType<typeof buildCandidateMetadata>>>;
  };
  policy: {
    router_version: string | null;
    scoring_policy_version: string | null;
  };
};

function topRoutingCandidates(
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  intent: Awaited<ReturnType<typeof inferRequestIntent>>,
  prompt: string
): string {
  return scoreModelsForIntent(availableByProvider, intent, prompt)
    .slice(0, 3)
    .map(({ provider, modelId, score }) => `${provider.name}:${modelId}(${score})`)
    .join(", ");
}

function logRoutingDecision(
  intent: Awaited<ReturnType<typeof inferRequestIntent>>,
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  prompt: string,
  selectedProviderName: string,
  selectedModelId: string
): void {
  const candidates = topRoutingCandidates(availableByProvider, intent, prompt) || "none";
  console.info(`[Router] intent=${intent} top_candidates=${candidates} selected=${selectedProviderName}:${selectedModelId}`);
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
  intent: Awaited<ReturnType<typeof inferRequestIntent>>
): CandidateScoreBreakdown[] {
  return availableByProvider.flatMap(({ provider, models }) =>
    models.map((modelId) => scoreModelCandidateWithBreakdown(provider.name, modelId, intent))
  );
}

function buildRoutingTrace({
  requestId,
  timestamp,
  intent,
  prompt,
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
  llmCandidates
}: {
  requestId: string;
  timestamp: string;
  intent: Awaited<ReturnType<typeof inferRequestIntent>>;
  prompt: string;
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
  llmCandidates: Array<Awaited<ReturnType<typeof buildCandidateMetadata>>>;
}): RoutingTrace {
  const scoredCandidates = scoreModelsForIntent(availableByProvider, intent, prompt).map(({ provider, modelId, score }) => ({
    provider: provider.name,
    model_id: modelId,
    score
  }));

  return {
    request_id: requestId,
    timestamp,
    intent: {
      value: intent,
      confidence: null
    },
    prompt_features: {
      prompt_length: prompt.length,
      has_images: hasImages,
      has_video_input: hasVideoInput,
      has_context: Boolean(context),
      context_length: context.length
    },
    candidates: createCandidateBreakdown(availableByProvider, intent).map((candidate) => ({
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
  summary
}: {
  selectedProviderName: string;
  selectedModelId: string;
  intent: Awaited<ReturnType<typeof inferRequestIntent>>;
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>;
  rankedCandidates: Array<{ provider: LlmProvider; modelId: string; score: number }>;
  llmCandidates: Array<Awaited<ReturnType<typeof buildCandidateMetadata>>>;
  selectedSource: "llm-primary" | "deterministic-fallback";
  hardRouteRule: string;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  preferenceProfile: ReturnType<typeof buildRoutingPreferenceProfile>;
  overrideReason: string | null;
  summary: string;
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
    createCandidateBreakdown(availableByProvider, intent).find(
      (candidate) => candidate.providerName === selectedProviderName && candidate.modelId === selectedModelId
    ) ?? null;
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
    }
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
  intent
}: {
  scoredCandidates: Array<{ provider: LlmProvider; modelId: string; score: number }>;
  selectedProviderName: string;
  selectedModelId: string;
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>;
  intent: Awaited<ReturnType<typeof inferRequestIntent>>;
}): Array<{ provider: LlmProvider; modelId: string; score: number }> {
  const usedKeys = new Set<string>([`${selectedProviderName}:${selectedModelId}`]);
  const fallbackChain: Array<{ provider: LlmProvider; modelId: string; score: number }> = [];

  for (const candidate of scoredCandidates) {
    const validated = validateRoutingDecision(
      { providerName: candidate.provider.name, modelId: candidate.modelId },
      availableByProvider,
      intent
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
    requestIntent?: RequestIntent;
  }
): Promise<RoutingDecision> {
  let rankedCandidates: Array<{ provider: LlmProvider; modelId: string; score: number }> = [];
  let llmPrimaryUsed = false;
  let deterministicFallbackUsed = false;
  let fallbackReason: string | null = null;
  let llmCandidatesUsed: Array<Awaited<ReturnType<typeof buildCandidateMetadata>>> = [];
  const preferenceProfile = buildRoutingPreferenceProfile();

  const intent = options?.requestIntent ?? (await inferRequestIntent(prompt, {
    hasImages: Boolean(options?.hasImages),
    hasVideoInput: Boolean(options?.hasVideoInput)
  }));
  const traceEnabled = isRoutingTraceEnabled(options?.routingTraceEnabled);
  const traceRequestId = options?.routingRequestId ?? crypto.randomUUID();
  const traceTimestamp = new Date().toISOString();
  const policyConfig = getPolicyConfig();

  const modelEntries = await Promise.all(
    providers.map(async (provider) => ({
      provider,
      models: (await provider.listModels()).filter(() => !isBlockedRoutingModel())
    }))
  );

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
    hasVideoInput: Boolean(options?.hasVideoInput)
  });

  console.info(`[Capability Filter] requestId=${traceRequestId} candidates=${availableByProvider.reduce((total, entry) => total + entry.models.length, 0)}`);
  logRoutingCandidatePool(traceRequestId, intent, availableByProvider);

  rankedCandidates = scoreModelsForIntent(availableByProvider, intent, prompt);
  console.info(
    `[Router Candidate Hygiene] requestId=${traceRequestId} before=${candidateCountBeforeFilter} after=${rankedCandidates.length}`
  );

  const applyPolicyGuardrail = (selection: Selection): RoutingDecision => {
    const fallbackChain = buildFallbackChain({
      scoredCandidates: rankedCandidates,
      selectedProviderName: selection.provider.name,
      selectedModelId: selection.modelId,
      availableByProvider,
      intent
    });

    if (!policyConfig.enabled) {
      return {
        provider: selection.provider,
        modelId: selection.modelId,
        fallbackChain,
        reasoning: selection.reasoning,
        routerModel: selection.routerModel,
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
          summary: selection.summary
        })
      };
    }

    const evaluation = evaluatePolicyRouting({
      prompt,
      context,
      availableByProvider,
      traceId: traceRequestId,
      currentSelection: { providerName: selection.provider.name, modelId: selection.modelId },
      resolvedIntent: intent
    });

    logPolicyTrace(evaluation.trace);

    if (!evaluation.selected || policyConfig.shadowMode) {
      return {
        provider: selection.provider,
        modelId: selection.modelId,
        fallbackChain,
        reasoning: `${selection.reasoning} Policy guardrail did not enforce reroute.`,
        routerModel: selection.routerModel,
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
          summary: selection.summary
        })
      };
    }

    console.info(`[Policy Guardrail] enforced=${evaluation.selected.provider.name}:${evaluation.selected.modelId}`);
    return {
      provider: evaluation.selected.provider,
      modelId: evaluation.selected.modelId,
      fallbackChain,
      reasoning: `${selection.reasoning} Policy guardrail enforced hard constraint selection.`,
      routerModel: selection.routerModel,
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
        summary: `${selection.summary} Policy guardrail enforced hard constraints.`
      })
    };
  };

  const fallbackToDeterministic = (reason: string): Selection => {
    deterministicFallbackUsed = true;
    fallbackReason = reason;
    const topCandidate = rankedCandidates[0];
    const provider = topCandidate?.provider ?? availableByProvider[0]?.provider ?? providers[0];
    const modelId = topCandidate?.modelId ?? pickDefaultModel(provider, availableByProvider.find((entry) => entry.provider.name === provider.name)?.models ?? []);
    const validated = validateRoutingDecision({ providerName: provider.name, modelId }, availableByProvider, intent);
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
    llmCandidatesUsed = await Promise.all(
      rankedCandidates.map(async (candidate) => {
        const metadata = await buildCandidateMetadata(candidate.provider.name, candidate.modelId, intent);
        const breakdown = scoreModelCandidateWithBreakdown(candidate.provider.name, candidate.modelId, intent);
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
      })
    );
    console.info(`[LLM Router Preferences] ${JSON.stringify({ requestId: traceRequestId, intent, preferenceProfile })}`);
    console.info(
      `[LLM Router Candidates] ${JSON.stringify({ requestId: traceRequestId, count: llmCandidatesUsed.length, candidates: llmCandidatesUsed })}`
    );

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
      candidates: llmCandidatesUsed
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
          intent
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

  logFullRanking(traceRequestId, intent, rankedCandidates);
  logRoutingDecision(intent, availableByProvider, prompt, selected.provider.name, selected.modelId);
  console.info(
    `[Routing Final] requestId=${traceRequestId} source=${llmPrimaryUsed ? "llm-primary" : "deterministic-fallback"} fallback_reason=${fallbackReason ?? "none"}`
  );

  if (traceEnabled) {
    logRoutingTrace(
      buildRoutingTrace({
        requestId: traceRequestId,
        timestamp: traceTimestamp,
        intent,
        prompt,
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
        llmCandidates: llmCandidatesUsed
      })
    );
  }

  return applyPolicyGuardrail(selected);
}

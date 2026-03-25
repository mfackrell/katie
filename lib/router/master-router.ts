import {
  CandidateScoreBreakdown,
  inferRequestIntent,
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
  intent?: { label?: string; confidence?: number | null };
  summary?: string;
  factors?: Array<{ label: string; delta?: number | null }>;
  top_candidate_score?: number | null;
  runner_up?: { model?: string; score?: number | null } | null;
  override?: { applied?: boolean; reason?: string | null } | null;
};
type RoutingTrace = {
  request_id: string;
  timestamp: string;
  intent: { value: ReturnType<typeof inferRequestIntent>; confidence: number | null };
  prompt_features: {
    prompt_length: number;
    has_images: boolean;
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
    override_happened: boolean;
    override_reason: string | null;
  };
  policy: {
    router_version: string | null;
    scoring_policy_version: string | null;
  };
};

function topRoutingCandidates(
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  intent: ReturnType<typeof inferRequestIntent>
): string {
  return scoreModelsForIntent(availableByProvider, intent)
    .slice(0, 3)
    .map(({ provider, modelId, score }) => `${provider.name}:${modelId}(${score})`)
    .join(", ");
}

function logRoutingDecision(
  intent: ReturnType<typeof inferRequestIntent>,
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  selectedProviderName: string,
  selectedModelId: string
): void {
  const candidates = topRoutingCandidates(availableByProvider, intent) || "none";
  console.info(`[Router] intent=${intent} top_candidates=${candidates} selected=${selectedProviderName}:${selectedModelId}`);
}

function isRoutingTraceEnabled(perRequestOverride?: boolean): boolean {
  if (perRequestOverride === true) {
    return true;
  }

  return process.env.ROUTER_TRACE_ENABLED === "true";
}

function createCandidateBreakdown(
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  intent: ReturnType<typeof inferRequestIntent>
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
  context,
  availableByProvider,
  selectedProviderName,
  selectedModelId,
  overrideReason
}: {
  requestId: string;
  timestamp: string;
  intent: ReturnType<typeof inferRequestIntent>;
  prompt: string;
  hasImages: boolean;
  context: string;
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>;
  selectedProviderName: string;
  selectedModelId: string;
  overrideReason: string | null;
}): RoutingTrace {
  const scoredCandidates = scoreModelsForIntent(availableByProvider, intent).map(({ provider, modelId, score }) => ({
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
      override_happened: Boolean(overrideReason),
      override_reason: overrideReason
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
  overrideReason,
  summary
}: {
  selectedProviderName: string;
  selectedModelId: string;
  intent: ReturnType<typeof inferRequestIntent>;
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>;
  overrideReason: string | null;
  summary: string;
}): SelectionExplainer {
  const scoredCandidates = scoreModelsForIntent(availableByProvider, intent).map(({ provider, modelId, score }) => ({
    model: `${provider.name}:${modelId}`,
    score
  }));
  const selectedKey = `${selectedProviderName}:${selectedModelId}`;
  const selectedScore = scoredCandidates.find((candidate) => candidate.model === selectedKey)?.score ?? null;
  const runnerUp = scoredCandidates.find((candidate) => candidate.model !== selectedKey) ?? null;
  const selectedBreakdown =
    createCandidateBreakdown(availableByProvider, intent).find(
      (candidate) => candidate.providerName === selectedProviderName && candidate.modelId === selectedModelId
    ) ?? null;
  const factors =
    selectedBreakdown?.adjustments
      .filter((factor) => factor.delta !== 0)
      .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
      .slice(0, 4)
      .map((factor) => ({ label: factor.label, delta: factor.delta })) ?? [];

  return {
    selected_model: selectedKey,
    intent: {
      label: intent,
      confidence: null
    },
    summary,
    factors,
    top_candidate_score: selectedScore,
    runner_up: runnerUp
      ? {
          model: runnerUp.model,
          score: runnerUp.score
        }
      : null,
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
  intent: ReturnType<typeof inferRequestIntent>;
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
  options?: { hasImages?: boolean; routingTraceEnabled?: boolean; routingRequestId?: string; requestIntent?: RequestIntent }
): Promise<RoutingDecision> {
  let rankedCandidates: Array<{ provider: LlmProvider; modelId: string; score: number }> = [];

  const applyPolicyIfEnabled = (base: Selection, availableByProvider: Array<{ provider: LlmProvider; models: string[] }>): RoutingDecision => {
    const fallbackChain = buildFallbackChain({
      scoredCandidates: rankedCandidates.filter(
        (candidate) => !(candidate.provider.name === base.provider.name && candidate.modelId === base.modelId)
      ),
      selectedProviderName: base.provider.name,
      selectedModelId: base.modelId,
      availableByProvider,
      intent
    });

    if (!policyConfig.enabled) {
      return {
        provider: base.provider,
        modelId: base.modelId,
        fallbackChain,
        reasoning: base.reasoning,
        routerModel: base.routerModel,
        explainer: buildSelectionExplainer({
          selectedProviderName: base.provider.name,
          selectedModelId: base.modelId,
          intent,
          availableByProvider,
          overrideReason: base.overrideReason,
          summary: base.summary
        })
      };
    }

    const evaluation = evaluatePolicyRouting({
      prompt,
      context,
      availableByProvider,
      traceId: traceRequestId,
      currentSelection: { providerName: base.provider.name, modelId: base.modelId }
    });

    logPolicyTrace(evaluation.trace);

    if (policyConfig.shadowMode || !evaluation.selected) {
      return {
        provider: base.provider,
        modelId: base.modelId,
        fallbackChain,
        reasoning: `${base.reasoning} Policy engine ${policyConfig.shadowMode ? "shadow" : "fallback"} mode kept live selection.`,
        routerModel: base.routerModel,
        explainer: buildSelectionExplainer({
          selectedProviderName: base.provider.name,
          selectedModelId: base.modelId,
          intent,
          availableByProvider,
          overrideReason: base.overrideReason,
          summary: `${base.summary} Policy mode=${evaluation.trace.mode}.`
        })
      };
    }

    return {
      provider: evaluation.selected.provider,
      modelId: evaluation.selected.modelId,
      fallbackChain: buildFallbackChain({
        scoredCandidates: rankedCandidates,
        selectedProviderName: evaluation.selected.provider.name,
        selectedModelId: evaluation.selected.modelId,
        availableByProvider,
        intent
      }),
      reasoning: `${base.reasoning} Policy engine enforced selection ${evaluation.selected.provider.name}:${evaluation.selected.modelId}.`,
      routerModel: base.routerModel,
      explainer: buildSelectionExplainer({
        selectedProviderName: evaluation.selected.provider.name,
        selectedModelId: evaluation.selected.modelId,
        intent,
        availableByProvider,
        overrideReason: `policy_enforced:${evaluation.trace.selection_summary}`,
        summary: `${base.summary} Policy mode=${evaluation.trace.mode}.`
      })
    };
  };

  const modelEntries = await Promise.all(
    providers.map(async (provider) => ({
      provider,
      models: (await provider.listModels()).filter(() => !isBlockedRoutingModel())
    }))
  );

  const availableByProvider = modelEntries.map(({ provider, models }) => ({
    provider,
    models: models.length ? models : [pickDefaultModel(provider, [])]
  }));

  const intent = options?.requestIntent ?? inferRequestIntent(prompt, Boolean(options?.hasImages));
  if (options?.requestIntent) {
    console.info(`[Router] using provided intent=${intent}`);
  }
  const traceEnabled = isRoutingTraceEnabled(options?.routingTraceEnabled);
  const traceRequestId = options?.routingRequestId ?? crypto.randomUUID();
  const traceTimestamp = new Date().toISOString();
  const policyConfig = getPolicyConfig();
  rankedCandidates = scoreModelsForIntent(availableByProvider, intent);

  if (availableByProvider.length === 1) {
    const selected = availableByProvider[0];
    const modelId = pickDefaultModel(selected.provider, selected.models);
    const validated = validateRoutingDecision({ providerName: selected.provider.name, modelId }, availableByProvider, intent);
    logRoutingDecision(intent, availableByProvider, validated.provider.name, validated.modelId);
    if (traceEnabled) {
      const overrideReason = validated.changed ? validated.reasoning : null;
      logRoutingTrace(
        buildRoutingTrace({
          requestId: traceRequestId,
          timestamp: traceTimestamp,
          intent,
          prompt,
          hasImages: Boolean(options?.hasImages),
          context,
          availableByProvider,
          selectedProviderName: validated.provider.name,
          selectedModelId: validated.modelId,
          overrideReason
        })
      );
    }
    return applyPolicyIfEnabled({
      provider: validated.provider,
      modelId: validated.modelId,
      reasoning: `Single provider available. ${validated.reasoning}` ,
      routerModel: modelId,
      summary: "Single provider path.",
      overrideReason: validated.changed ? validated.reasoning : null
    }, availableByProvider);
  }

  const topCandidate = rankedCandidates[0];
  const initialProvider = topCandidate?.provider ?? availableByProvider[0].provider;
  const initialModelId = topCandidate?.modelId ?? pickDefaultModel(initialProvider, availableByProvider[0].models);
  const validated = validateRoutingDecision({ providerName: initialProvider.name, modelId: initialModelId }, availableByProvider, intent);
  logRoutingDecision(intent, availableByProvider, validated.provider.name, validated.modelId);
  if (traceEnabled) {
    const overrideReason = validated.changed ? `validation_adjustment: ${validated.reasoning}` : null;
    logRoutingTrace(
      buildRoutingTrace({
        requestId: traceRequestId,
        timestamp: traceTimestamp,
        intent,
        prompt,
        hasImages: Boolean(options?.hasImages),
        context,
        availableByProvider,
        selectedProviderName: validated.provider.name,
        selectedModelId: validated.modelId,
        overrideReason
      })
    );
  }

  return applyPolicyIfEnabled({
    provider: validated.provider,
    modelId: validated.modelId,
    reasoning: `Score-ranked routing selected ${validated.provider.name}:${validated.modelId}. ${validated.reasoning}`,
    routerModel: validated.modelId,
    summary: "Ranked scoring path.",
    overrideReason: validated.changed ? `validation_adjustment: ${validated.reasoning}` : null
  }, availableByProvider);
}

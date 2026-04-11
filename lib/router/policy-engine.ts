import { RequestIntent } from "@/lib/router/model-intent";
import { LlmProvider } from "@/lib/providers/types";

export type PolicyIntentLabel =
  | "conversation_reflection"
  | "explanation_meta"
  | "implementation_code"
  | "debug_diagnosis"
  | "architecture_design"
  | "research_synthesis"
  | "creative_brainstorm"
  | "personal_relational"
  | "quick_factual"
  | "vision"
  | "image_generation";

type ComplexityLevel = "low" | "medium" | "high";

type PolicyConfig = {
  enabled: boolean;
  shadowMode: boolean;
  fallbackOnMissingMetadata: boolean;
  hard_cap_usd_per_request: number;
  max_cost_multiplier_vs_cheapest: number;
  max_latency_ms_by_intent: Partial<Record<PolicyIntentLabel, number>>;
  min_quality_tier_by_intent: Partial<Record<PolicyIntentLabel, number>>;
};

export type PolicyTrace = {
  trace_id: string;
  intent: { label: PolicyIntentLabel; confidence: number; source: "resolved-router-intent" };
  complexity: ComplexityLevel;
  candidates: Array<{
    model: string;
    quality_score: number;
    latency_score: number;
    cost_score: number;
    estimated_cost_usd: number;
    policy: { eligible: boolean; flags: string[]; reasons: string[] };
    final_score: number;
  }>;
  selected_model: string;
  selection_summary: string;
  mode: "shadow" | "enforced";
  would_have_selected?: string;
};

export type PolicyEvaluationResult = {
  selected: { provider: LlmProvider; modelId: string } | null;
  trace: PolicyTrace;
  metadataMissing: boolean;
};

type ModelProfile = { quality: number; latency: number; inCost: number; outCost: number };

const DEFAULT_MODEL_PROFILE: ModelProfile = { quality: 3, latency: 2400, inCost: 3, outCost: 12 };

function resolveModelProfile(modelId: string): ModelProfile {
  const lower = modelId.toLowerCase();
  if (lower.includes("flash") || lower.includes("haiku") || lower.includes("mini")) return { quality: 3, latency: 1200, inCost: 1, outCost: 3 };
  if (lower.includes("opus") || lower.includes("o3") || lower.includes("codex")) return { quality: 5, latency: 3800, inCost: 8, outCost: 24 };
  if (lower.includes("sonnet") || lower.includes("gpt-5") || lower.includes("gemini-3.1-pro")) return { quality: 4, latency: 2800, inCost: 4, outCost: 16 };
  return DEFAULT_MODEL_PROFILE;
}

function mapRouterIntentToPolicyIntent(intent: RequestIntent): PolicyIntentLabel {
  switch (intent) {
    case "assistant-reflection":
      return "conversation_reflection";
    case "architecture-review":
      return "architecture_design";
    case "code-review":
      return "debug_diagnosis";
    case "technical-debugging":
      return "debug_diagnosis";
    case "code-generation":
      return "implementation_code";
    case "web-search":
    case "news-summary":
      return "research_synthesis";
    case "image-generation":
      return "image_generation";
    case "vision-analysis":
    case "multimodal-reasoning":
    case "safety-sensitive-vision":
      return "vision";
    case "rewrite":
      return "creative_brainstorm";
    case "emotional-analysis":
      return "personal_relational";
    case "text":
    case "general-text":
    default:
      return "quick_factual";
  }
}

function estimateComplexity(prompt: string): ComplexityLevel {
  if (prompt.length > 1200 || /architecture|tradeoff|distributed|multi-step/i.test(prompt)) return "high";
  if (prompt.length < 220) return "low";
  return "medium";
}

function estimateTokens(input: string): { inTokens: number; outTokens: number } {
  const inTokens = Math.max(1, Math.ceil(input.length / 4));
  return { inTokens, outTokens: Math.max(80, Math.ceil(inTokens * 0.8)) };
}

export function getPolicyConfig(): PolicyConfig {
  return {
    enabled: process.env.ROUTER_POLICY_ENGINE_ENABLED === "true",
    shadowMode: process.env.ROUTER_POLICY_SHADOW_MODE === "true",
    fallbackOnMissingMetadata: process.env.ROUTER_POLICY_FALLBACK_ON_MISSING_METADATA !== "false",
    hard_cap_usd_per_request: Number(process.env.ROUTER_POLICY_HARD_CAP_USD_PER_REQUEST ?? 0.12),
    max_cost_multiplier_vs_cheapest: Number(process.env.ROUTER_POLICY_MAX_COST_MULTIPLIER_VS_CHEAPEST ?? 3),
    max_latency_ms_by_intent: { quick_factual: 3000 },
    min_quality_tier_by_intent: { architecture_design: 3, debug_diagnosis: 3, vision: 3 }
  };
}

export function evaluatePolicyRouting(args: {
  prompt: string;
  context: string;
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>;
  traceId: string;
  userTier?: string;
  currentSelection: { providerName: string; modelId: string };
  resolvedIntent: RequestIntent;
}): PolicyEvaluationResult {
  void args.context;
  void args.userTier;
  const config = getPolicyConfig();
  const intentLabel = mapRouterIntentToPolicyIntent(args.resolvedIntent);
  const complexity = estimateComplexity(args.prompt);

  const candidates = args.availableByProvider.flatMap(({ provider, models }) =>
    models.map((modelId) => {
      const profile = resolveModelProfile(modelId);
      const tokenEstimate = estimateTokens(args.prompt);
      const estimatedCostUsd = ((profile.inCost * tokenEstimate.inTokens + profile.outCost * tokenEstimate.outTokens) / 1_000_000);
      return { provider, modelId, profile, estimatedCostUsd };
    })
  );

  if (!candidates.length) {
    return {
      selected: null,
      metadataMissing: true,
      trace: {
        trace_id: args.traceId,
        intent: { label: intentLabel, confidence: 1, source: "resolved-router-intent" },
        complexity,
        candidates: [],
        selected_model: `${args.currentSelection.providerName}:${args.currentSelection.modelId}`,
        selection_summary: "No candidates available.",
        mode: config.shadowMode ? "shadow" : "enforced"
      }
    };
  }

  const cheapest = Math.max(Math.min(...candidates.map((c) => c.estimatedCostUsd)), 0.000001);

  const scored = candidates.map((candidate) => {
    const flags: string[] = [];
    const reasons: string[] = [];
    let eligible = true;

    const costMultiplier = candidate.estimatedCostUsd / cheapest;
    if (candidate.estimatedCostUsd > config.hard_cap_usd_per_request) {
      eligible = false;
      flags.push("blocked_hard_cap");
      reasons.push("estimated_cost_above_hard_cap");
    }
    if (costMultiplier > config.max_cost_multiplier_vs_cheapest) {
      eligible = false;
      flags.push("blocked_relative_cost");
      reasons.push("cost_multiplier_above_threshold");
    }
    const maxLatency = config.max_latency_ms_by_intent[intentLabel];
    if (maxLatency && candidate.profile.latency > maxLatency) {
      eligible = false;
      flags.push("blocked_latency_cap");
      reasons.push("latency_above_intent_threshold");
    }
    const minQuality = config.min_quality_tier_by_intent[intentLabel];
    if (minQuality && candidate.profile.quality < minQuality) {
      eligible = false;
      flags.push("blocked_quality_floor");
      reasons.push("quality_below_intent_floor");
    }

    const qualityScore = candidate.profile.quality / 5;
    const latencyScore = 1 - Math.min(candidate.profile.latency / 5000, 1);
    const costScore = 1 - Math.min(costMultiplier / config.max_cost_multiplier_vs_cheapest, 1);
    const final = eligible ? qualityScore * 2 + latencyScore + costScore : -1;

    return { candidate, eligible, flags, reasons, qualityScore, latencyScore, costScore, final };
  });

  const selected = scored.find(
    (item) => item.candidate.provider.name === args.currentSelection.providerName && item.candidate.modelId === args.currentSelection.modelId
  );

  const selectedIneligible = selected ? !selected.eligible : true;
  const fallback = scored.filter((item) => item.eligible).sort((a, b) => b.final - a.final)[0];
  const enforcedSelection = selectedIneligible ? fallback : null;

  return {
    selected: enforcedSelection
      ? { provider: enforcedSelection.candidate.provider, modelId: enforcedSelection.candidate.modelId }
      : null,
    metadataMissing: false,
    trace: {
      trace_id: args.traceId,
      intent: { label: intentLabel, confidence: 1, source: "resolved-router-intent" },
      complexity,
      candidates: scored
        .sort((a, b) => b.final - a.final)
        .map((item) => ({
          model: `${item.candidate.provider.name}:${item.candidate.modelId}`,
          quality_score: Number(item.qualityScore.toFixed(4)),
          latency_score: Number(item.latencyScore.toFixed(4)),
          cost_score: Number(item.costScore.toFixed(4)),
          estimated_cost_usd: Number(item.candidate.estimatedCostUsd.toFixed(6)),
          policy: { eligible: item.eligible, flags: item.flags, reasons: item.reasons },
          final_score: Number(item.final.toFixed(4))
        })),
      selected_model: `${(enforcedSelection ?? selected ?? scored[0]).candidate.provider.name}:${(enforcedSelection ?? selected ?? scored[0]).candidate.modelId}`,
      selection_summary: selectedIneligible
        ? `Current selection violated hard guardrails; enforced ${(enforcedSelection ?? scored[0]).candidate.provider.name}:${(enforcedSelection ?? scored[0]).candidate.modelId}.`
        : "Current selection passed hard guardrails.",
      mode: config.shadowMode ? "shadow" : "enforced",
      would_have_selected: `${(enforcedSelection ?? selected ?? scored[0]).candidate.provider.name}:${(enforcedSelection ?? selected ?? scored[0]).candidate.modelId}`
    }
  };
}

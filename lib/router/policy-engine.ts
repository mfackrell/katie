import { ProviderName } from "@/lib/router/model-intent";
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
  | "quick_factual";

export type ModelCapabilities = {
  code_generation: number;
  code_review: number;
  architecture_design: number;
  debugging_diagnosis: number;
  nuanced_reasoning: number;
  emotional_intelligence: number;
  conversational_fluency: number;
  research_synthesis: number;
  large_context_handling: number;
  real_time_awareness: number;
  creative_writing: number;
  speed: number;
  repo_awareness: number;
};

type ComplexityLevel = "low" | "medium" | "high";

type PolicyModelMetadata = {
  provider: ProviderName;
  model_id: string;
  capabilities: ModelCapabilities;
  input_cost_per_1m_tokens: number | null;
  output_cost_per_1m_tokens: number | null;
  latency_ms_p50: number | null;
  quality_tier: number | null;
  context_window?: number | null;
  reasoning_tier?: number | null;
};

type PolicyConfig = {
  enabled: boolean;
  shadowMode: boolean;
  fallbackOnMissingMetadata: boolean;
  hard_cap_usd_per_request: number;
  soft_cap_usd_per_request: number;
  max_cost_multiplier_vs_cheapest: number;
  scoring_weights: { capability: number; quality: number; latency: number; cost: number };
  low_complexity_weight_shift: { capability: number; cost: number };
  high_complexity_weight_shift: { capability: number; cost: number };
  ambiguity_tie_margin_ratio: number;
  max_latency_ms_by_intent: Partial<Record<PolicyIntentLabel, number>>;
  min_quality_tier_by_intent: Partial<Record<PolicyIntentLabel, number>>;
  allowed_expensive_intents: PolicyIntentLabel[];
  allowed_expensive_user_tiers: string[];
  min_current_message_intent_weight: number;
  max_context_intent_weight: number;
};

export type PolicyTrace = {
  trace_id: string;
  intent: { label: PolicyIntentLabel; confidence: number };
  complexity: ComplexityLevel;
  candidates: Array<{
    model: string;
    capability_score: number;
    quality_score: number;
    latency_score: number;
    cost_score: number;
    estimated_cost_usd: number;
    policy: { eligible: boolean; flags: string[]; penalty: number; reasons: string[] };
    final_score: number;
  }>;
  selected_model: string;
  runner_up_model?: string;
  selection_summary: string;
  mode: "shadow" | "enforced";
  would_have_selected?: string;
  tiebreaker_applied?: boolean;
};

export type PolicyEvaluationResult = {
  selected: { provider: LlmProvider; modelId: string } | null;
  trace: PolicyTrace;
  metadataMissing: boolean;
};

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  code_generation: 0.5,
  code_review: 0.5,
  architecture_design: 0.5,
  debugging_diagnosis: 0.5,
  nuanced_reasoning: 0.5,
  emotional_intelligence: 0.5,
  conversational_fluency: 0.5,
  research_synthesis: 0.5,
  large_context_handling: 0.5,
  real_time_awareness: 0.5,
  creative_writing: 0.5,
  speed: 0.5,
  repo_awareness: 0.5
};

const INTENT_CAPABILITY_WEIGHTS: Record<PolicyIntentLabel, Partial<ModelCapabilities>> = {
  conversation_reflection: { conversational_fluency: 0.35, nuanced_reasoning: 0.35, emotional_intelligence: 0.3 },
  explanation_meta: { conversational_fluency: 0.3, nuanced_reasoning: 0.4, emotional_intelligence: 0.3 },
  implementation_code: { code_generation: 0.35, repo_awareness: 0.25, debugging_diagnosis: 0.2, speed: 0.2 },
  debug_diagnosis: { debugging_diagnosis: 0.35, code_review: 0.25, nuanced_reasoning: 0.25, repo_awareness: 0.15 },
  architecture_design: { architecture_design: 0.4, nuanced_reasoning: 0.35, large_context_handling: 0.25 },
  research_synthesis: { large_context_handling: 0.35, research_synthesis: 0.35, nuanced_reasoning: 0.2, speed: 0.1 },
  creative_brainstorm: { creative_writing: 0.4, conversational_fluency: 0.3, nuanced_reasoning: 0.2, speed: 0.1 },
  personal_relational: { emotional_intelligence: 0.4, nuanced_reasoning: 0.3, conversational_fluency: 0.3 },
  quick_factual: { speed: 0.5, conversational_fluency: 0.3, real_time_awareness: 0.2 }
};

const SELF_REFERENTIAL_PATTERN = /\b(katie|you|your|routing|route|why did you|previous response|continuity|personality|behavior)\b/i;

export function getPolicyConfig(): PolicyConfig {
  return {
    enabled: process.env.ROUTER_POLICY_ENGINE_ENABLED === "true",
    shadowMode: process.env.ROUTER_POLICY_SHADOW_MODE === "true",
    fallbackOnMissingMetadata: process.env.ROUTER_POLICY_FALLBACK_ON_MISSING_METADATA !== "false",
    hard_cap_usd_per_request: Number(process.env.ROUTER_POLICY_HARD_CAP_USD_PER_REQUEST ?? 0.12),
    soft_cap_usd_per_request: Number(process.env.ROUTER_POLICY_SOFT_CAP_USD_PER_REQUEST ?? 0.04),
    max_cost_multiplier_vs_cheapest: Number(process.env.ROUTER_POLICY_MAX_COST_MULTIPLIER_VS_CHEAPEST ?? 3),
    scoring_weights: {
      capability: Number(process.env.ROUTER_POLICY_WEIGHT_CAPABILITY ?? 0.45),
      quality: Number(process.env.ROUTER_POLICY_WEIGHT_QUALITY ?? 0.25),
      latency: Number(process.env.ROUTER_POLICY_WEIGHT_LATENCY ?? 0.15),
      cost: Number(process.env.ROUTER_POLICY_WEIGHT_COST ?? 0.15)
    },
    low_complexity_weight_shift: { capability: -0.15, cost: 0.15 },
    high_complexity_weight_shift: { capability: 0.15, cost: -0.15 },
    ambiguity_tie_margin_ratio: Number(process.env.ROUTER_POLICY_AMBIGUITY_MARGIN_RATIO ?? 0.1),
    max_latency_ms_by_intent: {
      quick_factual: 2500,
      conversation_reflection: 4500
    },
    min_quality_tier_by_intent: {
      architecture_design: 3,
      debug_diagnosis: 3,
      personal_relational: 3
    },
    allowed_expensive_intents: ["architecture_design", "debug_diagnosis", "research_synthesis"],
    allowed_expensive_user_tiers: ["pro", "enterprise"],
    min_current_message_intent_weight: 0.7,
    max_context_intent_weight: 0.3
  };
}

export function classifyPolicyIntent(prompt: string, context: string): { label: PolicyIntentLabel; confidence: number } {
  const text = prompt.toLowerCase();
  if (SELF_REFERENTIAL_PATTERN.test(prompt)) {
    return { label: text.includes("why") || text.includes("route") ? "explanation_meta" : "conversation_reflection", confidence: 0.92 };
  }
  if (/\b(debug|bug|fix|error|exception|trace|failing|broken)\b/.test(text)) return { label: "debug_diagnosis", confidence: 0.86 };
  if (/\b(architecture|system design|tradeoff|scalability|microservice|monolith)\b/.test(text)) return { label: "architecture_design", confidence: 0.83 };
  if (/\b(write|implement|patch|refactor|typescript|python|api|function|class|repo)\b/.test(text)) return { label: "implementation_code", confidence: 0.84 };
  if (/\b(research|synthesize|compare sources|literature|survey)\b/.test(text)) return { label: "research_synthesis", confidence: 0.8 };
  if (/\b(brainstorm|idea|creative|story|tagline)\b/.test(text)) return { label: "creative_brainstorm", confidence: 0.78 };
  if (/\b(feel|relationship|personal|anxious|stressed|support)\b/.test(text)) return { label: "personal_relational", confidence: 0.8 };
  const ctxWeight = Math.min(getPolicyConfig().max_context_intent_weight, context ? 0.2 : 0);
  const promptWeight = Math.max(getPolicyConfig().min_current_message_intent_weight, 1 - ctxWeight);
  if (/\b(how|explain|meta|why)\b/.test(text)) return { label: "explanation_meta", confidence: 0.65 * promptWeight + 0.35 * ctxWeight };
  return { label: "quick_factual", confidence: 0.58 * promptWeight + 0.42 * ctxWeight };
}

function estimateComplexity(prompt: string, intent: PolicyIntentLabel): ComplexityLevel {
  const promptLen = prompt.length;
  const hasDesignTerms = /\b(architecture|tradeoff|distributed|multi-step|ambiguous)\b/i.test(prompt);
  const hasCodeBlock = /```|\bimport\b|\bfunction\b|\bclass\b/.test(prompt);
  if (promptLen > 1200 || hasDesignTerms) return "high";
  if (promptLen < 220 && intent === "quick_factual" && !hasCodeBlock) return "low";
  return "medium";
}

function estimateTokens(input: string, intent: PolicyIntentLabel): { inTokens: number; outTokens: number } {
  const inTokens = Math.max(1, Math.ceil(input.length / 4));
  const outputMultiplier = intent === "quick_factual" ? 0.4 : intent === "architecture_design" ? 1.2 : 0.8;
  return { inTokens, outTokens: Math.max(80, Math.ceil(inTokens * outputMultiplier)) };
}

function modelMetadata(providerName: ProviderName, modelId: string): PolicyModelMetadata {
  const lower = modelId.toLowerCase();
  const quality = lower.includes("opus") || lower.includes("o3-pro") ? 5 : lower.includes("pro") ? 4 : 3;
  const latency = lower.includes("haiku") || lower.includes("flash") ? 1200 : lower.includes("pro") ? 3800 : 2200;
  const inCost = lower.includes("opus") ? 15 : lower.includes("pro") ? 8 : lower.includes("flash") || lower.includes("haiku") ? 0.8 : 3;
  const outCost = lower.includes("opus") ? 45 : lower.includes("pro") ? 24 : lower.includes("flash") || lower.includes("haiku") ? 3.2 : 12;
  const byModel: Array<[string, Partial<ModelCapabilities>]> = [
    ["claude", { nuanced_reasoning: 0.92, emotional_intelligence: 0.9, architecture_design: 0.9, conversational_fluency: 0.88 }],
    ["gpt-4", { code_generation: 0.85, debugging_diagnosis: 0.84, speed: 0.8, nuanced_reasoning: 0.8 }],
    ["gpt-5", { code_generation: 0.88, debugging_diagnosis: 0.86, speed: 0.82, nuanced_reasoning: 0.84 }],
    ["o3-pro", { nuanced_reasoning: 0.95, architecture_design: 0.9, debugging_diagnosis: 0.9, speed: 0.45 }],
    ["gemini", { large_context_handling: 0.92, research_synthesis: 0.9, creative_writing: 0.82 }],
    ["grok", { speed: 0.9, conversational_fluency: 0.82, real_time_awareness: 0.88, nuanced_reasoning: 0.62 }],
    ["codex", { repo_awareness: 0.95, code_generation: 0.9, code_review: 0.88, conversational_fluency: 0.45 }]
  ];
  const caps: ModelCapabilities = { ...DEFAULT_CAPABILITIES };
  for (const [needle, values] of byModel) {
    if (lower.includes(needle)) Object.assign(caps, values);
  }
  return {
    provider: providerName,
    model_id: modelId,
    capabilities: caps,
    input_cost_per_1m_tokens: inCost,
    output_cost_per_1m_tokens: outCost,
    latency_ms_p50: latency,
    quality_tier: quality,
    context_window: null,
    reasoning_tier: null
  };
}

function capabilityScore(intent: PolicyIntentLabel, capabilities: ModelCapabilities): number {
  const weights = INTENT_CAPABILITY_WEIGHTS[intent];
  return Object.entries(weights).reduce((acc, [key, weight]) => acc + capabilities[key as keyof ModelCapabilities] * weight, 0);
}

export function evaluatePolicyRouting(args: {
  prompt: string;
  context: string;
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>;
  traceId: string;
  userTier?: string;
  currentSelection: { providerName: string; modelId: string };
}): PolicyEvaluationResult {
  const config = getPolicyConfig();
  const intent = classifyPolicyIntent(args.prompt, args.context);
  const complexity = estimateComplexity(args.prompt, intent.label);
  const candidates = args.availableByProvider.flatMap(({ provider, models }) =>
    models.map((modelId) => {
      const metadata = modelMetadata(provider.name, modelId);
      const tokenEstimate = estimateTokens(args.prompt, intent.label);
      const estimatedCostUsd = (((metadata.input_cost_per_1m_tokens ?? 0) * tokenEstimate.inTokens + (metadata.output_cost_per_1m_tokens ?? 0) * tokenEstimate.outTokens) / 1_000_000);
      return { provider, modelId, metadata, estimatedCostUsd };
    })
  );

  if (!candidates.length) {
    return {
      selected: null,
      metadataMissing: true,
      trace: {
        trace_id: args.traceId,
        intent,
        complexity,
        candidates: [],
        selected_model: `${args.currentSelection.providerName}:${args.currentSelection.modelId}`,
        selection_summary: "No candidates available.",
        mode: config.shadowMode ? "shadow" : "enforced"
      }
    };
  }

  const cheapest = Math.max(Math.min(...candidates.map((c) => c.estimatedCostUsd)), 0.000001);
  const weights = { ...config.scoring_weights };
  if (complexity === "low") {
    weights.capability += config.low_complexity_weight_shift.capability;
    weights.cost += config.low_complexity_weight_shift.cost;
  } else if (complexity === "high") {
    weights.capability += config.high_complexity_weight_shift.capability;
    weights.cost += config.high_complexity_weight_shift.cost;
  }

  const scored = candidates.map((candidate) => {
    const flags: string[] = [];
    const reasons: string[] = [];
    let eligible = true;
    let policyPenalty = 0;
    const costMultiplier = candidate.estimatedCostUsd / cheapest;

    if (candidate.estimatedCostUsd > config.hard_cap_usd_per_request) {
      eligible = false;
      flags.push("blocked_hard_cap");
      reasons.push("estimated_cost_above_hard_cap");
    }
    if (candidate.estimatedCostUsd > config.soft_cap_usd_per_request) {
      flags.push("penalized_soft_cap");
      policyPenalty += 0.2;
      reasons.push("estimated_cost_above_soft_cap");
    }
    if (costMultiplier > config.max_cost_multiplier_vs_cheapest) {
      flags.push("blocked_relative_cost");
      eligible = false;
      reasons.push("cost_multiplier_above_threshold");
    }
    const maxLatency = config.max_latency_ms_by_intent[intent.label];
    if (maxLatency && (candidate.metadata.latency_ms_p50 ?? Number.MAX_SAFE_INTEGER) > maxLatency) {
      flags.push("blocked_latency_cap");
      eligible = false;
      reasons.push("latency_above_intent_threshold");
    }
    const minQuality = config.min_quality_tier_by_intent[intent.label];
    if (minQuality && (candidate.metadata.quality_tier ?? 0) < minQuality) {
      flags.push("blocked_quality_floor");
      eligible = false;
      reasons.push("quality_below_intent_floor");
    }

    const expensiveOverrideAllowed =
      config.allowed_expensive_intents.includes(intent.label) ||
      (args.userTier ? config.allowed_expensive_user_tiers.includes(args.userTier) : false);
    if (expensiveOverrideAllowed && flags.includes("penalized_soft_cap")) {
      flags.push("override_expensive_allowed");
      policyPenalty = Math.max(0, policyPenalty - 0.15);
      reasons.push("soft_cap_override_allowed");
    }

    const capability = capabilityScore(intent.label, candidate.metadata.capabilities);
    const quality = (candidate.metadata.quality_tier ?? 0) / 5;
    const latency = 1 - Math.min((candidate.metadata.latency_ms_p50 ?? 5000) / 5000, 1);
    const cost = 1 - Math.min(costMultiplier / config.max_cost_multiplier_vs_cheapest, 1);
    const final = (eligible ? capability * weights.capability + quality * weights.quality + latency * weights.latency + cost * weights.cost : -1) - policyPenalty;
    return { candidate, capability, quality, latency, cost, policyPenalty, flags, reasons, eligible, final };
  });

  const eligible = scored.filter((s) => s.eligible).sort((a, b) => b.final - a.final);
  const top = eligible[0] ?? scored.sort((a, b) => b.final - a.final)[0];
  const runner = eligible[1];
  let selected = top;
  let tiebreakerApplied = false;
  if (top && runner && top.final > 0 && top.final - runner.final <= top.final * config.ambiguity_tie_margin_ratio) {
    const topBreadth = Object.values(top.candidate.metadata.capabilities).reduce((a, b) => a + b, 0) / Object.keys(top.candidate.metadata.capabilities).length;
    const runnerBreadth = Object.values(runner.candidate.metadata.capabilities).reduce((a, b) => a + b, 0) / Object.keys(runner.candidate.metadata.capabilities).length;
    if (runnerBreadth > topBreadth) {
      selected = runner;
      tiebreakerApplied = true;
    }
  }

  const selectedModelKey = `${selected.candidate.provider.name}:${selected.candidate.modelId}`;
  return {
    selected: {
      provider: selected.candidate.provider,
      modelId: selected.candidate.modelId
    },
    metadataMissing: false,
    trace: {
      trace_id: args.traceId,
      intent,
      complexity,
      candidates: scored
        .sort((a, b) => b.final - a.final)
        .map((s) => ({
          model: `${s.candidate.provider.name}:${s.candidate.modelId}`,
          capability_score: Number(s.capability.toFixed(4)),
          quality_score: Number(s.quality.toFixed(4)),
          latency_score: Number(s.latency.toFixed(4)),
          cost_score: Number(s.cost.toFixed(4)),
          estimated_cost_usd: Number(s.candidate.estimatedCostUsd.toFixed(6)),
          policy: { eligible: s.eligible, flags: s.flags, penalty: Number(s.policyPenalty.toFixed(4)), reasons: s.reasons },
          final_score: Number(s.final.toFixed(4))
        })),
      selected_model: selectedModelKey,
      runner_up_model: runner ? `${runner.candidate.provider.name}:${runner.candidate.modelId}` : undefined,
      selection_summary: `Selected ${selectedModelKey} for ${intent.label} with ${complexity} complexity profile.`,
      mode: config.shadowMode ? "shadow" : "enforced",
      would_have_selected: selectedModelKey,
      tiebreaker_applied: tiebreakerApplied
    }
  };
}

import type { RegistryRoutingModel } from "@/lib/models/registry";
import type { ActorRoutingProfile } from "@/lib/types/chat";
import type { ProviderName, RequestIntent } from "@/lib/router/model-intent";

export type TaskResponseType =
  | "freeform"
  | "structured-json"
  | "code"
  | "document-summary"
  | "extraction"
  | "classification"
  | "transformation"
  | "planning"
  | "agent-execution"
  | "image-generation";

export type CognitiveDemand = "trivial" | "moderate" | "deep" | "long-horizon" | "research" | "adversarial";
export type PrecisionRequirement = "low" | "medium" | "high" | "audit-grade";
export type LatencySensitivity = "realtime" | "interactive" | "background" | "batch";
export type CostSensitivity = "unconstrained" | "balanced" | "aggressive";
export type ContextShape = "short" | "thread" | "large-file" | "many-files" | "repo-scale" | "multimodal";
export type ToolDependence = "none" | "optional" | "tool-first" | "multi-tool";
export type RiskProfile = "casual" | "business-critical" | "financial" | "legal-adjacent" | "customer-facing" | "automation-safe";

export type RequestCapabilityProfile = {
  responseType: TaskResponseType;
  cognitiveDemand: CognitiveDemand;
  precisionRequirement: PrecisionRequirement;
  latencySensitivity: LatencySensitivity;
  costSensitivity: CostSensitivity;
  contextShape: ContextShape;
  toolDependence: ToolDependence;
  riskProfile: RiskProfile;
  requiresVision: boolean;
  requiresWebSearch: boolean;
  requiresImageGeneration: boolean;
  requiresVideoHandling: boolean;
  requiresRepoReasoning: boolean;
  requiresStructuredOutputs: boolean;
  prefersNaturalConversation: boolean;
  prefersLongContextFidelity: boolean;
  prefersStrongInstructionAdherence: boolean;
};

export type ModelCapabilityScores = {
  reasoningDepth: number;
  instructionAdherence: number;
  structuredOutputReliability: number;
  toolCallingReliability: number;
  longContextFidelity: number;
  documentUnderstanding: number;
  spreadsheetReasoning: number;
  codeGeneration: number;
  repoRefactorAbility: number;
  agenticPersistence: number;
  multimodalUnderstanding: number;
  imageGenerationQuality: number;
  imageEditingQuality: number;
  webGroundingReadiness: number;
  latency: number;
  costEfficiency: number;
  conversationalNaturalness: number;
  determinism: number;
  throughputSuitability: number;
  safetyFrictionFit: number;
};

export type CapabilityScoreBreakdown = {
  capabilityFit: number;
  toolFit: number;
  contextFit: number;
  latencyFit: number;
  costFit: number;
  reliabilityFit: number;
  riskPenalty: number;
  total: number;
  factors: Array<{ label: string; delta: number; detail?: string }>;
};

function clampScore(value: number): number {
  return Math.max(0, Math.min(10, Number(value.toFixed(2))));
}

function tierToScore(tier: "high" | "medium" | "low" | null | undefined, map: { high: number; medium: number; low: number }): number {
  if (!tier) return map.medium;
  return map[tier];
}
function speedTierToScore(tier: "fast" | "medium" | "slow" | null | undefined): number {
  if (!tier) return 6;
  return tier === "fast" ? 8 : tier === "slow" ? 3 : 6;
}
function costTierToEfficiency(tier: "low" | "medium" | "high" | null | undefined): number {
  if (!tier) return 5;
  return tier === "low" ? 8 : tier === "high" ? 2 : 5;
}

export function buildRequestCapabilityProfile(args: {
  prompt: string;
  intent: RequestIntent;
  hasImages: boolean;
  hasVideoInput: boolean;
  context: string;
}): RequestCapabilityProfile {
  const prompt = (args.prompt ?? "").toLowerCase();
  const context = args.context ?? "";
  const profile: RequestCapabilityProfile = {
    responseType: "freeform",
    cognitiveDemand: "moderate",
    precisionRequirement: "medium",
    latencySensitivity: "interactive",
    costSensitivity: "balanced",
    contextShape: "short",
    toolDependence: "optional",
    riskProfile: "casual",
    requiresVision: false,
    requiresWebSearch: false,
    requiresImageGeneration: false,
    requiresVideoHandling: Boolean(args.hasVideoInput),
    requiresRepoReasoning: false,
    requiresStructuredOutputs: false,
    prefersNaturalConversation: false,
    prefersLongContextFidelity: false,
    prefersStrongInstructionAdherence: false
  };

  const apply = (next: Partial<RequestCapabilityProfile>) => Object.assign(profile, next);

  switch (args.intent) {
    case "general-text":
    case "text":
      apply({ responseType: "freeform", cognitiveDemand: "moderate", precisionRequirement: "medium", latencySensitivity: "interactive", costSensitivity: "balanced" });
      break;
    case "rewrite":
      apply({ responseType: "transformation" });
      break;
    case "emotional-analysis":
      apply({ prefersNaturalConversation: true });
      break;
    case "social-emotional":
      apply({ prefersNaturalConversation: true, prefersStrongInstructionAdherence: true });
      break;
    case "news-summary":
      apply({ responseType: "document-summary", cognitiveDemand: "research", requiresWebSearch: true });
      break;
    case "web-search":
      apply({ cognitiveDemand: "research", precisionRequirement: "high", requiresWebSearch: true });
      break;
    case "code-review":
      apply({ responseType: "code", cognitiveDemand: "deep", precisionRequirement: "high", requiresRepoReasoning: true, prefersLongContextFidelity: true });
      break;
    case "technical-debugging":
      apply({ responseType: "code", cognitiveDemand: "deep", precisionRequirement: "high", requiresRepoReasoning: true, prefersStrongInstructionAdherence: true });
      break;
    case "architecture-review":
      apply({ responseType: "planning", cognitiveDemand: "deep", precisionRequirement: "high", requiresRepoReasoning: true, prefersLongContextFidelity: true });
      break;
    case "code-generation":
      apply({ responseType: "code", cognitiveDemand: "deep", precisionRequirement: "high", requiresStructuredOutputs: true });
      break;
    case "assistant-reflection":
      apply({ cognitiveDemand: "deep", precisionRequirement: "high", costSensitivity: "unconstrained" });
      break;
    case "vision-analysis":
      apply({ responseType: "extraction", cognitiveDemand: "deep", precisionRequirement: "high", requiresVision: true });
      break;
    case "multimodal-reasoning":
      apply({ responseType: "planning", cognitiveDemand: "deep", precisionRequirement: "high", requiresVision: args.hasImages || args.hasVideoInput });
      break;
    case "image-generation":
      apply({ responseType: "image-generation", requiresImageGeneration: true });
      break;
    case "safety-sensitive-vision":
      apply({ responseType: "extraction", cognitiveDemand: "adversarial", precisionRequirement: "high", requiresVision: true });
      break;
  }

  const contextLen = (args.prompt?.length ?? 0) + context.length;
  if (args.hasImages || args.hasVideoInput) {
    profile.contextShape = "multimodal";
  } else if (contextLen > 20_000) {
    profile.contextShape = profile.requiresRepoReasoning ? "repo-scale" : "many-files";
  } else if (contextLen > 9_000) {
    profile.contextShape = "large-file";
  } else if (contextLen > 2_000) {
    profile.contextShape = "thread";
  }

  if (/\b(json|schema|structured output|api payload|zapier|webhook|strictly valid)/.test(prompt)) {
    profile.requiresStructuredOutputs = true;
    if (["freeform", "transformation", "planning"].includes(profile.responseType)) {
      profile.responseType = "structured-json";
    }
    profile.toolDependence = "tool-first";
    profile.riskProfile = profile.riskProfile === "casual" ? "automation-safe" : profile.riskProfile;
  }

  if (/\b(speed|quick|fast|urgent|asap|realtime|real-time)\b/.test(prompt)) {
    profile.latencySensitivity = /\b(realtime|real-time)\b/.test(prompt) ? "realtime" : "interactive";
  }

  if (/\b(audit|reconcile|financial accuracy|sox|compliance|ledger|invoice reconciliation|regulatory)\b/.test(prompt)) {
    profile.precisionRequirement = "audit-grade";
    profile.riskProfile = /\b(financial|ledger|invoice|reconcile)\b/.test(prompt) ? "financial" : "business-critical";
    profile.costSensitivity = "unconstrained";
  }

  if (/\b(repo|repository|codebase|monorepo|pull request|diff)\b/.test(prompt)) {
    profile.requiresRepoReasoning = true;
    profile.prefersLongContextFidelity = true;
    if (profile.contextShape === "short") {
      profile.contextShape = "repo-scale";
    }
  }

  if (/\b(tool|function call|mcp|integration|agent)\b/.test(prompt)) {
    profile.toolDependence = profile.toolDependence === "tool-first" ? "multi-tool" : "optional";
  }

  return profile;
}

export function buildModelCapabilityScores(
  providerName: ProviderName,
  modelId: string,
  registryModel?: RegistryRoutingModel
): ModelCapabilityScores {
  const normalizedModel = modelId.toLowerCase();
  const reasoningBase = tierToScore(registryModel?.reasoning_tier, { high: 9, medium: 6, low: 3 });
  const speedBase = speedTierToScore(registryModel?.speed_tier);
  const costBase = costTierToEfficiency(registryModel?.cost_tier);

  const highReason = /o3|opus|sonnet|pro|codex|gpt-5/.test(normalizedModel);
  const fastModel = /flash|mini|haiku|nano/.test(normalizedModel);
  const strongCode = /codex|o3|opus|sonnet|pro|gpt-5/.test(normalizedModel);
  const conversational = /claude|sonnet|opus|grok-4|gpt-5|unified/.test(normalizedModel);
  const multimodalStrong = /gpt-5|gpt-4o|claude-4.5|claude-4.6|gemini-3|grok-4|o3/.test(normalizedModel);
  const imageGen = Boolean(registryModel?.supports_image_generation) || /image|imagen|dall-e|banana|flux|sdxl/.test(normalizedModel);
  const supportsVision = Boolean(registryModel?.supports_vision) || multimodalStrong;
  const supportsWeb = Boolean(registryModel?.supports_web_search);

  const structuredOutputReliability = registryModel?.structured_output_reliability ?? (highReason ? 8 : fastModel ? 5 : 6);
  const toolCallingReliability = registryModel?.tool_calling_reliability ?? (highReason ? 7 : fastModel ? 5 : 6);
  const longContextFidelity = registryModel?.long_context_fidelity ?? (highReason ? 8 : fastModel ? 4 : 6);

  return {
    reasoningDepth: clampScore(registryModel?.confidence_tier === "low" ? reasoningBase - 1 : reasoningBase + (highReason ? 1 : 0)),
    instructionAdherence: clampScore(highReason ? 8 : fastModel ? 6 : 7),
    structuredOutputReliability: clampScore(structuredOutputReliability),
    toolCallingReliability: clampScore(toolCallingReliability),
    longContextFidelity: clampScore(longContextFidelity),
    documentUnderstanding: clampScore(registryModel?.document_understanding ?? (highReason ? 8 : 6)),
    spreadsheetReasoning: clampScore(registryModel?.spreadsheet_reasoning ?? (highReason ? 7 : fastModel ? 4 : 5)),
    codeGeneration: clampScore(registryModel?.code_generation ?? (strongCode ? 8.5 : fastModel ? 4 : 6)),
    repoRefactorAbility: clampScore(registryModel?.repo_refactor_ability ?? (strongCode ? 8 : fastModel ? 3 : 5.5)),
    agenticPersistence: clampScore(highReason ? 7 : fastModel ? 4 : 5.5),
    multimodalUnderstanding: clampScore(supportsVision ? (multimodalStrong ? 8.5 : 6) : 1),
    imageGenerationQuality: clampScore(imageGen ? (/imagen|dall-e|flux/.test(normalizedModel) ? 8 : 6.5) : 0),
    imageEditingQuality: clampScore(imageGen && supportsVision ? 5.5 : supportsVision ? 4 : 0),
    webGroundingReadiness: clampScore(supportsWeb ? 8 : 2),
    latency: clampScore(fastModel ? 9 : highReason ? 5 : speedBase),
    costEfficiency: clampScore(fastModel ? 8.5 : /opus|o3|pro|gpt-5/.test(normalizedModel) ? 3 : costBase),
    conversationalNaturalness: clampScore(registryModel?.conversational_naturalness ?? (conversational ? 8.5 : fastModel ? 5 : 6.5)),
    determinism: clampScore(registryModel?.determinism ?? (highReason ? 7 : 6)),
    throughputSuitability: clampScore(registryModel?.throughput_suitability ?? (fastModel ? 9 : 6)),
    safetyFrictionFit: clampScore(providerName === "grok" ? 7 : providerName === "anthropic" ? 8 : 6)
  };
}

function pushFactor(factors: CapabilityScoreBreakdown["factors"], label: string, delta: number, detail?: string): number {
  if (delta !== 0) {
    factors.push({ label, delta: Number(delta.toFixed(2)), detail });
  }
  return delta;
}

type ActorRoutingIntentBucket =
  | "general"
  | "technical-debugging"
  | "architecture-design"
  | "coding-implementation"
  | "writing-editing"
  | "research-analysis"
  | "emotional-support";

function mapCapabilityProfileToActorIntentBucket(profile: RequestCapabilityProfile): ActorRoutingIntentBucket {
  if (profile.requiresWebSearch || profile.cognitiveDemand === "research") {
    return "research-analysis";
  }
  if (profile.prefersNaturalConversation) {
    return "emotional-support";
  }
  if (profile.requiresRepoReasoning && profile.responseType === "planning") {
    return "architecture-design";
  }
  if (profile.responseType === "code" || profile.requiresRepoReasoning) {
    return "coding-implementation";
  }
  if (profile.responseType === "transformation" || profile.responseType === "document-summary") {
    return "writing-editing";
  }
  return "general";
}

export function scoreCandidateForCapabilityProfile(args: {
  profile: RequestCapabilityProfile;
  providerName: ProviderName;
  modelId: string;
  registryModel?: RegistryRoutingModel;
  preferredProvider?: ProviderName | null;
  actorRoutingProfile?: ActorRoutingProfile;
}): CapabilityScoreBreakdown {
  const factors: CapabilityScoreBreakdown["factors"] = [];
  const scores = buildModelCapabilityScores(args.providerName, args.modelId, args.registryModel);

  if (args.profile.requiresImageGeneration && !(args.registryModel?.supports_image_generation ?? scores.imageGenerationQuality > 0)) {
    return { capabilityFit: -100, toolFit: 0, contextFit: 0, latencyFit: 0, costFit: 0, reliabilityFit: 0, riskPenalty: 0, total: -100, factors: [{ label: "hard_constraint_image_generation", delta: -100 }] };
  }
  if (args.profile.requiresVision && !(args.registryModel?.supports_vision ?? scores.multimodalUnderstanding >= 5)) {
    return { capabilityFit: -100, toolFit: 0, contextFit: 0, latencyFit: 0, costFit: 0, reliabilityFit: 0, riskPenalty: 0, total: -100, factors: [{ label: "hard_constraint_vision", delta: -100 }] };
  }
  if (args.profile.requiresWebSearch && !(args.registryModel?.supports_web_search ?? scores.webGroundingReadiness >= 6)) {
    return { capabilityFit: -100, toolFit: 0, contextFit: 0, latencyFit: 0, costFit: 0, reliabilityFit: 0, riskPenalty: 0, total: -100, factors: [{ label: "hard_constraint_web_search", delta: -100 }] };
  }
  if (args.profile.responseType === "code" && (args.registryModel?.supports_image_generation ?? false)) {
    return { capabilityFit: -100, toolFit: 0, contextFit: 0, latencyFit: 0, costFit: 0, reliabilityFit: 0, riskPenalty: 0, total: -100, factors: [{ label: "hard_constraint_technical_not_image_gen", delta: -100 }] };
  }

  let capabilityFit = 0;
  if (["deep", "research", "adversarial"].includes(args.profile.cognitiveDemand) || args.profile.precisionRequirement === "audit-grade") {
    capabilityFit += pushFactor(factors, "reasoning_depth_alignment", scores.reasoningDepth * 1.3);
  } else {
    capabilityFit += pushFactor(factors, "reasoning_depth_baseline", scores.reasoningDepth * 0.8);
  }
  if (args.profile.prefersNaturalConversation) {
    capabilityFit += pushFactor(factors, "conversational_naturalness", scores.conversationalNaturalness * 1.2);
    const providerConversationBias =
      args.providerName === "anthropic" ? 6 : args.providerName === "grok" ? 4 : args.providerName === "openai" ? 2 : -2;
    capabilityFit += pushFactor(factors, "social_emotional_provider_bias", providerConversationBias);
  }
  if (args.profile.responseType === "code" || args.profile.requiresRepoReasoning) {
    capabilityFit += pushFactor(factors, "code_repo_alignment", (scores.codeGeneration + scores.repoRefactorAbility) * 0.9);
  }
  if (args.profile.requiresStructuredOutputs || args.profile.responseType === "structured-json") {
    capabilityFit += pushFactor(factors, "structured_output_alignment", scores.structuredOutputReliability * 1.2);
  }
  if (args.profile.prefersLongContextFidelity || ["repo-scale", "many-files", "large-file"].includes(args.profile.contextShape)) {
    capabilityFit += pushFactor(factors, "long_context_alignment", scores.longContextFidelity * 1.1);
  }

  let toolFit = 0;
  if (args.profile.requiresWebSearch) toolFit += pushFactor(factors, "web_grounding", scores.webGroundingReadiness);
  if (args.profile.toolDependence !== "none") toolFit += pushFactor(factors, "tool_calling", scores.toolCallingReliability * 0.8);
  if (args.profile.requiresImageGeneration) toolFit += pushFactor(factors, "image_generation", scores.imageGenerationQuality);

  const contextFit = Number(
    (
      (scores.longContextFidelity + (args.profile.requiresRepoReasoning ? scores.repoRefactorAbility : scores.documentUnderstanding)) /
      2
    ).toFixed(2)
  );
  factors.push({ label: "context_fit", delta: contextFit });

  const latencyWeight = args.profile.latencySensitivity === "realtime" ? 1.2 : args.profile.latencySensitivity === "interactive" ? 1 : 0.4;
  const latencyFit = Number((scores.latency * latencyWeight).toFixed(2));
  factors.push({ label: "latency_fit", delta: latencyFit });

  const costWeight = args.profile.costSensitivity === "aggressive" ? 1.1 : args.profile.costSensitivity === "balanced" ? 0.8 : 0.3;
  const costFit = Number((scores.costEfficiency * costWeight).toFixed(2));
  factors.push({ label: "cost_fit", delta: costFit });

  const confidenceBoost = args.registryModel?.confidence_tier === "high" ? 2 : args.registryModel?.confidence_tier === "medium" ? 1 : 0;
  const reliabilityFit = Number((scores.determinism + confidenceBoost).toFixed(2));
  factors.push({ label: "reliability_fit", delta: reliabilityFit });

  let riskPenalty = 0;
  if (args.profile.riskProfile !== "casual") {
    const reliabilityGap = Math.max(0, 7 - scores.structuredOutputReliability);
    const reasoningGap = Math.max(0, 7 - scores.reasoningDepth);
    riskPenalty = Number(((reliabilityGap + reasoningGap) * (args.profile.precisionRequirement === "audit-grade" ? 1.2 : 0.8)).toFixed(2));
    if (riskPenalty > 0) {
      factors.push({ label: "risk_penalty", delta: -riskPenalty });
    }
  }

  if (args.preferredProvider && args.preferredProvider === args.providerName) {
    factors.push({ label: "preferred_provider_boost", delta: 8 });
    capabilityFit += 8;
  }

  if (args.actorRoutingProfile) {
    const providerBoost = args.actorRoutingProfile.providerBoosts[args.providerName] ?? 0;
    const actorIntent = mapCapabilityProfileToActorIntentBucket(args.profile);
    const intentBoost = args.actorRoutingProfile.intentProviderBoosts[actorIntent]?.[args.providerName] ?? 0;
    const actorDelta = Number((providerBoost + intentBoost).toFixed(2));
    if (actorDelta !== 0) {
      factors.push({ label: "actor_routing_bias", delta: actorDelta, detail: `intent_bucket=${actorIntent}` });
      capabilityFit += actorDelta;
    }
  }

  const total = Number((capabilityFit + toolFit + contextFit + latencyFit + costFit + reliabilityFit - riskPenalty).toFixed(2));
  return { capabilityFit: Number(capabilityFit.toFixed(2)), toolFit: Number(toolFit.toFixed(2)), contextFit, latencyFit, costFit, reliabilityFit, riskPenalty, total, factors };
}

import {
  isImageGenerationModel as isGoogleImageGenerationModel,
  isVisionAnalysisModel as isGoogleVisionAnalysisModel
} from "@/lib/providers/google-model-capabilities";
import { LlmProvider } from "@/lib/providers/types";

export type ProviderName = "openai" | "google" | "grok" | "anthropic";
export type RoutingChoice = { providerName: ProviderName; modelId: string };
export type RequestIntent =
  | "text"
  | "technical-debugging"
  | "architecture-review"
  | "code-generation"
  | "vision-analysis"
  | "multimodal-reasoning"
  | "image-generation";

const IMAGE_GENERATION_PROMPT =
  /\b(generate|create|make|design|render)\b[\s\S]{0,80}\b(image|photo|picture|illustration|art|hero image|logo|banner|visual)\b/i;
const ANALYSIS_PROMPT =
  /\b(read|analy[sz]e|inspect|interpret|estimate|project|forecast|extract|summari[sz]e|compare|classify)\b/i;
const REASONING_PROMPT = /\b(project|forecast|predict|reason|infer|trend|next|quarters?|months?|years?)\b/i;
const TECHNICAL_DEBUGGING_PROMPT =
  /\b(debug|bug|fix|error|exception|stack\s*trace|failing|broken|troubleshoot|regression|incident)\b/i;
const ARCHITECTURE_REVIEW_PROMPT =
  /\b(architecture|system\s*design|design\s*review|scalability|trade[\s-]?offs?|microservices?|monolith|repo\s*review|codebase\s*review|review\s+(this\s+)?repo)\b/i;
const CODE_GENERATION_PROMPT =
  /\b(write|generate|create|implement|patch|refactor)\b[\s\S]{0,50}\b(code|function|class|script|module|typescript|javascript|python|sql|api|router)\b|\bcode\s+generation\b/i;
const TECHNICAL_FILE_PROMPT = /\b[\w./-]+\.(ts|tsx|js|jsx|py|go|java|rs|cpp|c|cs|rb|php|swift|kt|sql)\b/i;

const IMAGE_GENERATION_MODEL_PATTERNS = [
  "banana",
  "image",
  "image-preview",
  "imagen",
  "stable-diffusion",
  "sdxl",
  "dall-e",
  "midjourney",
  "flux"
];

function isImageGenerationModel(providerName: ProviderName, modelId: string): boolean {
  const normalizedModel = modelId.toLowerCase();

  if (IMAGE_GENERATION_MODEL_PATTERNS.some((pattern) => normalizedModel.includes(pattern))) {
    return true;
  }

  if (providerName === "google") {
    return isGoogleImageGenerationModel(modelId);
  }

  return false;
}

function isVisionAnalysisModel(providerName: ProviderName, modelId: string): boolean {
  if (providerName === "google") {
    return isGoogleVisionAnalysisModel(modelId);
  }

  return false;
}

// Request intent drives validation. The router is allowed to be creative. Validation is not.
export function inferRequestIntent(prompt: string, hasImages: boolean): RequestIntent {
  if (TECHNICAL_DEBUGGING_PROMPT.test(prompt)) {
    return "technical-debugging";
  }

  if (ARCHITECTURE_REVIEW_PROMPT.test(prompt)) {
    return "architecture-review";
  }

  if (CODE_GENERATION_PROMPT.test(prompt) || TECHNICAL_FILE_PROMPT.test(prompt)) {
    return "code-generation";
  }

  if (IMAGE_GENERATION_PROMPT.test(prompt)) {
    return "image-generation";
  }

  if (!hasImages) {
    if (ANALYSIS_PROMPT.test(prompt) && REASONING_PROMPT.test(prompt)) {
      return "multimodal-reasoning";
    }

    return "text";
  }

  return "vision-analysis";
}

function modelSupportsIntent(providerName: ProviderName, modelId: string, intent: RequestIntent): boolean {
  switch (intent) {
    case "image-generation":
      return isImageGenerationModel(providerName, modelId);
    case "vision-analysis":
    case "multimodal-reasoning":
      return (
        providerName === "google" &&
        isVisionAnalysisModel(providerName, modelId) &&
        !isImageGenerationModel(providerName, modelId)
      );
    case "text":
    case "technical-debugging":
    case "architecture-review":
    case "code-generation":
      return !isImageGenerationModel(providerName, modelId);
  }
}

function rankTechnicalModel(providerName: ProviderName, modelId: string): number {
  if (isImageGenerationModel(providerName, modelId)) {
    return -1;
  }

  const normalizedModel = modelId.toLowerCase();
  let score = 10;

  if (normalizedModel.includes("codex") || normalizedModel.includes("o3-pro")) {
    score += 8;
  }
  if (normalizedModel.includes("opus") || normalizedModel.includes("sonnet")) {
    score += 6;
  }
  if (normalizedModel.includes("pro")) {
    score += 4;
  }
  if (normalizedModel.includes("gpt-5") || normalizedModel.includes("gpt-4.1")) {
    score += 4;
  }
  if (normalizedModel.includes("mini") || normalizedModel.includes("flash") || normalizedModel.includes("haiku")) {
    score -= 4;
  }
  if (normalizedModel.includes("pulse")) {
    score -= 6;
  }

  return score;
}

function rankModelForIntent(providerName: ProviderName, modelId: string, intent: RequestIntent): number {
  const normalizedModel = modelId.toLowerCase();

  switch (intent) {
    case "image-generation":
      if (!isImageGenerationModel(providerName, modelId)) {
        return -1;
      }
      return normalizedModel.includes("banana") ? 4 : 2;
    case "multimodal-reasoning":
      if (!modelSupportsIntent(providerName, modelId, intent)) {
        return -1;
      }
      if (normalizedModel.includes("pro") && normalizedModel.includes("vision")) {
        return 5;
      }
      if (normalizedModel.includes("pro")) {
        return 4;
      }
      if (normalizedModel.includes("flash")) {
        return 3;
      }
      return 1;
    case "vision-analysis":
      if (!modelSupportsIntent(providerName, modelId, intent)) {
        return -1;
      }
      if (normalizedModel.includes("vision")) {
        return 5;
      }
      if (normalizedModel.includes("pro")) {
        return 4;
      }
      if (normalizedModel.includes("flash")) {
        return 3;
      }
      return 1;
    case "text":
      if (!modelSupportsIntent(providerName, modelId, intent)) {
        return -1;
      }

      let score = 10;

      if (normalizedModel.includes("flash") || normalizedModel.includes("haiku") || normalizedModel.includes("mini")) {
        score += 8;
      }

      if (normalizedModel.includes("gpt-5.2-unified") || normalizedModel.includes("grok-2-1212")) {
        score += 6;
      }

      if (normalizedModel.includes("unified") || normalizedModel.includes("grok-2")) {
        score += 3;
      }

      if (
        normalizedModel.includes("opus") ||
        normalizedModel.includes("o3-pro") ||
        normalizedModel.includes("codex") ||
        normalizedModel.includes("architect") ||
        normalizedModel.includes("reason")
      ) {
        score -= 8;
      }

      if (normalizedModel.includes("pro") && !normalizedModel.includes("gpt-5.2-unified")) {
        score -= 4;
      }

      return score;
    case "technical-debugging":
    case "architecture-review":
    case "code-generation":
      return rankTechnicalModel(providerName, modelId);
  }
}

export function scoreModelsForIntent(
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  intent: RequestIntent
): Array<{ provider: LlmProvider; modelId: string; score: number }> {
  return availableByProvider
    .flatMap(({ provider, models }) =>
      models
        .map((modelId) => ({ provider, modelId, score: rankModelForIntent(provider.name, modelId, intent) }))
        .filter((candidate) => candidate.score >= 0)
    )
    .sort((left, right) => right.score - left.score);
}

export function validateRoutingDecision(
  decision: RoutingChoice,
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  intent: RequestIntent
): { provider: LlmProvider; modelId: string; reasoning: string; changed: boolean } {
  if (["technical-debugging", "code-generation", "architecture-review"].includes(intent)) {
    availableByProvider = availableByProvider.map(({ provider, models }) => ({
      provider,
      models: models.filter((modelId) => !isImageGenerationModel(provider.name, modelId))
    }));
  }

  const selectedProvider = availableByProvider.find(({ provider }) => provider.name === decision.providerName);

  if (
    selectedProvider &&
    modelSupportsIntent(decision.providerName, decision.modelId, intent) &&
    selectedProvider.models.includes(decision.modelId)
  ) {
    return {
      provider: selectedProvider.provider,
      modelId: decision.modelId,
      reasoning: `Validated ${decision.providerName}:${decision.modelId} for ${intent}.`,
      changed: false
    };
  }

  const compatibleChoices = scoreModelsForIntent(availableByProvider, intent);

  const fallback = compatibleChoices[0];

  if (fallback) {
    return {
      provider: fallback.provider,
      modelId: fallback.modelId,
      reasoning: `Rejected ${decision.providerName}:${decision.modelId} for ${intent}; fell back to ${fallback.provider.name}:${fallback.modelId}.`,
      changed: true
    };
  }

  const firstProvider = selectedProvider ?? availableByProvider[0];
  const modelId = selectedProvider?.models[0] ?? availableByProvider[0]?.models[0] ?? decision.modelId;

  return {
    provider: firstProvider.provider,
    modelId,
    reasoning: `No compatible model found for ${intent}; kept closest available ${firstProvider.provider.name}:${modelId}.`,
    changed: true
  };
}

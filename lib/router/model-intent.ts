import {
  isImageGenerationModel as isGoogleImageGenerationModel,
  isVisionAnalysisModel as isGoogleVisionAnalysisModel
} from "@/lib/providers/google-model-capabilities";
import { LlmProvider } from "@/lib/providers/types";

export type ProviderName = "openai" | "google" | "grok" | "anthropic";
export type RoutingChoice = { providerName: ProviderName; modelId: string };
export type RequestIntent = "text" | "vision-analysis" | "multimodal-reasoning" | "image-generation";

const IMAGE_GENERATION_PROMPT =
  /\b(generate|create|make|design|render)\b[\s\S]{0,80}\b(image|photo|picture|illustration|art|hero image|logo|banner|visual)\b/i;
const ANALYSIS_PROMPT =
  /\b(read|analy[sz]e|inspect|interpret|estimate|project|forecast|extract|summari[sz]e|compare|classify)\b/i;
const REASONING_PROMPT = /\b(project|forecast|predict|reason|infer|trend|next|quarters?|months?|years?)\b/i;

function isImageGenerationModel(providerName: ProviderName, modelId: string): boolean {
  const normalizedModel = modelId.toLowerCase();

  if (providerName === "google") {
    return isGoogleImageGenerationModel(modelId);
  }

  return normalizedModel.includes("image");
}

function isVisionAnalysisModel(providerName: ProviderName, modelId: string): boolean {
  if (providerName === "google") {
    return isGoogleVisionAnalysisModel(modelId);
  }

  return false;
}

// Request intent drives validation. The router is allowed to be creative. Validation is not.
export function inferRequestIntent(prompt: string, hasImages: boolean): RequestIntent {
  if (IMAGE_GENERATION_PROMPT.test(prompt)) {
    return "image-generation";
  }

  if (!hasImages) {
    return "text";
  }

  if (ANALYSIS_PROMPT.test(prompt) && REASONING_PROMPT.test(prompt)) {
    return "multimodal-reasoning";
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
      return !isImageGenerationModel(providerName, modelId);
  }
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
      return modelSupportsIntent(providerName, modelId, intent) ? 1 : -1;
  }
}

export function validateRoutingDecision(
  decision: RoutingChoice,
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  intent: RequestIntent
): { provider: LlmProvider; modelId: string; reasoning: string; changed: boolean } {
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

  const compatibleChoices = availableByProvider
    .flatMap(({ provider, models }) =>
      models
        .map((modelId) => ({ provider, modelId, score: rankModelForIntent(provider.name, modelId, intent) }))
        .filter((candidate) => candidate.score >= 0)
    )
    .sort((left, right) => right.score - left.score);

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

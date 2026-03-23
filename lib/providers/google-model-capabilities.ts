const GOOGLE_MODEL_ALIASES: Record<string, string> = {
  "gemini-pro": "gemini-3.1-pro",
  "gemini-3-pro": "gemini-3.1-pro",
  "gemini-flash": "gemini-3.1-flash",
  "gemini-3-flash": "gemini-3.1-flash"
};

export function normalizeGoogleModelId(modelId: string): string {
  const normalized = modelId.trim().replace(/^models\//, "");
  return GOOGLE_MODEL_ALIASES[normalized] ?? normalized;
}

function isGemini3Model(modelId: string): boolean {
  return /^gemini-3(\.|-)/.test(modelId);
}

// Do not guess from the family name. Image-preview models are not image-analysis models.
export function isImageGenerationModel(modelId: string): boolean {
  const normalizedModel = normalizeGoogleModelId(modelId).toLowerCase();
  return normalizedModel.includes("banana") || normalizedModel === "gpt-image-1";
}

// Vision analysis means the model can accept image input and answer about it.
export function isVisionAnalysisModel(modelId: string): boolean {
  const normalizedModel = normalizeGoogleModelId(modelId).toLowerCase();

  if (normalizedModel.includes("image-preview") || isImageGenerationModel(normalizedModel)) {
    return false;
  }

  return (
    normalizedModel.includes("vision") ||
    normalizedModel === "gemini-3.1-pro" ||
    normalizedModel === "gemini-3.1-flash"
  );
}

// Thinking config is model-specific. Sending it to the wrong Gemini model hard-fails the request.
export function supportsThinking(modelId: string): boolean {
  const normalizedModel = normalizeGoogleModelId(modelId).toLowerCase();

  if (!isGemini3Model(normalizedModel)) {
    return false;
  }

  if (
    normalizedModel.includes("image-preview") ||
    normalizedModel.includes("vision") ||
    isImageGenerationModel(normalizedModel)
  ) {
    return false;
  }

  return normalizedModel === "gemini-3.1-pro" || normalizedModel === "gemini-3.1-flash";
}

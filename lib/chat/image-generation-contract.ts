import type { ProviderResponse } from "@/lib/providers/types";
import { isImageGenerationModel } from "@/lib/providers/google-model-capabilities";

/** A generic higher-capacity text model is never a valid image fallback. */
export function imageGenerationCapableModel(provider: string, modelId: string): boolean {
  const id = modelId.trim().replace(/^models[/]/, "").toLowerCase();
  if (provider === "google") return isImageGenerationModel(id);
  if (provider === "openai") return /^(?:gpt-image-[a-z0-9.-]+|chatgpt-image-latest)$/.test(id);
  if (provider === "grok") return /^grok-imagine-image(?:-|$)/.test(id);
  return false;
}

/** A conversational response, even from an image-capable model, is not an image. */
export function containsGeneratedImage(result: Pick<ProviderResponse, "content">): boolean {
  return Boolean(result.content?.some(part =>
    part.type.toLowerCase().includes("image") &&
    typeof part.url === "string" && part.url.trim().length > 0
  ));
}

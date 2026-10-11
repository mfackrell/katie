import { validateRoutingDecision, type RequestIntent } from "@/lib/router/model-intent";
import type { LlmProvider } from "@/lib/providers/types";

/**
 * Gracefully recover a manual text-model override when an upstream classifier
 * incorrectly requires vision for a request with no visual input.
 * All classifier behavior, capability checks, and actual visual routing remain unchanged.
 */
export function validateManualOverrideWithRecovery(input: {
  provider: LlmProvider;
  modelId: string;
  availableModels: string[];
  intent: RequestIntent;
  hasVisualInput: boolean;
  hasVideoInput: boolean;
}): {
  decision: ReturnType<typeof validateRoutingDecision>;
  recoveredIntent: RequestIntent | null;
} {
  const selected = { providerName: input.provider.name, modelId: input.modelId };
  const available = [{ provider: input.provider, models: input.availableModels }];

  try {
    return { decision: validateRoutingDecision(selected, available, input.intent), recoveredIntent: null };
  } catch (error) {
    // Only recover the exact failure observed: a text-only turn misrouted as
    // vision. Do not downgrade a real image/video request to text, or override
    // the ordinary capability/validation checks for the selected model.
    const visionIntent = input.intent === "safety-sensitive-vision" ||
      input.intent === "vision-analysis" || input.intent === "multimodal-reasoning";
    if (input.hasVisualInput || input.hasVideoInput || !visionIntent ||
        !(error instanceof Error) ||
        error.message !== `No compatible model available for ${input.intent}.`) {
      throw error;
    }

    // Retry once as ordinary text, keeping the user's manually selected model.
    // This still throws if the chosen model cannot handle text.
    return {
      decision: validateRoutingDecision(selected, available, "general-text"),
      recoveredIntent: "general-text",
    };
  }
}

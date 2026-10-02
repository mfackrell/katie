import type { LlmProvider } from "@/lib/providers/types";

const BLOCKED_ROUTING_MODELS: Partial<Record<LlmProvider["name"], RegExp[]>> = {
  // These models are still returned by provider discovery in some accounts, but
  // have produced deterministic provider/API compatibility failures in production.
  // Keep the block narrow: only exact model families with observed failures belong here.
  openai: [
    /^gpt-4o(?:-mini)?-search-preview(?:-\d{4}-\d{2}-\d{2})?$/i,
    /^o4-mini-deep-research(?:-\d{4}-\d{2}-\d{2})?$/i,
    /^gpt-5-search-api(?:-\d{4}-\d{2}-\d{2})?$/i,
  ],
};

export function isBlockedRoutingModel(
  providerName?: LlmProvider["name"],
  modelId?: string,
): boolean {
  if (!providerName || !modelId) {
    return false;
  }

  const normalizedModelId = modelId.trim().replace(/^models\//i, "");
  return (BLOCKED_ROUTING_MODELS[providerName] ?? []).some((pattern) =>
    pattern.test(normalizedModelId),
  );
}

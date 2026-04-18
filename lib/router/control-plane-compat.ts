import type { ProviderName } from "@/lib/router/model-intent";

export const CONTROL_PLANE_VERIFIED_MODEL_IDS: Record<ProviderName, string[]> = {
  openai: ["gpt-5.3-codex", "gpt-5.2-unified", "gpt-5.2", "o3-pro"],
  anthropic: ["claude-4.6-opus", "claude-4.5-sonnet", "claude-4-opus"],
  grok: ["grok-4-0709", "grok-4"],
  google: []
};

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

export function isControlPlaneInstructionCompatibleModel(providerName: ProviderName, modelId: string): boolean {
  const normalizedModel = normalizeModelId(modelId);
  const verifiedModels = CONTROL_PLANE_VERIFIED_MODEL_IDS[providerName];
  return verifiedModels.some((verifiedModel) => normalizeModelId(verifiedModel) === normalizedModel);
}

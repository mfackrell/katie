import type { ProviderName } from "@/lib/router/model-intent";

export type CostTier = "low" | "medium" | "high";

export type ModelPricingRow = {
  provider_name: ProviderName;
  model_id: string;
  input_cost_per_1m: number | null;
  output_cost_per_1m: number | null;
  cached_input_cost_per_1m: number | null;
  cached_output_cost_per_1m: number | null;
  supports_web_search: boolean | null;
  supports_vision: boolean | null;
  supports_video: boolean | null;
  supports_image_generation: boolean | null;
  reasoning_depth_tier: "low" | "medium" | "high" | null;
  speed_tier: "slow" | "medium" | "fast" | null;
  cost_tier: CostTier;
  source: string;
  source_url: string | null;
  source_updated_at: string | null;
  refreshed_at: string;
  is_active: boolean;
};

export type ModelPricingUpsertRow = Omit<ModelPricingRow, "is_active"> & { is_active?: boolean };

export type ProviderPricingAdapterResult = {
  providerName: ProviderName;
  source: string;
  sourceUrl: string | null;
  sourceUpdatedAt: string | null;
  rows: Array<{
    modelId: string;
    inputCostPer1M: number | null;
    outputCostPer1M: number | null;
    cachedInputCostPer1M: number | null;
    cachedOutputCostPer1M: number | null;
    supportsWebSearch: boolean | null;
    supportsVision: boolean | null;
    supportsVideo: boolean | null;
    supportsImageGeneration: boolean | null;
    reasoningDepthTier: "low" | "medium" | "high" | null;
    speedTier: "slow" | "medium" | "fast" | null;
  }>;
};

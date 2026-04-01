import { getAvailableProviders } from "@/lib/providers";
import { deriveCostTierFromPricing } from "@/lib/router/model-pricing/cost-tier";
import { fetchAnthropicPricing } from "@/lib/router/model-pricing/sources/anthropic";
import { fetchGooglePricing } from "@/lib/router/model-pricing/sources/google";
import { fetchGrokPricing } from "@/lib/router/model-pricing/sources/grok";
import { fetchOpenAiPricing } from "@/lib/router/model-pricing/sources/openai";
import { normalizeModelId } from "@/lib/router/model-pricing/sources/shared";
import { markInactiveModelPricing, upsertModelPricing } from "@/lib/router/model-pricing-store";
import type { ProviderName } from "@/lib/router/model-intent";
import type { ModelPricingUpsertRow, ProviderPricingAdapterResult } from "@/lib/router/model-pricing/types";

export type ModelPricingRefreshStats = {
  total_models_seen: number;
  total_rows_upserted: number;
  total_rows_marked_inactive: number;
  provider_errors: Array<{ provider: ProviderName; message: string }>;
};

type DiscoveryResult = Record<ProviderName, string[]>;

async function discoverModelsByProvider(): Promise<DiscoveryResult> {
  const discovered: DiscoveryResult = { openai: [], google: [], grok: [], anthropic: [] };
  const providers = getAvailableProviders();

  await Promise.all(
    providers.map(async (provider) => {
      try {
        discovered[provider.name] = (await provider.listModels()).map((modelId) => normalizeModelId(modelId));
      } catch {
        discovered[provider.name] = [];
      }
    })
  );

  return discovered;
}

function mergeDiscoveredWithPricing(discoveredModels: string[], pricing: ProviderPricingAdapterResult, refreshedAt: string): ModelPricingUpsertRow[] {
  const pricingMap = new Map(pricing.rows.map((row) => [normalizeModelId(row.modelId), row]));
  const mergedIds = new Set([...discoveredModels, ...pricingMap.keys()]);

  return Array.from(mergedIds).map((modelId) => {
    const priced = pricingMap.get(modelId);
    const inputCost = priced?.inputCostPer1M ?? null;
    const outputCost = priced?.outputCostPer1M ?? null;

    return {
      provider_name: pricing.providerName,
      model_id: modelId,
      input_cost_per_1m: inputCost,
      output_cost_per_1m: outputCost,
      cached_input_cost_per_1m: priced?.cachedInputCostPer1M ?? null,
      cached_output_cost_per_1m: priced?.cachedOutputCostPer1M ?? null,
      supports_web_search: priced?.supportsWebSearch ?? null,
      supports_vision: priced?.supportsVision ?? null,
      supports_video: priced?.supportsVideo ?? null,
      supports_image_generation: priced?.supportsImageGeneration ?? null,
      reasoning_depth_tier: priced?.reasoningDepthTier ?? null,
      speed_tier: priced?.speedTier ?? null,
      cost_tier: deriveCostTierFromPricing(inputCost, outputCost),
      source: pricing.source,
      source_url: pricing.sourceUrl,
      source_updated_at: pricing.sourceUpdatedAt,
      refreshed_at: refreshedAt,
      is_active: true
    };
  });
}

type RefreshDependencies = {
  discoverModelsByProvider?: () => Promise<DiscoveryResult>;
  adapters?: Array<{ provider: ProviderName; run: () => Promise<ProviderPricingAdapterResult> }>;
  upsert?: typeof upsertModelPricing;
  markInactive?: typeof markInactiveModelPricing;
};

export async function refreshModelPricing(deps: RefreshDependencies = {}): Promise<ModelPricingRefreshStats> {
  const refreshedAt = new Date().toISOString();
  const provider_errors: Array<{ provider: ProviderName; message: string }> = [];

  const discovered = await (deps.discoverModelsByProvider ?? discoverModelsByProvider)();
  const adapters: Array<{ provider: ProviderName; run: () => Promise<ProviderPricingAdapterResult> }> = deps.adapters ?? [
    { provider: "openai", run: fetchOpenAiPricing },
    { provider: "google", run: fetchGooglePricing },
    { provider: "anthropic", run: fetchAnthropicPricing },
    { provider: "grok", run: fetchGrokPricing }
  ];

  let totalRowsUpserted = 0;
  let totalRowsMarkedInactive = 0;

  for (const adapter of adapters) {
    const discoveredModels = discovered[adapter.provider] ?? [];
    try {
      const pricing = await adapter.run();
      const mergedRows = mergeDiscoveredWithPricing(discoveredModels, pricing, refreshedAt);
      totalRowsUpserted += await (deps.upsert ?? upsertModelPricing)(mergedRows);
      totalRowsMarkedInactive += await (deps.markInactive ?? markInactiveModelPricing)(adapter.provider, discoveredModels);
    } catch (error) {
      provider_errors.push({
        provider: adapter.provider,
        message: error instanceof Error ? error.message : "refresh_failed"
      });

      if (discoveredModels.length > 0) {
        totalRowsMarkedInactive += await (deps.markInactive ?? markInactiveModelPricing)(adapter.provider, discoveredModels);
      }
    }
  }

  return {
    total_models_seen: Object.values(discovered).reduce((sum, list) => sum + list.length, 0),
    total_rows_upserted: totalRowsUpserted,
    total_rows_marked_inactive: totalRowsMarkedInactive,
    provider_errors
  };
}

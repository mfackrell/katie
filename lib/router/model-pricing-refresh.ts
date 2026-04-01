import { getAvailableProviders } from "@/lib/providers";
import { deriveCostTierFromPricing, hasNumericPricing } from "@/lib/router/model-pricing/cost-tier";
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
  total_rows_complete: number;
  total_rows_metadata_only: number;
  total_rows_failed: number;
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
    const hasRealPricing = hasNumericPricing(inputCost, outputCost);

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
      cost_tier: hasRealPricing ? deriveCostTierFromPricing(inputCost, outputCost) : null,
      pricing_status: hasRealPricing ? "complete" : "metadata_only",
      source: pricing.source,
      source_url: pricing.sourceUrl,
      source_updated_at: pricing.sourceUpdatedAt,
      refreshed_at: refreshedAt,
      is_active: true
    };
  });
}

function buildFailedRows(provider: ProviderName, discoveredModels: string[], refreshedAt: string): ModelPricingUpsertRow[] {
  return discoveredModels.map((modelId) => ({
    provider_name: provider,
    model_id: modelId,
    input_cost_per_1m: null,
    output_cost_per_1m: null,
    cached_input_cost_per_1m: null,
    cached_output_cost_per_1m: null,
    supports_web_search: null,
    supports_vision: null,
    supports_video: null,
    supports_image_generation: null,
    reasoning_depth_tier: null,
    speed_tier: null,
    cost_tier: null,
    pricing_status: "failed",
    source: "adapter_error",
    source_url: null,
    source_updated_at: null,
    refreshed_at: refreshedAt,
    is_active: true
  }));
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
  let totalRowsComplete = 0;
  let totalRowsMetadataOnly = 0;
  let totalRowsFailed = 0;

  for (const adapter of adapters) {
    const discoveredModels = discovered[adapter.provider] ?? [];
    try {
      const pricing = await adapter.run();
      console.info(`[ModelPricingRefresh] provider=${adapter.provider} source=${pricing.source} source_url=${pricing.sourceUrl ?? "n/a"}`);
      const mergedRows = mergeDiscoveredWithPricing(discoveredModels, pricing, refreshedAt);
      const completeCount = mergedRows.filter((row) => row.pricing_status === "complete").length;
      const metadataOnlyCount = mergedRows.filter((row) => row.pricing_status === "metadata_only").length;
      console.info(
        `[ModelPricingRefresh] provider=${adapter.provider} complete=${completeCount} metadata_only=${metadataOnlyCount} failed=0`
      );
      totalRowsComplete += completeCount;
      totalRowsMetadataOnly += metadataOnlyCount;
      totalRowsUpserted += await (deps.upsert ?? upsertModelPricing)(mergedRows);
      totalRowsMarkedInactive += await (deps.markInactive ?? markInactiveModelPricing)(adapter.provider, discoveredModels);
    } catch (error) {
      provider_errors.push({
        provider: adapter.provider,
        message: error instanceof Error ? error.message : "refresh_failed"
      });
      const failedRows = buildFailedRows(adapter.provider, discoveredModels, refreshedAt);
      if (failedRows.length > 0) {
        totalRowsUpserted += await (deps.upsert ?? upsertModelPricing)(failedRows);
        totalRowsFailed += failedRows.length;
      }
      console.info(
        `[ModelPricingRefresh] provider=${adapter.provider} source=adapter_error complete=0 metadata_only=0 failed=${failedRows.length}`
      );

      if (discoveredModels.length > 0) {
        totalRowsMarkedInactive += await (deps.markInactive ?? markInactiveModelPricing)(adapter.provider, discoveredModels);
      }
    }
  }

  return {
    total_models_seen: Object.values(discovered).reduce((sum, list) => sum + list.length, 0),
    total_rows_upserted: totalRowsUpserted,
    total_rows_marked_inactive: totalRowsMarkedInactive,
    total_rows_complete: totalRowsComplete,
    total_rows_metadata_only: totalRowsMetadataOnly,
    total_rows_failed: totalRowsFailed,
    provider_errors
  };
}

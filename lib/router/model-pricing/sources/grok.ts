import type { ProviderPricingAdapterResult } from "@/lib/router/model-pricing/types";
import { fetchProviderPricingPage, normalizeModelId, parsePricingPairsFromHtml } from "@/lib/router/model-pricing/sources/shared";

const GROK_PRICING_URL = "https://docs.x.ai/docs/models";

export async function fetchGrokPricing(): Promise<ProviderPricingAdapterResult> {
  const { html, sourceUpdatedAt } = await fetchProviderPricingPage(GROK_PRICING_URL);
  const parsedRows = parsePricingPairsFromHtml(html);

  return {
    providerName: "grok",
    source: "xai-models-docs",
    sourceUrl: GROK_PRICING_URL,
    sourceUpdatedAt,
    rows: parsedRows.map((row) => ({
      modelId: normalizeModelId(row.modelId),
      inputCostPer1M: row.inputCostPer1M,
      outputCostPer1M: row.outputCostPer1M,
      cachedInputCostPer1M: null,
      cachedOutputCostPer1M: null,
      supportsWebSearch: null,
      supportsVision: null,
      supportsVideo: null,
      supportsImageGeneration: null,
      reasoningDepthTier: null,
      speedTier: null
    }))
  };
}

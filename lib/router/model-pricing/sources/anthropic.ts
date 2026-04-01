import type { ProviderPricingAdapterResult } from "@/lib/router/model-pricing/types";
import { fetchProviderPricingPage, normalizeModelId, parsePricingPairsFromHtml } from "@/lib/router/model-pricing/sources/shared";

const ANTHROPIC_PRICING_URL = "https://www.anthropic.com/pricing";

export async function fetchAnthropicPricing(): Promise<ProviderPricingAdapterResult> {
  const { html, sourceUpdatedAt } = await fetchProviderPricingPage(ANTHROPIC_PRICING_URL);
  const parsedRows = parsePricingPairsFromHtml(html);

  return {
    providerName: "anthropic",
    source: "anthropic-pricing-page",
    sourceUrl: ANTHROPIC_PRICING_URL,
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

import type { ProviderPricingAdapterResult } from "@/lib/router/model-pricing/types";
import { fetchProviderPricingPage, normalizeModelId, parsePricingPairsFromHtml } from "@/lib/router/model-pricing/sources/shared";

const OPENAI_PRICING_URL = "https://openai.com/api/pricing/";

export async function fetchOpenAiPricing(): Promise<ProviderPricingAdapterResult> {
  const { html, sourceUpdatedAt } = await fetchProviderPricingPage(OPENAI_PRICING_URL);
  const parsedRows = parsePricingPairsFromHtml(html);

  return {
    providerName: "openai",
    source: "openai-pricing-page",
    sourceUrl: OPENAI_PRICING_URL,
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

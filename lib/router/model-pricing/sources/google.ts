import type { ProviderPricingAdapterResult } from "@/lib/router/model-pricing/types";
import { fetchProviderPricingPage, normalizeModelId, parsePricingPairsFromHtml } from "@/lib/router/model-pricing/sources/shared";

const GOOGLE_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing";

export async function fetchGooglePricing(): Promise<ProviderPricingAdapterResult> {
  const { html, sourceUpdatedAt } = await fetchProviderPricingPage(GOOGLE_PRICING_URL);
  const parsedRows = parsePricingPairsFromHtml(html);

  return {
    providerName: "google",
    source: "google-gemini-pricing-page",
    sourceUrl: GOOGLE_PRICING_URL,
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

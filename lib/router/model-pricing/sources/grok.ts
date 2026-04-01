import type { ProviderPricingAdapterResult } from "@/lib/router/model-pricing/types";
import { fetchLiteLlmCatalog, MODEL_PRICES_CATALOG_URL, parseLiteLlmProviderRows } from "@/lib/router/model-pricing/sources/shared";

const GROK_PRICING_SOURCE = "litellm-model-prices-catalog";

export async function fetchGrokPricing(): Promise<ProviderPricingAdapterResult> {
  const { data, sourceUpdatedAt } = await fetchLiteLlmCatalog();

  return {
    providerName: "grok",
    source: GROK_PRICING_SOURCE,
    sourceUrl: MODEL_PRICES_CATALOG_URL,
    sourceUpdatedAt,
    rows: parseLiteLlmProviderRows("grok", data)
  };
}

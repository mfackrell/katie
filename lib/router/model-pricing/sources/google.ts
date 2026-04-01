import type { ProviderPricingAdapterResult } from "@/lib/router/model-pricing/types";
import { fetchLiteLlmCatalog, MODEL_PRICES_CATALOG_URL, parseLiteLlmProviderRows } from "@/lib/router/model-pricing/sources/shared";

const GOOGLE_PRICING_SOURCE = "litellm-model-prices-catalog";

export async function fetchGooglePricing(): Promise<ProviderPricingAdapterResult> {
  const { data, sourceUpdatedAt } = await fetchLiteLlmCatalog();

  return {
    providerName: "google",
    source: GOOGLE_PRICING_SOURCE,
    sourceUrl: MODEL_PRICES_CATALOG_URL,
    sourceUpdatedAt,
    rows: parseLiteLlmProviderRows("google", data)
  };
}

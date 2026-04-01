import type { ProviderPricingAdapterResult } from "@/lib/router/model-pricing/types";
import { fetchLiteLlmCatalog, MODEL_PRICES_CATALOG_URL, parseLiteLlmProviderRows } from "@/lib/router/model-pricing/sources/shared";

const OPENAI_PRICING_SOURCE = "litellm-model-prices-catalog";

export async function fetchOpenAiPricing(): Promise<ProviderPricingAdapterResult> {
  const { data, sourceUpdatedAt } = await fetchLiteLlmCatalog();

  return {
    providerName: "openai",
    source: OPENAI_PRICING_SOURCE,
    sourceUrl: MODEL_PRICES_CATALOG_URL,
    sourceUpdatedAt,
    rows: parseLiteLlmProviderRows("openai", data)
  };
}

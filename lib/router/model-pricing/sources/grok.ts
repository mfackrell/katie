import type { ProviderPricingAdapterResult } from "@/lib/router/model-pricing/types";
import {
  fetchLiteLlmCatalog,
  MODEL_PRICES_CATALOG_URL,
  parseLiteLlmProviderRows,
  summarizePricingRows
} from "@/lib/router/model-pricing/sources/shared";

const GROK_PRICING_SOURCE = "litellm-model-prices-catalog";

export async function fetchGrokPricing(): Promise<ProviderPricingAdapterResult> {
  console.info("[ModelPricingSource][FetchStart]", {
    provider: "grok",
    source: GROK_PRICING_SOURCE,
    sourceUrl: MODEL_PRICES_CATALOG_URL
  });

  const { data, sourceUpdatedAt } = await fetchLiteLlmCatalog();
  const rows = parseLiteLlmProviderRows("grok", data);
  const summary = summarizePricingRows(rows);

  console.info("[ModelPricingSource][ParseResult]", {
    provider: "grok",
    source: GROK_PRICING_SOURCE,
    sourceUrl: MODEL_PRICES_CATALOG_URL,
    rowCount: summary.totalRows,
    numericPricingRows: summary.numericPricingRows,
    nonNumericPricingRows: summary.nonNumericPricingRows
  });

  return {
    providerName: "grok",
    source: GROK_PRICING_SOURCE,
    sourceUrl: MODEL_PRICES_CATALOG_URL,
    sourceUpdatedAt,
    rows
  };
}

import type { ProviderPricingAdapterResult } from "@/lib/router/model-pricing/types";
import {
  fetchLiteLlmCatalog,
  MODEL_PRICES_CATALOG_URL,
  parseLiteLlmProviderRows,
  summarizePricingRows
} from "@/lib/router/model-pricing/sources/shared";

const GOOGLE_PRICING_SOURCE = "litellm-model-prices-catalog";

export async function fetchGooglePricing(): Promise<ProviderPricingAdapterResult> {
  console.info("[ModelPricingSource][FetchStart]", {
    provider: "google",
    source: GOOGLE_PRICING_SOURCE,
    sourceUrl: MODEL_PRICES_CATALOG_URL
  });

  const { data, sourceUpdatedAt } = await fetchLiteLlmCatalog();
  const rows = parseLiteLlmProviderRows("google", data);
  const summary = summarizePricingRows(rows);

  console.info("[ModelPricingSource][ParseResult]", {
    provider: "google",
    source: GOOGLE_PRICING_SOURCE,
    sourceUrl: MODEL_PRICES_CATALOG_URL,
    rowCount: summary.totalRows,
    numericPricingRows: summary.numericPricingRows,
    nonNumericPricingRows: summary.nonNumericPricingRows
  });

  return {
    providerName: "google",
    source: GOOGLE_PRICING_SOURCE,
    sourceUrl: MODEL_PRICES_CATALOG_URL,
    sourceUpdatedAt,
    rows
  };
}

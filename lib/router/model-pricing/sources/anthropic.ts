import type { ProviderPricingAdapterResult } from "@/lib/router/model-pricing/types";
import {
  fetchLiteLlmCatalog,
  MODEL_PRICES_CATALOG_URL,
  parseLiteLlmProviderRows,
  summarizePricingRows
} from "@/lib/router/model-pricing/sources/shared";

const ANTHROPIC_PRICING_SOURCE = "litellm-model-prices-catalog";

export async function fetchAnthropicPricing(): Promise<ProviderPricingAdapterResult> {
  console.info("[ModelPricingSource][FetchStart]", {
    provider: "anthropic",
    source: ANTHROPIC_PRICING_SOURCE,
    sourceUrl: MODEL_PRICES_CATALOG_URL
  });

  const { data, sourceUpdatedAt } = await fetchLiteLlmCatalog();
  const rows = parseLiteLlmProviderRows("anthropic", data);
  const summary = summarizePricingRows(rows);

  console.info("[ModelPricingSource][ParseResult]", {
    provider: "anthropic",
    source: ANTHROPIC_PRICING_SOURCE,
    sourceUrl: MODEL_PRICES_CATALOG_URL,
    rowCount: summary.totalRows,
    numericPricingRows: summary.numericPricingRows,
    nonNumericPricingRows: summary.nonNumericPricingRows
  });

  return {
    providerName: "anthropic",
    source: ANTHROPIC_PRICING_SOURCE,
    sourceUrl: MODEL_PRICES_CATALOG_URL,
    sourceUpdatedAt,
    rows
  };
}

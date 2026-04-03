import type { ProviderPricingAdapterResult } from "@/lib/router/model-pricing/types";
import type { ProviderName } from "@/lib/router/model-intent";

export function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

export function parseUsdPerMillion(label: string): number | null {
  const normalized = label.toLowerCase().replaceAll(",", "");
  const match = normalized.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function cleanHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

export function parsePricingPairsFromHtml(html: string): Array<{ modelId: string; inputCostPer1M: number | null; outputCostPer1M: number | null }> {
  const text = cleanHtml(html);
  const rows: Array<{ modelId: string; inputCostPer1M: number | null; outputCostPer1M: number | null }> = [];
  const regex = /([a-z0-9][a-z0-9._\-/]{2,})[^$]{0,120}\$\s*([0-9]+(?:\.[0-9]+)?)\s*(?:\/|per)?\s*1m[^$]{0,120}\$\s*([0-9]+(?:\.[0-9]+)?)\s*(?:\/|per)?\s*1m/gi;

  for (const match of text.matchAll(regex)) {
    rows.push({
      modelId: normalizeModelId(match[1]),
      inputCostPer1M: Number(match[2]),
      outputCostPer1M: Number(match[3])
    });
  }

  return rows;
}

export async function fetchProviderPricingPage(url: string): Promise<{ html: string; sourceUpdatedAt: string | null }> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Pricing source request failed (${response.status})`);
  }

  const html = await response.text();
  const sourceUpdatedAt = response.headers.get("last-modified");
  return { html, sourceUpdatedAt };
}

export function buildEmptyResult(providerName: ProviderName, source: string, sourceUrl: string): ProviderPricingAdapterResult {
  return {
    providerName,
    source,
    sourceUrl,
    sourceUpdatedAt: null,
    rows: []
  };
}

export const MODEL_PRICES_CATALOG_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

type LiteLlmCatalogEntry = {
  litellm_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  mode?: string;
};

type PricingRowSummary = {
  totalRows: number;
  numericPricingRows: number;
  nonNumericPricingRows: number;
};

export function summarizePricingRows(
  rows: Array<{ inputCostPer1M: number | null; outputCostPer1M: number | null }>
): PricingRowSummary {
  const numericPricingRows = rows.filter((row) => row.inputCostPer1M !== null || row.outputCostPer1M !== null).length;
  return {
    totalRows: rows.length,
    numericPricingRows,
    nonNumericPricingRows: rows.length - numericPricingRows
  };
}

export async function fetchLiteLlmCatalog(): Promise<{ data: Record<string, LiteLlmCatalogEntry>; sourceUpdatedAt: string | null }> {
  console.info("[ModelPricingSource][FetchStart]", {
    source: "litellm-model-prices-catalog",
    sourceUrl: MODEL_PRICES_CATALOG_URL
  });

  let response: Response;
  try {
    response = await fetch(MODEL_PRICES_CATALOG_URL, { cache: "no-store" });
  } catch (error) {
    console.error("[ModelPricingSource][FetchError]", {
      source: "litellm-model-prices-catalog",
      sourceUrl: MODEL_PRICES_CATALOG_URL,
      error: error instanceof Error ? error.message : "fetch_failed"
    });
    throw error;
  }

  const contentType = response.headers.get("content-type");
  if (!response.ok) {
    console.error("[ModelPricingSource][FetchError]", {
      source: "litellm-model-prices-catalog",
      sourceUrl: MODEL_PRICES_CATALOG_URL,
      status: response.status,
      contentType
    });
    throw new Error(`Pricing source request failed (${response.status})`);
  }

  let parsedSuccessfully = false;
  let data: Record<string, LiteLlmCatalogEntry>;
  try {
    data = (await response.json()) as Record<string, LiteLlmCatalogEntry>;
    parsedSuccessfully = true;
  } catch (error) {
    console.error("[ModelPricingSource][FetchError]", {
      source: "litellm-model-prices-catalog",
      sourceUrl: MODEL_PRICES_CATALOG_URL,
      status: response.status,
      contentType,
      parsedSuccessfully,
      error: error instanceof Error ? error.message : "json_parse_failed"
    });
    throw error;
  }

  const totalCatalogEntries = Object.keys(data).length;
  console.info("[ModelPricingSource][FetchSuccess]", {
    source: "litellm-model-prices-catalog",
    sourceUrl: MODEL_PRICES_CATALOG_URL,
    status: response.status,
    contentType,
    parsedSuccessfully,
    totalCatalogEntries
  });

  return { data, sourceUpdatedAt: response.headers.get("last-modified") };
}

function normalizeProviderName(provider: string | undefined): string {
  return (provider ?? "").trim().toLowerCase();
}

function toCostPer1M(perToken: number | undefined): number | null {
  if (typeof perToken !== "number" || !Number.isFinite(perToken) || perToken < 0) {
    return null;
  }
  return perToken * 1_000_000;
}

export function parseLiteLlmProviderRows(
  providerName: ProviderName,
  catalog: Record<string, LiteLlmCatalogEntry>
): ProviderPricingAdapterResult["rows"] {
  const rows = Object.entries(catalog)
    .filter(([, entry]) => normalizeProviderName(entry.litellm_provider) === providerName)
    .map(([modelId, entry]) => ({
      modelId: normalizeModelId(modelId),
      inputCostPer1M: toCostPer1M(entry.input_cost_per_token),
      outputCostPer1M: toCostPer1M(entry.output_cost_per_token),
      cachedInputCostPer1M: toCostPer1M(entry.cache_read_input_token_cost ?? entry.cache_creation_input_token_cost),
      cachedOutputCostPer1M: null,
      supportsWebSearch: null,
      supportsVision: entry.mode === "embedding" ? false : null,
      supportsVideo: null,
      supportsImageGeneration: null,
      reasoningDepthTier: null,
      speedTier: null
    }));

  const summary = summarizePricingRows(rows);
  console.info("[ModelPricingSource][ParseResult]", {
    source: "litellm-model-prices-catalog",
    sourceUrl: MODEL_PRICES_CATALOG_URL,
    provider: providerName,
    totalCatalogEntries: Object.keys(catalog).length,
    providerFilteredRowCount: rows.length,
    numericPricingRows: summary.numericPricingRows,
    nonNumericPricingRows: summary.nonNumericPricingRows
  });

  return rows;
}

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

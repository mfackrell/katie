import type { CostTier } from "@/lib/router/model-pricing/types";

const LOW_MAX_BLEND_PER_1M = 1;
const MEDIUM_MAX_BLEND_PER_1M = 8;

function toFinite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function deriveCostTierFromPricing(inputCostPer1M: number | null, outputCostPer1M: number | null): CostTier {
  const input = toFinite(inputCostPer1M);
  const output = toFinite(outputCostPer1M);

  if (input === null && output === null) {
    return "medium";
  }

  const blended = ((input ?? output ?? 0) + (output ?? input ?? 0)) / 2;

  if (blended <= LOW_MAX_BLEND_PER_1M) {
    return "low";
  }

  if (blended <= MEDIUM_MAX_BLEND_PER_1M) {
    return "medium";
  }

  return "high";
}

export function hasNumericPricing(inputCostPer1M: number | null, outputCostPer1M: number | null): boolean {
  return toFinite(inputCostPer1M) !== null || toFinite(outputCostPer1M) !== null;
}

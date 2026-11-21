import { getModelPrice, priceTokenUsage } from "@/lib/standalone-accounting/pricing";
import type { CandidateMetadata, RequestComplexity, RequestIntent } from "@/lib/router/model-intent";

/**
 * Best Value's emergency deterministic fallback. A missing/invalid judge does
 * not make legacy intent/provider reputation points into evidence of quality.
 * A classified high-depth objective must not be routed to an inadequate model
 * merely because its token price is low.
 *
 * This is deliberately a conservative CAPABILITY proxy, not a learned quality
 * score. The primary LLM quality qualification remains authoritative whenever
 * it succeeds. Price projections are labeled scenarios, never usage receipts.
 */
export function rankBestValueFallbackCandidates<T extends {
  providerName: CandidateMetadata["providerName"];
  modelId: string;
  metadata: CandidateMetadata;
}>(candidates: T[], options: {
  intent: RequestIntent;
  complexity: RequestComplexity | null | undefined;
  prompt: string;
  context: string;
}): Array<T & { modeledCostMicrousd: string | null; requiredDepth: "low" | "medium" | "high" }> {
  const highDepthIntents: RequestIntent[] = [
    "architecture-review", "technical-debugging", "code-review",
    "multimodal-reasoning", "assistant-reflection"
  ];
  // Without a trustworthy stage-one complexity assessment, do not assert a
  // short message is easy. Default to medium; even a terse continuation can be
  // contextually demanding. A verified low-complexity classification can
  // qualify economical low-tier models across all providers.
  const requiredDepth: "low" | "medium" | "high" =
    options.complexity === "high" || highDepthIntents.includes(options.intent)
      ? "high"
      : options.complexity === "low" ? "low" : "medium";
  const depthOrder = { low: 0, medium: 1, high: 2 };
  // A transparent, fixed scenario for relative fallback pricing, not the
  // prepared provider payload and not an observed outcome. Reviewed tiered
  // rates are always taken from the same immutable pricing snapshot.
  const projectedInputTokens = Math.max(512,
    Math.ceil((options.prompt.length + options.context.length + 1200) / 4));
  const projectedOutputTokens =
    requiredDepth === "high" ? 2048 : requiredDepth === "medium" ? 768 : 384;

  return candidates
    .filter(candidate => {
      // Legacy metadata can tag gpt-5-mini as high merely because the name
      // includes gpt-5. This naming collision is not high-depth evidence.
      const conservativeDepth = /mini|flash|haiku|lite/i.test(candidate.modelId)
        ? "low" : candidate.metadata.reasoning_depth_tier;
      return depthOrder[conservativeDepth] >= depthOrder[requiredDepth];
    })
    .map(candidate => {
      const price = getModelPrice(candidate.providerName, candidate.modelId);
      let modeledCostMicrousd: string | null = null;
      if (price && projectedInputTokens <= price.maxContextTokens &&
          projectedOutputTokens <= price.maxOutputTokens) {
        modeledCostMicrousd = priceTokenUsage(price, projectedInputTokens, projectedOutputTokens);
      }
      return { ...candidate, modeledCostMicrousd, requiredDepth };
    })
    .sort((a, b) => {
      if (a.modeledCostMicrousd === null) return b.modeledCostMicrousd === null
        ? (a.providerName + ":" + a.modelId).localeCompare(b.providerName + ":" + b.modelId) : 1;
      if (b.modeledCostMicrousd === null) return -1;
      const diff = BigInt(a.modeledCostMicrousd) - BigInt(b.modeledCostMicrousd);
      return diff < 0n ? -1 : diff > 0n ? 1 :
        (a.providerName + ":" + a.modelId).localeCompare(b.providerName + ":" + b.modelId);
    });
}

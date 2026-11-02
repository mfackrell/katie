import type { ChatGenerateParams, LlmProvider } from '@/lib/providers/types';
import { getAvailableProviders } from '@/lib/providers';
import { buildCandidateMetadata } from '@/lib/router/model-intent';
import { rankControlPlaneByActualCost } from '@/lib/router/control-plane-economics';
import { StandaloneAccountingError, createStandaloneLedger } from '@/lib/standalone-accounting/ledger';
import { loadStandalonePricing } from '@/lib/standalone-accounting/pricing-intake';
import type { PricingSnapshot } from '@/lib/standalone-accounting/pricing';

export type DocumentVisualCandidate = { provider: LlmProvider; modelId: string };

/** Price and capability must be verified against the EXACT model, never inherited
 * from the unrelated text-writing model. Discovery alone is not financial evidence. */
export function eligibleDocumentVisualCandidates(
  pricing: PricingSnapshot,
  available: Array<{ provider: LlmProvider; models: readonly string[] }>,
): DocumentVisualCandidate[] {
  const result: DocumentVisualCandidate[] = [];
  for (const { provider, models } of available) {
    const listed = new Set(models);
    for (const price of pricing.models) {
      if (price.provider !== provider.name || !price.vision || !listed.has(price.model)) continue;
      const capability = buildCandidateMetadata(provider.name, price.model, 'multimodal-reasoning');
      if (capability.supports_vision && !capability.supports_image_generation)
        result.push({ provider, modelId: price.model });
    }
  }
  return result;
}

/** Dry-run actual adapter preparation with both page images. Unsupported image
 * billing is filtered out BEFORE a paid attempt, with no speculative fallback.
 * The chosen call still passes through normal ledger admission and approvals. */
export async function selectDocumentVisualInspector(input: {
  params: Omit<ChatGenerateParams, 'modelId'>;
  activity: string;
  providers?: LlmProvider[];
  pricing?: PricingSnapshot;
}): Promise<DocumentVisualCandidate> {
  const providers = input.providers ?? getAvailableProviders();
  const pricing = input.pricing ?? await loadStandalonePricing(createStandaloneLedger());
  const available = await Promise.all(providers.map(async provider => {
    try { return { provider, models: await provider.listModels() }; }
    catch { return { provider, models: [] as string[] }; }
  }));
  const candidates = eligibleDocumentVisualCandidates(pricing, available);
  const ranked = await rankControlPlaneByActualCost(candidates, input.params, pricing, input.activity);
  if (!ranked.length) throw new StandaloneAccountingError(
    'no_priceable_document_vision',
    'No currently available document-inspection model has verified image pricing for these pages. No visual model was called and no files were delivered.',
  );
  const chosen = ranked[0];
  console.info('[DocumentVision] selected priced model', {
    activity: input.activity, provider: chosen.provider.name, model: chosen.modelId,
    eligibleCandidates: candidates.length,
  });
  return chosen;
}

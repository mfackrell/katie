import { AsyncLocalStorage } from 'node:async_hooks';
import { estimatePreparedRequest, type FrozenPreparedRequest } from '@/lib/standalone-accounting/estimate';
import { getAccountingScope } from '@/lib/standalone-accounting/context';
import { createStandaloneLedger } from '@/lib/standalone-accounting/ledger';
import { loadStandalonePricing } from '@/lib/standalone-accounting/pricing-intake';
import type { PricingSnapshot } from '@/lib/standalone-accounting/pricing';
import type { LlmProvider, ChatGenerateParams } from '@/lib/providers/types';

type Candidate = { provider: LlmProvider; modelId: string };
const preparation = new AsyncLocalStorage<{ prepared?: FrozenPreparedRequest }>();
export const isCapturingControlPlanePreparation = () => preparation.getStore() !== undefined;

/** Called at the serialized provider boundary, before admission or transmission.
 * A quote is not an attempt: it consumes no ordinal, reservation or provider call. */
export function captureControlPlanePreparation(prepared: FrozenPreparedRequest): void {
  const capture = preparation.getStore();
  if (!capture) return;
  capture.prepared = prepared;
  throw Object.assign(new Error('Preparation only; provider transmission prohibited.'), {
    code: 'standalone_preparation_only', terminal: true,
  });
}

export async function rankControlPlaneByActualCost(
  candidates: Candidate[], params: Omit<ChatGenerateParams, 'modelId'>,
  snapshot?: PricingSnapshot, activity?: string,
): Promise<Candidate[]> {
  // Developer Orchestrator retains its existing selection and accounting.
  const scope = getAccountingScope();
  if (scope?.kind !== 'standalone') return candidates;
  if (activity && !snapshot) {
    const ledger = createStandaloneLedger();
    const saved = await ledger.lookupAttempt(scope.context.userId, scope.context.requestId, `${activity}:${scope.counter.get(activity) ?? 0}`);
    if (saved) {
      const candidate = candidates.find(c => c.provider.name === saved.provider && c.modelId === saved.model);
      if (!candidate) throw Object.assign(new Error('The saved control-plane provider/model is no longer available for exact resume.'), {code:'standalone_saved_helper_unavailable',terminal:true});
      // Do not select a new economical model over approved or completed work.
      // Transport replays the saved response or dispatches its exact preparation.
      return [candidate, ...candidates.filter(c => c !== candidate)];
    }
  }
  const pricing = snapshot ?? await loadStandalonePricing(createStandaloneLedger());
  const priced: Array<{candidate: Candidate; cost: bigint; index: number}> = [];
  for (const [index, candidate] of candidates.entries()) {
    const capture: {prepared?: FrozenPreparedRequest} = {};
    try {
      await preparation.run(capture, () => candidate.provider.generate({...params, modelId: candidate.modelId}));
    } catch (error) {
      // SDKs wrap the terminal sentinel. Only the captured boundary payload is
      // evidence of successful preparation; no fallback or paid probe is used.
      if (!capture.prepared) continue;
    }
    const prepared = capture.prepared;
    if (!prepared || prepared.provider !== candidate.provider.name || prepared.model !== candidate.modelId) continue;
    const quote = estimatePreparedRequest(prepared, pricing);
    if (quote.status !== 'estimated' || quote.reservationMicrousd === null) continue;
    priced.push({candidate, cost: BigInt(quote.reservationMicrousd), index});
  }
  // All candidates already satisfy the same strict decision-task capability
  // contract. Actual input, adapter instructions and finite output are priced;
  // curated order is only a tie breaker. Normal admission still guards dispatch.
  return priced.sort((a,b) => a.cost < b.cost ? -1 : a.cost > b.cost ? 1 : a.index-b.index).map(x => x.candidate);
}

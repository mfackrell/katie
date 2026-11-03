import { estimatePreparedRequest, freezePreparedRequest, type FrozenPreparedRequest, type StandaloneEstimate } from './estimate';
import type { PricingSnapshot } from './pricing';

/** A narrow, owner-visible alternative for one otherwise unpriceable OpenAI
 * cache hint. The selected model, prompt, output allowance and tools stay
 * unchanged. Only optional cache metadata is removed before any paid send. */
export const OWNER_SELECTED_UNCACHED = 'selected_model_uncached' as const;
const UNREVIEWED_CACHE = 'No reviewed no-fee cache metadata policy for this exact model';
const UNREVIEWED_RETENTION = 'Unsupported OpenAI prompt_cache_retention for this exact model';
const CONTEXT_ISSUE = 'Estimated input plus output exceeds supported context window';

export function proposeSelectedModelUncached(
  original: FrozenPreparedRequest,
  pricing: PricingSnapshot,
): FrozenPreparedRequest | null {
  if (original.provider !== 'openai' ||
      original.payload.prompt_cache_key === undefined && original.payload.prompt_cache_retention === undefined) return null;
  const first = estimatePreparedRequest(original, pricing);
  // A byte-based context estimate is not proof of overflow. Permit only that
  // uncertainty to survive cache-hint removal so dispatch can count the final
  // immutable payload before offering an owner-approved uncached attempt.
  if (!first.issues.includes(UNREVIEWED_CACHE) ||
      first.issues.some(issue => issue !== UNREVIEWED_CACHE && issue !== UNREVIEWED_RETENTION && issue !== CONTEXT_ISSUE)) return null;
  const uncachedPayload = { ...original.payload };
  delete uncachedPayload.prompt_cache_key;
  delete uncachedPayload.prompt_cache_retention;
  const replacement = freezePreparedRequest(original.provider, original.model, original.endpoint, uncachedPayload);
  // Allow an estimated-only context issue through to the native-count preflight.
  // Missing prices, invalid output caps and every other unsupported dimension
  // must still block before any paid transmission or owner approval.
  const estimate = estimatePreparedRequest(replacement, pricing);
  if (estimate.issues.some(issue => issue !== CONTEXT_ISSUE)) return null;
  return replacement;
}

export function ownerSelectedUncachedEstimate(estimate: StandaloneEstimate, required: boolean): StandaloneEstimate {
  if (!required) return estimate;
  if (estimate.status !== 'estimated' || estimate.reservationMicrousd === null) return estimate;
  return Object.freeze({
    ...estimate,
    ownerApprovalRequired: OWNER_SELECTED_UNCACHED,
    estimatorVersion: 'standalone-selected-model-uncached-v1',
    assumptions: [...estimate.assumptions,
      'Owner authorization is required: the same model and complete prompt will run WITHOUT unreviewed optional OpenAI cache metadata. The quoted price assumes full standard uncached input and the entire output allowance; it is not a guaranteed invoice ceiling.'],
  });
}

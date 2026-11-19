import { getAccountingScope } from '@/lib/standalone-accounting/context';
import type { CurrentTurnFeedbackProvenanceV1 } from '@/lib/router/current-turn-feedback';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import { getModelPrice, priceTokenUsage } from '@/lib/standalone-accounting/pricing';
import { quoteSerializedRoutingRequest } from './control-plane-economics';
import type { CandidateMetadata } from './model-intent';
import type { ChatGenerateParams, LlmProvider } from '@/lib/providers/types';

export type ObservedRoutingRow = {
  request_id: string; observed_at: string; provider: string; model: string;
  status: 'pass' | 'fail' | 'unverified'; reason: string; intent: string;
  output_tokens: number | null; cache_hit_tokens: number | null; attempts: number;
  overhead_micro_usd?: string | null;
};
export type ObservedModelFeedback = {
  request_id: string; observed_at: string; provider: string; model: string; intent: string;
  source: 'message_reaction' | 'adjacent_user_feedback' | 'internal_review';
  dimension: string; outcome: 'positive' | 'negative' | 'ambiguous';
  confidence: string; source_id: string; task_excerpt?: string | null;
};
type Quality = {status: string; observations: Array<{source: string; provenance: string[]; sample_count: number;
  latest_observation: string; passes: number; failures: number; uncertainty: string}>;
  feedback?: {
    positive: number; negative: number; ambiguous: number;
    evidence: Array<{source: string; source_id: string; observed_at: string; dimension: string;
      outcome: string; confidence: string; task_excerpt: string | null; source_intent?: string}>;
    potentially_comparable?: Array<{source: string; source_id: string; observed_at: string; dimension: string;
      outcome: string; confidence: string; task_excerpt: string | null; source_intent: string}>;
    uncertainty: string;
  };
};
export type RoutingEvidence = {overhead: unknown; candidates: Record<string, {quality: Quality; economics: unknown}>};

/** Only categorical server audits for this task, actor and conversation are admitted.
 * Selection frequency, registry tiers and provider reputation are never quality scores. */
export function qualityFromObservations(rows: ObservedRoutingRow[], provider: string, model: string, intent: string, now = Date.now()): Quality {
  const matching = rows.filter(row => row.provider === provider && row.model === model && row.intent === intent &&
    ['pass','fail'].includes(row.status) && Number.isFinite(Date.parse(row.observed_at)) &&
    Date.parse(row.observed_at) <= now && Date.parse(row.observed_at) >= now - 30 * 86400000);
  if (!matching.length) return {status: 'unknown', observations: []};
  return {status: 'limited observed delivery evidence; answer correctness unknown', observations: [{
    source: 'standalone_workflows.checkpoints.routing-delivery-audit:v1',
    provenance: matching.map(row => row.request_id), sample_count: matching.length,
    latest_observation: matching.map(row => row.observed_at).sort().at(-1)!,
    passes: matching.filter(row => row.status === 'pass').length,
    failures: matching.filter(row => row.status === 'fail').length,
    uncertainty: 'Observational and selection-biased, not a controlled comparison. Explicit deliverable presence only; no correctness, style or general quality score.',
  }]};
}


/** Delivery presence is not response quality. Existing user reactions, clearly
 * attributed next-turn feedback and internal reviews are distinct evidence,
 * never a numerical ranking or a guarantee about a different task. */
export function modelAttributedFeedback(
  rows: ObservedModelFeedback[], provider: string, model: string, intent: string,
  now = Date.now(), bestValueComparable = false
): Quality['feedback'] | undefined {
  const matchesModel = (observed: string) => observed === model ||
    (observed.startsWith(model + '-') && /^\d{4}-\d{2}-\d{2}$/.test(observed.slice(model.length+1)));
  // Best Answer retains exact-intent matching. Best Value may surface
  // nearby conversational labels only when the original task excerpt exists;
  // the selector still must establish actual objective-level comparability.
  // Never admit coding/financial evidence merely because the model is identical.
  const conversational = new Set(['general-text','social-emotional','safety-sensitive-vision','assistant-reflection']);
  const isRelated = (row: ObservedModelFeedback) => row.intent === intent ||
    (bestValueComparable && conversational.has(intent) && conversational.has(row.intent) &&
      Boolean(row.task_excerpt?.trim()));
  const relevant = rows.filter(row => row.provider === provider && matchesModel(row.model) &&
    isRelated(row) && ['positive','negative','ambiguous'].includes(row.outcome) &&
    Number.isFinite(Date.parse(row.observed_at)) &&
    Date.parse(row.observed_at) <= now && Date.parse(row.observed_at) >= now - 30 * 86400000)
    .sort((a,b) => Date.parse(b.observed_at) - Date.parse(a.observed_at)).slice(0,12);
  if (!relevant.length) return undefined;
  // Different intent labels do not establish quality equivalence. Keep
  // their raw events separate until the existing selection LLM compares
  // original task excerpts and material response requirements.
  const direct = relevant.filter(row => row.intent === intent);
  const possible = bestValueComparable ? relevant.filter(row => row.intent !== intent) : [];
  const event = (row: ObservedModelFeedback) => ({
    source: row.source, source_id: row.source_id, observed_at: row.observed_at,
    dimension: row.dimension, outcome: row.outcome, confidence: row.confidence,
    task_excerpt: row.task_excerpt?.slice(0,160) ?? null,
    ...(bestValueComparable ? {source_intent: row.intent} : {}),
  });
  return {
    positive: direct.filter(row => row.outcome === 'positive').length,
    negative: direct.filter(row => row.outcome === 'negative').length,
    ambiguous: direct.filter(row => row.outcome === 'ambiguous').length,
    evidence: direct.map(event),
    ...(possible.length ? {potentially_comparable: possible.map(row => ({
      ...event(row),source_intent:row.intent,
    }))} : {}),
    uncertainty: bestValueComparable
      ? 'Direct evidence is scoped to the current intent. Cross-intent events are only ' +
        'potential comparisons; the selector must verify actual objective and quality-requirement similarity ' +
        'before using them. Reactions and adjacent comments may be ambiguous. Internal reviews are ' +
        'selection-biased. No evidence implies global model superiority.'
      : 'User reactions and context-attributed comments are task-specific and can be ambiguous. ' +
        'Review verdicts are internal and selection-biased. No evidence implies global model superiority; ' +
        'the same model alias can resolve to a dated version shown in the underlying provider receipt.',
  };
}

export function expectedCost(provider: LlmProvider['name'], model: string,
  quote: NonNullable<Awaited<ReturnType<typeof quoteSerializedRoutingRequest>>>, rows: ObservedRoutingRow[], overhead: string | null) {
  const price = getModelPrice(provider, model);
  const valid = rows.filter(row => row.provider === provider && row.model === model &&
    Number.isSafeInteger(row.output_tokens) && row.output_tokens! >= 0 &&
    Number.isSafeInteger(row.cache_hit_tokens) && row.cache_hit_tokens! >= 0 &&
    Number.isSafeInteger(row.attempts) && row.attempts > 0);
  const mean = (get: (row: ObservedRoutingRow) => number) => Math.ceil(valid.reduce((sum,row) => sum + get(row),0) / valid.length);
  const output = valid.length ? Math.min(quote.outputAllowance, mean(row => row.output_tokens!)) : null;
  const cache = valid.length ? Math.min(quote.inputTokens, mean(row => row.cache_hit_tokens!)) : null;
  const attempts = valid.length ? mean(row => row.attempts) : null;
  let expected: string | null = null;
  if (price && quote.status === 'estimated' && output !== null && cache !== null && attempts !== null && overhead !== null) {
    // Keep non-token dimensions (media/tool/cache-write fees) from the native quote.
    try {
      const tokenCeiling = BigInt(priceTokenUsage(price, quote.inputTokens, quote.outputAllowance));
      const extra = BigInt(quote.estimatedCostMicrousd!) - tokenCeiling;
      const tokens = BigInt(priceTokenUsage(price, quote.inputTokens, output, cache));
      expected = ((tokens + (extra > 0n ? extra : 0n)) * BigInt(attempts) + BigInt(overhead)).toString();
    } catch { /* Unsupported cache dimension remains unknown. */ }
  }
  const overheadSamples = rows.filter(row => typeof row.overhead_micro_usd === 'string' && /^\d+$/.test(row.overhead_micro_usd));
  const historicalOverhead = overheadSamples.length ? (overheadSamples.reduce((sum,row) => sum + BigInt(row.overhead_micro_usd!),0n) + BigInt(overheadSamples.length - 1)) / BigInt(overheadSamples.length) : null;
  const projectedOverhead = historicalOverhead !== null && overhead !== null
    ? (historicalOverhead > BigInt(overhead) ? historicalOverhead : BigInt(overhead)) : null;
  const allIn = expected !== null && projectedOverhead !== null && overhead !== null
    ? (BigInt(expected) - BigInt(overhead) + projectedOverhead).toString() : null;
  return {source: 'serialized provider preparation and scoped observed receipts', serialized_request: quote,
    unresolved_enrichment: ['Selected-model runtime metadata', 'Later chunked attachment analysis, collaboration/research and review results'],
    expected_output_tokens: output, expected_cache_hit_tokens: cache, expected_attempts: attempts,
    sample_count: valid.length, provenance: valid.map(row => row.request_id),
    latest_observation: valid.map(row => row.observed_at).sort().at(-1) ?? null,
    control_plane_observed_micro_usd: overhead, expected_generation_plus_observed_overhead_micro_usd: expected, expected_all_in_micro_usd: allIn,
    expected_total_control_plane_micro_usd: projectedOverhead?.toString() ?? null, overhead_sample_count: overheadSamples.length,
    uncertainty: 'Historical means are not guarantees. No samples means unknown, never zero. Serialized quote reserves full output and no cache hits. All-in scenario uses the greater of current observed overhead and historical same-task total helper spend, including routing/review/retries. Future overhead and later context enrichment can differ; without observed overhead samples the all-in expectation is unknown.',
  };
}

export async function resolveRoutingEvidence(candidates: CandidateMetadata[], providers: LlmProvider[],
  params: Omit<ChatGenerateParams, 'modelId'> | undefined, intent: string,
  bestValueQuality = false,
  currentTurnFeedback?: CurrentTurnFeedbackProvenanceV1 | null): Promise<RoutingEvidence> {
  const scope = getAccountingScope();
  const result: RoutingEvidence = {overhead: {status: 'unknown'}, candidates: {}};
  if (scope?.kind !== 'standalone') return result;
  let rows: ObservedRoutingRow[] = [], overhead: string | null = null;
  let feedbackRows: ObservedModelFeedback[] = [];
  try {
    const {data,error} = await getSupabaseAdminClient().rpc<{observations: ObservedRoutingRow[]; overhead_micro_usd: string | null; quality_feedback?: ObservedModelFeedback[]}>(
      'standalone_routing_observations', {p_owner: scope.context.userId, p_actor: scope.context.actorId,
        p_chat: scope.context.chatId, p_request: scope.context.requestId, p_intent: intent});
    if (!error && data) { rows = data.observations ?? []; overhead = data.overhead_micro_usd; feedbackRows = data.quality_feedback ?? []; }
  } catch { /* Missing/unavailable evidence must never invent quality or block chat. */ }
  // Best Value alone receives broader, explicitly attributed conversational
  // feedback. This private read-only RPC does not modify the legacy evidence
  // payload or inputs used by Best Answer.
  if (bestValueQuality) {
    try {
      const {data,error} = await getSupabaseAdminClient().rpc<ObservedModelFeedback[]>(
        'standalone_best_value_quality_feedback', {p_owner:scope.context.userId,
          p_actor:scope.context.actorId,p_chat:scope.context.chatId,p_request:scope.context.requestId});
      if (!error && Array.isArray(data)) {
        const keyed = new Map<string,ObservedModelFeedback>();
        for (const row of [...feedbackRows,...data]) {
          keyed.set(`${row.source}:${row.source_id}:${row.request_id}`, row);
        }
        feedbackRows=[...keyed.values()];
      }
    } catch { /* Unavailable quality feedback must not break routing. */ }
  }
  // The present correction may arrive before saveMessage. Admit it only when
  // the trusted scoped provenance links it to a prior completed assistant.
  // Never infer praise from silence or attach criticism to the NEXT model.
  const currentPolarity=currentTurnFeedback?.source.polarity;
  if (bestValueQuality && currentTurnFeedback?.target.status === 'attributed' &&
      currentPolarity && currentPolarity !== 'none' &&
      currentTurnFeedback.source.requestId === scope.context.requestId) {
    const {source,target}=currentTurnFeedback;
    feedbackRows=[...feedbackRows,{
      request_id:target.priorRequestId, observed_at:new Date().toISOString(),
      provider:target.provider, model:target.model, intent:target.priorIntent ?? intent,
      source:'adjacent_user_feedback',
      dimension:source.dimension, outcome:currentPolarity,
      confidence:'direct_current_turn_scoped_settled_reply',
      source_id:source.userMessageId ?? `current-request:${source.requestId}`,
      task_excerpt:source.textExcerpt,
    }];
  }
  result.overhead = {source: 'standalone_provider_attempts settled receipts for current scoped request',
    observed_micro_usd: overhead, remaining_overhead: 'unknown; stage two and later helpers have not completed'};
  for (const candidate of candidates) {
    const provider = providers.find(p => p.name === candidate.providerName);
    const quote = provider && params ? await quoteSerializedRoutingRequest(provider, {...params, modelId: candidate.modelId, requestIntent: intent}) : null;
    result.candidates[`${candidate.providerName}:${candidate.modelId}`] = {
      quality: (() => {
        const delivery = qualityFromObservations(rows, candidate.providerName, candidate.modelId, intent);
        const feedback = modelAttributedFeedback(feedbackRows, candidate.providerName, candidate.modelId,
          intent, Date.now(), bestValueQuality);
        return feedback ? {...delivery, status: 'limited, model-attributed task feedback; answer quality not independently verified', feedback} : delivery;
      })(),
      economics: quote ? expectedCost(candidate.providerName, candidate.modelId, quote, rows.filter(row => row.intent === intent), overhead)
        : {status: 'unknown', reason: 'No serialized candidate request available; no synthetic text-only quote'},
    };
  }
  return result;
}

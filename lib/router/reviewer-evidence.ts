import { getAccountingScope } from '@/lib/standalone-accounting/context';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';

/** Only the aggregate RPC projects private audits. Never send raw audits to routing. */
export async function resolveReviewerRoutingEvidence(intent: string,
  candidates: Array<{providerName: string; modelId: string}>) {
  const unknown = {status: 'unknown', observations: [], uncertainty:
    'No qualified same-task reviewer evidence available. Missing exact request-bound classified intent, independent assessment, or verdict bound to the delivered answer; absence is not failure.'};
  const scope = getAccountingScope();
  if (scope?.kind !== 'standalone') return unknown;
  try {
    const {data, error} = await getSupabaseAdminClient().rpc<{
      observations: Array<{provider: string; model: string; sample_count: number; approvals: number; revisions: number;
        first_observation: string; latest_observation: string}>;
    }>('standalone_routing_reviewer_evidence', {
      p_owner: scope.context.userId, p_actor: scope.context.actorId, p_chat: scope.context.chatId,
      p_request: scope.context.requestId, p_intent: intent,
    });
    if (error || !Array.isArray(data?.observations)) return unknown;
    // Explicit projection also protects the LLM boundary from unexpected RPC fields.
    const observations = data.observations.filter(row => candidates.some(candidate =>
      candidate.providerName === row.provider && candidate.modelId === row.model)).map(row => ({
      provider: row.provider, model: row.model, sample_count: row.sample_count,
      approvals: row.approvals, revisions: row.revisions,
      first_observation: row.first_observation, latest_observation: row.latest_observation,
      provenance: 'independent_model_reviewer_with_prior_assessment',
    }));
    return observations.length ? {status: 'limited reviewer verdict evidence', observations,
      window_days: 30, maximum_reviews: 100,
      uncertainty: 'Selection-biased reviewed answers in this owner/actor/chat and classified task only; small samples and reviewer disagreement limit generalization. Verdicts are judgments, not ground truth or a cross-model benchmark. Do not rank by approval percentage; compare task fit, uncertainty and native economics. Delivery checks are separate from correctness.'} : unknown;
  } catch { return unknown; }
}

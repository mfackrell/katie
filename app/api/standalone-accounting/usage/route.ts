import { standaloneTechnicalBlocker } from '@/lib/standalone-accounting/context';
import { QWEN_STILL_POLICY } from '@/lib/standalone-accounting/runpod-policy';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { type DailyAttempt } from '@/lib/standalone-accounting/daily';
import type { FrozenPreparedRequest, StandaloneEstimate } from '@/lib/standalone-accounting/estimate';
import { accountingError, accountingScope, noStore, scopeSchema } from '../_shared';

export async function GET(request: NextRequest) {
  try {
    const scope = scopeSchema.extend({ scope: z.enum(['this-agent', 'all']).default('this-agent'),before:z.string().datetime({offset:true}).optional(),beforeId:z.string().uuid().optional() }).refine(value=>Boolean(value.before)===Boolean(value.beforeId),'Both cursor fields are required.').parse(Object.fromEntries(request.nextUrl.searchParams));
    const { ownerId, ledger } = await accountingScope(request, scope);
    const snapshot = await ledger.usageSnapshot(ownerId,scope.actorId,scope.chatId,scope.scope==='all',scope.before??null,scope.beforeId??null);
    const attempts: DailyAttempt[] = snapshot.attempts.map(attempt => ({ id: attempt.id, actor_id: attempt.actor_id, chat_id: attempt.chat_id, provider: attempt.provider, model: attempt.model, resolved_model: attempt.resolved_model, uncertainty_reason: 'uncertainty_reason' in attempt && typeof attempt.uncertainty_reason === 'string' ? attempt.uncertainty_reason : null, category: attempt.category, state: attempt.state, created_at: attempt.created_at, dispatched_at: attempt.dispatched_at, settled_at: attempt.settled_at, reserved_microusd: attempt.reserved_microusd, actual_microusd: attempt.actual_microusd, usage: attempt.usage as DailyAttempt['usage'] }));
    const daily = snapshot.daily ? {...snapshot.daily,attempts:snapshot.daily.attempts.map(({id,actor_id,chat_id,provider,model,category,state,created_at,dispatched_at,settled_at,reserved_microusd,actual_microusd,usage})=>({id,actor_id,chat_id,provider,model,category,state,created_at,dispatched_at,settled_at,reserved_microusd,actual_microusd,usage}))} : null;
    const workflows = new Map(snapshot.attempts.map(attempt=>{const flag=snapshot.flags[attempt.id];return [attempt.request_id,{status:flag?.status,reason:standaloneTechnicalBlocker(flag?.error)?flag.error:undefined}] as const;}));
    const accepted = new Map(snapshot.attempts.map(attempt=>[attempt.id,snapshot.flags[attempt.id]?.accepted??false]));
    const autoAuthorized = (id:string) => snapshot.flags[id]?.automatic === true && accepted.get(id) === true;
    const active = await Promise.all(snapshot.attempts.filter(attempt => attempt.actor_id === scope.actorId && attempt.chat_id === scope.chatId && ['reserved', 'dispatched', 'uncertain'].includes(attempt.state) && !attempt.cancelled_by_owner_at).map(async attempt => ({
      id: attempt.id, createdAt:attempt.created_at, requestId: attempt.request_id, provider: attempt.provider, model: attempt.model, category: attempt.category, state: attempt.state,
      preparedHash: attempt.prepared_hash, pricingVersion: attempt.pricing_version, budgetRevision: attempt.budget_revision, reservedMicrousd: attempt.reserved_microusd,
      continuationBlockedReason: workflows.get(attempt.request_id)?.reason,
      parentStatus: workflows.get(attempt.request_id)?.status ?? 'unavailable',
      uncertainAutoAuthorized: autoAuthorized(attempt.id),
      cancellationActionable: !autoAuthorized(attempt.id) && (workflows.get(attempt.request_id)?.status === 'paused' || (workflows.get(attempt.request_id)?.status === 'running' && attempt.state !== 'uncertain')),
      continuationActionable: !autoAuthorized(attempt.id) && workflows.get(attempt.request_id)?.status === 'paused' && !workflows.get(attempt.request_id)?.reason,
      pollableRunpod: attempt.provider==='runpod'&&attempt.model===QWEN_STILL_POLICY.model&&attempt.pricing_version===QWEN_STILL_POLICY.version&&!!attempt.provider_request_id&&/^[A-Za-z0-9-]{8,150}$/.test(attempt.provider_request_id)&&!attempt.response_checkpoint&&!snapshot.flags[attempt.id]?.conflict,
      exposureAccepted: accepted.get(attempt.id) ?? false,
    })));
    // Only expose actionable attempts from this saved conversation. Daily aggregate can span standalone actors.
    const pending = snapshot.attempts.filter(attempt => attempt.actor_id === scope.actorId && attempt.chat_id === scope.chatId && attempt.state === 'paused').map(attempt => {
      const prepared = attempt.prepared_payload as unknown as FrozenPreparedRequest;
      const estimate = attempt.preflight_estimate as unknown as StandaloneEstimate;
      let textBytes = 0, imageCount = 0, imageBytes = 0;
      const size = (value: unknown): void => {
        if (typeof value === 'string') { textBytes += Buffer.byteLength(value, 'utf8'); return; }
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach(size); return; }
        const object = value as Record<string, unknown>;
        const inline = (object.inlineData ?? object.inline_data ?? object.source) as Record<string, unknown> | undefined;
        const imageUrl = typeof object.image_url === 'string' ? object.image_url : object.image_url && typeof object.image_url === 'object' ? (object.image_url as Record<string, unknown>).url : undefined;
        if (['input_image', 'image_url', 'image'].includes(String(object.type)) || object.inlineData || object.inline_data) {
          imageCount++;
          const data = typeof inline?.data === 'string' ? inline.data : typeof imageUrl === 'string' && imageUrl.startsWith('data:') ? imageUrl.slice(imageUrl.indexOf(',') + 1) : null;
          if (data !== null) imageBytes += Buffer.byteLength(data, 'base64');
          return;
        }
        Object.values(object).forEach(size);
      };
      size(prepared.payload);
      const savedPreview=(attempt as unknown as {preview?:{textBytes:number;imageCount:number;imageBytes:number}}).preview;
      if(savedPreview){textBytes=savedPreview.textBytes;imageCount=savedPreview.imageCount;imageBytes=savedPreview.imageBytes;}
      const requestExposure = snapshot.requestTotals[attempt.request_id];
      return {
      id: attempt.id, createdAt:attempt.created_at, requestId: attempt.request_id, provider: attempt.provider, model: attempt.model, category: attempt.category,
      preparedHash: attempt.prepared_hash, pricingVersion: attempt.pricing_version, budgetRevision: attempt.budget_revision,
      reservedMicrousd: attempt.reserved_microusd, reason: attempt.reason, pauseReason: attempt.pause_reason, resolvedModel: attempt.resolved_model, estimatorVersion: attempt.estimator_version, tradeoffs: attempt.tradeoffs,
      preview: { textBytes, imageCount, imageBytes, inputTokens: estimate.inputTokens, imageTokens: estimate.imageTokens, outputAllowance: estimate.outputAllowance, assumptions: estimate.assumptions, issues: estimate.issues, status: estimate.status },
      requestExposure,
    }; });
    const scopedAttempts = attempts.filter(attempt => scope.scope === 'all' || attempt.actor_id === scope.actorId);
    const alerts = scopedAttempts.flatMap<{ attemptId: string; provider: string; model: string; kind: string; message: string; actualMicrousd: string | null; reservedMicrousd: string }>(attempt => {
      const base = { attemptId: attempt.id, provider: attempt.provider, model: attempt.model };
      if (attempt.actual_microusd !== null && BigInt(attempt.actual_microusd) > BigInt(attempt.reserved_microusd)) return [{ ...base, kind: 'overrun', message: 'Settled cost exceeds the preflight reservation. Further automatic attempts on this request are blocked.', actualMicrousd: attempt.actual_microusd, reservedMicrousd: attempt.reserved_microusd }];
      if (attempt.state === 'uncertain') return [{ ...base, kind: 'uncertain', message: attempt.uncertainty_reason || 'Provider outcome or usage is unknown. Reservation remains held; automatic replay is blocked.', actualMicrousd: null, reservedMicrousd: attempt.reserved_microusd }];
      return [];
    });
    alerts.push(...(snapshot.alerts??[]).filter(alert=>!alerts.some(existing=>existing.attemptId===alert.attemptId&&existing.kind===alert.kind)));
    for (const event of snapshot.attempts.filter(a=>snapshot.flags[a.id]?.conflict).map(a=>({attempt_id:a.id,kind:'receipt_conflict'}))) {
      const attempt = scopedAttempts.find(row => row.id === event.attempt_id);
      if (event.kind === 'receipt_conflict' && attempt && !alerts.some(a=>a.kind==='receipt_conflict'&&a.attemptId===attempt.id)) alerts.push({ attemptId: attempt.id, provider: attempt.provider, model: attempt.model, kind: 'receipt_conflict', message: 'Conflicting provider receipt evidence requires reconciliation. Saved costs were not silently overwritten.', actualMicrousd: attempt.actual_microusd, reservedMicrousd: attempt.reserved_microusd });
    }
    const last=snapshot.attempts.length===100?snapshot.attempts[snapshot.attempts.length-1]:null;
    const workPage={next:last?{before:last.created_at,beforeId:last.id}:null};
    return NextResponse.json({ workPage, configuration: snapshot.configuration, scope: scope.scope, daily, pending, active, alerts }, { headers: noStore });
  } catch (error) { return accountingError(error); }
}

import { loadStandalonePricing } from "@/lib/standalone-accounting/pricing-intake";
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { reducePreparedRequest } from '@/lib/standalone-accounting/reduction';
import type { FrozenPreparedRequest } from '@/lib/standalone-accounting/estimate';
import { cancelStandaloneAttempt } from '@/lib/standalone-accounting/dispatch';
import { accountingError, accountingScope, noStore, scopeSchema } from '../_shared';

const decision = scopeSchema.extend({ attemptId: z.string().uuid(), action: z.enum(['approve_once', 'reduce_cost', 'cancel']), preparedHash: z.string().regex(/^[a-f0-9]{64}$/), pricingVersion: z.string().min(1).max(200), budgetRevision: z.number().int().nonnegative(), reservedMicrousd: z.string().regex(/^\d+$/) }).strict();
export async function POST(request: NextRequest) {
  try {
    const input = decision.parse(await request.json());
    const { ownerId, ledger } = await accountingScope(request, input);
    const snapshot = await ledger.snapshot(ownerId);
    const attempt = snapshot.attempts.find(row => row.id === input.attemptId && row.actor_id === input.actorId && row.chat_id === input.chatId);
    if (!attempt) return NextResponse.json({ error: 'Attempt unavailable.' }, { status: 404, headers: noStore });
    if (attempt.prepared_hash !== input.preparedHash || attempt.pricing_version !== input.pricingVersion || attempt.budget_revision !== input.budgetRevision || attempt.reserved_microusd !== input.reservedMicrousd) {
      return NextResponse.json({ error: 'This proposal changed. Refresh and review its current estimate.' }, { status: 409, headers: noStore });
    }
    if (input.action === 'approve_once') {
      const approved = await ledger.approve({ ownerId, attemptId: attempt.id, preparedHash: attempt.prepared_hash, pricingVersion: attempt.pricing_version, budgetRevision: attempt.budget_revision, reservedMicrousd: attempt.reserved_microusd });
      return NextResponse.json({ attemptId: approved.id, requestId: approved.request_id, state: approved.state }, { headers: noStore });
    }
    if (input.action === 'cancel') {
      const cancelled = await cancelStandaloneAttempt(ownerId, attempt.id);
      const exposureHeld = cancelled.state !== 'cancelled' && cancelled.actual_microusd === null;
      const message = cancelled.state === 'cancelled' ? 'Attempt cancelled before dispatch.' : exposureHeld ? 'Cancellation requested for remaining work. This attempt was already dispatched; its spending exposure remains held until provider usage is reconciled.' : 'Cancellation requested for remaining work. Recorded provider cost remains visible.';
      return NextResponse.json({ attemptId: cancelled.id, state: cancelled.state, cancellationRequested: true, heldExposureMicrousd: exposureHeld ? cancelled.reserved_microusd : '0', message }, { headers: noStore });
    }
    if (attempt.state !== 'paused') return NextResponse.json({ error: 'Only a paused proposal can be reduced.' }, { status: 409, headers: noStore });
    const pricing=await loadStandalonePricing(ledger,attempt.pricing_version);
    const reduced = reducePreparedRequest(attempt.prepared_payload as unknown as FrozenPreparedRequest,{},pricing);
    if (reduced.estimate.status !== 'estimated' || reduced.estimate.reservationMicrousd === null || BigInt(reduced.estimate.reservationMicrousd) >= BigInt(attempt.reserved_microusd) || reduced.changes.length === 0) {
      return NextResponse.json({ error: 'No smaller supported proposal is available. Cancel this attempt and revise the request or budget settings.' }, { status: 409, headers: noStore });
    }
    await ledger.registerPricing(pricing.version,pricing);
    const revised = await ledger.revise(ownerId, attempt.id, { preparedHash: reduced.revised.hash, preparedPayload: reduced.revised as unknown as Record<string, unknown>, pricingVersion: reduced.estimate.pricingVersion, reservedMicrousd: reduced.estimate.reservationMicrousd, tradeoffs: reduced.tradeoffs.join(' ') || 'Duplicate context was removed; the remaining request is unchanged.', preflightEstimate: reduced.estimate, estimatorVersion: reduced.estimate.estimatorVersion });
    return NextResponse.json({ attemptId: revised.id, requestId: revised.request_id, state: revised.state, estimateMicrousd: revised.reserved_microusd, changes: reduced.changes, tradeoffs: reduced.tradeoffs }, { headers: noStore });
  } catch (error) { return accountingError(error); }
}

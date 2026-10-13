import { NextRequest, NextResponse } from 'next/server';
import { assertCronAuth } from '@/lib/runpod/durable-results';
import { startSyntheticValidation, syntheticStatus, cleanupSyntheticValidation } from '@/lib/runpod/synthetic-validation';

// Temporary WP4 bridge. Remove this route and its schedule after the live test.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const headers = { 'cache-control': 'no-store' };

function allowed(value: unknown, values: string[]) {
  return typeof value === 'string' && values.includes(value) ? value : 'unknown';
}

export async function GET(request: NextRequest) {
  if (!assertCronAuth(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers });
  if (process.env.RUNPOD_SYNTHETIC_VALIDATION_ENABLED !== 'true') {
    return NextResponse.json({ error: 'disabled' }, { status: 404, headers });
  }
  try {
    let observed = await syntheticStatus();
    if (observed.status === 'not_started') {
      // The database singleton, including failed/cleaned claims, is authoritative.
      // Concurrent ticks may both reach here; only its winner can submit.
      await startSyntheticValidation();
      observed = await syntheticStatus();
    }
    if (observed.status === 'cleaned') return NextResponse.json({ status: 'cleaned' }, { headers });

    // Explicit allowlist: never log the receipt ID or untrusted provider strings.
    const snapshot = {
      callback: allowed('callbackProvenance' in observed ? observed.callbackProvenance : null,
        ['authenticated_matching_callback', 'not_observed']),
      provider: allowed('providerStatus' in observed ? observed.providerStatus : null,
        ['queued', 'pending', 'in_progress', 'completed', 'failed', 'cancelled', 'timed_out', 'expired']),
      fallback: allowed('fallbackStage' in observed ? observed.fallbackStage : null,
        ['pending', 'processing', 'completed', 'failed']),
      delivery: 'deliveredCount' in observed && observed.deliveredCount === 1 ? 'delivered' : 'not_verified',
      livePass: observed.livePass === true,
    };
    // This is the pre-cleanup observation. Cleanup gets its own event and never
    // writes a false livePass over a previously observed true result.
    console.info('[WP4 synthetic observation]', snapshot);
    if (observed.status === 'deadline_exceeded' ||
        ('elapsedSeconds' in observed && observed.elapsedSeconds >= 20 * 60)) {
      await cleanupSyntheticValidation();
      console.info('[WP4 synthetic cleanup]', { status: 'cleaned' });
      return NextResponse.json({ status: 'cleaned', observation: snapshot }, { headers });
    }
    return NextResponse.json({ status: 'observed', observation: snapshot }, { headers });
  } catch {
    // Provider and storage exceptions can carry secrets: never emit them.
    return NextResponse.json({ error: 'synthetic_cron_failed' }, { status: 503, headers });
  }
}

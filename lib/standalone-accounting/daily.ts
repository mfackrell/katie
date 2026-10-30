/** Daily presentation is derived from durable attempts; it never owns counters. */
export interface DailyAttempt {
  id: string;
  actor_id: string;
  chat_id: string;
  provider: string;
  model: string;
  category: string;
  resolved_model?: string | null;
  uncertainty_reason?: string | null;
  state: string;
  created_at: string;
  dispatched_at?: string | null;
  settled_at?: string | null;
  reserved_microusd: string;
  actual_microusd: string | null;
  usage: { inputTokens?: number | null; outputTokens?: number | null } | null;
}

export interface UsageTotals {
  cachedInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
  missingInputCount: number;
  missingOutputCount: number;
  estimatedCostMicrousd: string;
  /** Retained infrastructure reservations without an authoritative monetary receipt. */
  estimatedInfrastructureMicrousd?: string;
  pendingExposureMicrousd: string;
  uncertainExposureMicrousd: string;
  unknownCostCount: number;
  attemptCount: number;
}

export interface DailyUsage {
  timezone: string;
  date: string;
  start: string;
  end: string;
  totals: UsageTotals;
  providers: Array<UsageTotals & { provider: string }>;
  models: Array<UsageTotals & { provider: string; model: string; category: string }>;
  unresolvedEarlier: UsageTotals;
  attempts: DailyAttempt[];
}

export function validTimezone(value: string): boolean {
  if (!value.trim()) return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(); return true; }
  catch { return false; }
}

/** Search calendar boundaries, rather than adding 24 hours or fixing a UTC offset.
 * This also handles zones whose daylight saving transition occurs at midnight.
 */
export function localDayWindow(timezone: string, now = new Date()) {
  if (!validTimezone(timezone) || !Number.isFinite(now.getTime())) throw new Error('Invalid local day');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const key = (instant: number) => {
    const parts = formatter.formatToParts(instant);
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
  };
  const date = key(now.getTime());
  const [year, month, day] = date.split('-').map(Number);
  const following = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  const boundary = (target: string) => {
    const center = Date.parse(`${target}T00:00:00.000Z`);
    let low = center - 72 * 60 * 60 * 1000, high = center + 72 * 60 * 60 * 1000;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (key(middle) < target) low = middle + 1;
      else high = middle;
    }
    return new Date(low).toISOString();
  };
  return { timezone, date, start: boundary(date), end: boundary(following) };
}

const empty = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, missingInputCount: 0, missingOutputCount: 0, estimatedCostMicrousd: '0', estimatedInfrastructureMicrousd: '0', pendingExposureMicrousd: '0', uncertainExposureMicrousd: '0', unknownCostCount: 0, attemptCount: 0 });
const amount = (value: string | null | undefined) => value && /^\d+$/.test(value) ? BigInt(value) : null;
const unresolved = (attempt: DailyAttempt) => ['paused', 'reserved', 'dispatched', 'uncertain', 'pending_approval', 'awaiting_approval'].includes(attempt.state);
function add(totals: UsageTotals, attempt: DailyAttempt) {
  totals.attemptCount++;
  const dispatched = Boolean(attempt.dispatched_at) || ['dispatched', 'settled', 'uncertain', 'estimated'].includes(attempt.state);
  const token = (value: number | null | undefined) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  // Infrastructure execution is not token-priced; absent token counters are
  // inapplicable, rather than missing provider token usage.
  if (dispatched && attempt.provider !== 'runpod') {
    const input = token(attempt.usage?.inputTokens), output = token(attempt.usage?.outputTokens);
    if (input === null) totals.missingInputCount++; else totals.inputTokens += input;
    if (output === null) totals.missingOutputCount++; else totals.outputTokens += output;
  }
  const actual = amount(attempt.actual_microusd), reserved = amount(attempt.reserved_microusd);
  if (actual !== null) totals.estimatedCostMicrousd = (BigInt(totals.estimatedCostMicrousd) + actual).toString();
  else if (dispatched) {
    totals.unknownCostCount++;
    if (attempt.provider === 'runpod' && attempt.state === 'estimated') {
      totals.estimatedInfrastructureMicrousd = (BigInt(totals.estimatedInfrastructureMicrousd ?? '0') + (reserved ?? 0n)).toString();
    }
  }
  if (attempt.state === 'uncertain' || (attempt.state === 'dispatched' && actual === null)) {
    totals.uncertainExposureMicrousd = (BigInt(totals.uncertainExposureMicrousd) + (reserved ?? 0n)).toString();
  } else if (unresolved(attempt)) {
    totals.pendingExposureMicrousd = (BigInt(totals.pendingExposureMicrousd) + (reserved ?? 0n)).toString();
  }
}

export function summarizeUsageTotals(attempts: DailyAttempt[]): UsageTotals {
  const totals = empty();
  for (const attempt of attempts) add(totals, attempt);
  return totals;
}

export function summarizeDailyUsage(attempts: DailyAttempt[], timezone: string, actorId?: string, now = new Date()): DailyUsage {
  const window = localDayWindow(timezone, now);
  const totals = empty(), unresolvedEarlier = empty();
  const providers = new Map<string, UsageTotals & { provider: string }>();
  const models = new Map<string, UsageTotals & { provider: string; model: string; category: string }>();
  const current: DailyAttempt[] = [];
  const start = Date.parse(window.start), end = Date.parse(window.end);
  for (const attempt of attempts) {
    if (actorId && attempt.actor_id !== actorId) continue;
    // A dispatched call belongs to its dispatch day. An unstarted reservation belongs to its creation day.
    const timestamp = Date.parse(attempt.dispatched_at || attempt.created_at);
    if (!Number.isFinite(timestamp)) throw new Error('Ledger attempt has an invalid timestamp');
    if (timestamp < start) { if (unresolved(attempt)) add(unresolvedEarlier, attempt); continue; }
    if (timestamp >= end) continue;
    current.push(attempt);
    add(totals, attempt);
    const provider = providers.get(attempt.provider) ?? { ...empty(), provider: attempt.provider };
    add(provider, attempt); providers.set(attempt.provider, provider);
    const modelKey = JSON.stringify([attempt.provider, attempt.model, attempt.category]);
    const model = models.get(modelKey) ?? { ...empty(), provider: attempt.provider, model: attempt.model, category: attempt.category };
    add(model, attempt); models.set(modelKey, model);
  }
  return { ...window, totals, unresolvedEarlier, providers: [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider)), models: [...models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.category.localeCompare(b.category)), attempts: current.sort((a, b) => b.created_at.localeCompare(a.created_at)) };
}

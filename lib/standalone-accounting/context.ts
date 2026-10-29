import { AsyncLocalStorage } from 'node:async_hooks';

export interface StandaloneAccountingContext {
  /** All identifiers are established by authenticated server code. */
  userId: string;
  actorId: string;
  chatId: string;
  requestId: string;
  signal?: AbortSignal;
  activity?: string;
  reason?: string;
}
type Scope = { kind: 'standalone'; context: StandaloneAccountingContext; counter: Map<string, number> }
  | { kind: 'orchestrator' };
const storage = new AsyncLocalStorage<Scope>();

/** Server entry points only: browser-supplied IDs do not authenticate a scope. */
export function runWithStandaloneAccounting<T>(context: StandaloneAccountingContext, operation: () => T): T {
  if (![context.userId, context.actorId, context.chatId, context.requestId].every(value => typeof value === 'string' && value.trim())) {
    throw Object.assign(new Error('Standalone accounting requires an authenticated owner, actor, chat and request.'), { code: 'standalone_context_missing' });
  }
  return storage.run({ kind: 'standalone', context: Object.freeze({ ...context }), counter: new Map() }, operation);
}

/** Explicit trusted server orchestration scope; never infer this from model parameters. */
export function runWithOrchestratorAccounting<T>(operation: () => T): T {
  // Nested helpers of a standalone request must remain on its budget.
  if (storage.getStore()?.kind === 'standalone') return operation();
  return storage.run({ kind: 'orchestrator' }, operation);
}

export function getAccountingScope(): Scope | undefined { return storage.getStore(); }
export function runWithStandaloneActivity<T>(activity: string, operation: () => T, reason?: string): T {
  const scope = storage.getStore();
  if (scope?.kind !== 'standalone') return operation();
  // Share the ordinal across nested helpers so deterministic replay sees every
  // transmission in the same parent workflow sequence.
  return storage.run({ ...scope, context: Object.freeze({ ...scope.context, activity, ...(reason ? { reason } : {}) }) }, operation);
}
export function nextStandaloneAttempt(): { context: StandaloneAccountingContext; attemptKey: string } | undefined {
  const scope = storage.getStore();
  if (scope?.kind !== 'standalone') return undefined;
  const activity = scope.context.activity ?? 'standalone';
  const ordinal = scope.counter.get(activity) ?? 0;
  scope.counter.set(activity, ordinal + 1);
  return { context: scope.context, attemptKey: `${activity}:${ordinal}` };
}

/** SDKs can wrap a fetch error; callers must still recognize terminal accounting decisions. */
export function isStandaloneAccountingError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    if ('terminal' in current && current.terminal === true) return true;
    if ('code' in current && typeof current.code === 'string' && current.code.startsWith('standalone_')) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

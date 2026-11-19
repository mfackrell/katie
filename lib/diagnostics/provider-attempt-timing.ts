import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Opt-in, server-only control-plane diagnostics. The trace never receives
 * prompts, request/response bodies, headers, credentials, URLs or error messages.
 * Durations use a monotonic clock; wall-clock time is only for log correlation.
 */
export type ProviderTracePhase =
  | "attempt_started" | "request_preparation_started" | "request_preparation_completed"
  | "dispatch_initiated" | "response_headers_received" | "first_response_chunk_received"
  | "response_body_received" | "response_parsing_completed" | "decision_validation_completed"
  | "cancellation_requested" | "cancellation_acknowledged" | "provider_http_rejection"
  | "local_synthetic_response" | "provider_receipt_observed" | "provider_receipt_missing"
  | "provider_receipt_settled" | "attempt_uncertain" | "attempt_failed" | "attempt_finalized";

export type ProviderFailureCategory =
  | "local_timeout" | "local_cancellation" | "connection_failure" | "network_interruption"
  | "provider_http_rejection" | "provider_rate_limit" | "provider_internal_error"
  | "incomplete_response" | "response_parsing_failure" | "receipt_reconciliation_failure"
  | "unknown_outcome" | "unknown";

export type ProviderTraceEvent = Readonly<{
  event: "katie_provider_attempt_timing";
  version: 1;
  traceId: string;
  taskName: string;
  requestId: string | null;
  attemptKey: string | null;
  attemptId: string | null;
  provider: string;
  modelId: string;
  endpoint: string | null;
  deploymentCommit: string | null;
  phase: ProviderTracePhase;
  at: string;
  elapsedMs: number;
  sincePreviousMs: number;
  httpStatus?: number;
  errorCode?: string;
  failureCategory?: ProviderFailureCategory;
  timeoutSource?: "control_plane" | "transmission" | "upstream" | "none";
  cancellationReason?: "decision_deadline" | "transport_deadline" | "owner" | "parent_signal" | "unknown";
  outcome?: "completed" | "failed" | "unknown";
  observed?: {
    dispatched: boolean;
    headers: boolean;
    firstChunk: boolean;
    completeBody: boolean;
    parsed: boolean;
    receipt: boolean;
    cancellationRequested: boolean;
    cancellationAcknowledged: boolean;
  };
}>;

export type TraceSink = (event: ProviderTraceEvent) => void;
type TraceMeta = { taskName: string; requestId?: string | null; provider: string; modelId: string; endpoint?: string | null };
type TraceDetails = Partial<Pick<ProviderTraceEvent,
  "httpStatus" | "errorCode" | "failureCategory" | "timeoutSource" | "cancellationReason" | "outcome">>;
type TraceState = {
  meta: TraceMeta;
  traceId: string;
  attemptKey: string | null;
  attemptId: string | null;
  start: bigint;
  previous: bigint;
  seen: Set<ProviderTracePhase>;
  sink: TraceSink;
};
const traceStorage = new AsyncLocalStorage<TraceState>();

/** Explicit override exists only for deterministic offline tests. */
export function runProviderAttemptTrace<T>(meta: TraceMeta, operation: () => T, testSink?: TraceSink): T {
  if (process.env.KATIE_PROVIDER_TIMEOUT_DIAGNOSTICS !== "true" && !testSink) return operation();
  const now = process.hrtime.bigint();
  const state: TraceState = {
    meta: { ...meta }, traceId: randomUUID(), attemptKey: null, attemptId: null,
    start: now, previous: now, seen: new Set(),
    sink: testSink ?? (event => { console.info("[ProviderTiming]", JSON.stringify(event)); }),
  };
  return traceStorage.run(state, () => {
    recordProviderTrace("attempt_started");
    // Promise.resolve preserves both sync and async caller behavior.
    let outcome: T;
    try { outcome = operation(); }
    catch (error) {
      recordProviderTrace("attempt_failed", safeFailureDetails(error));
      recordProviderTrace("attempt_finalized", { outcome: "failed" });
      throw error;
    }
    if (!(outcome instanceof Promise)) {
      recordProviderTrace("attempt_finalized", { outcome: "completed" });
      return outcome;
    }
    return outcome.then(
      result => { recordProviderTrace("attempt_finalized", { outcome: "completed" }); return result; },
      error => {
        recordProviderTrace("attempt_failed", safeFailureDetails(error));
        recordProviderTrace("attempt_finalized", { outcome: isUnknownOutcome(error) ? "unknown" : "failed" });
        throw error;
      },
    ) as T;
  });
}

export function traceAttemptIdentity(fields: {
  attemptKey?: string; attemptId?: string; endpoint?: string;
}): void {
  const state = traceStorage.getStore();
  if (!state) return;
  if (fields.attemptKey) state.attemptKey = fields.attemptKey;
  if (fields.attemptId) state.attemptId = fields.attemptId;
  if (fields.endpoint) state.meta.endpoint = fields.endpoint;
}

/** Preserve the request trace when abort originates in an independent async context. */
export function bindProviderTraceRecorder(): (phase: ProviderTracePhase, details?: TraceDetails) => void {
  const state = traceStorage.getStore();
  return (phase, details = {}) => {
    if (!state) return;
    traceStorage.run(state, () => recordProviderTrace(phase, details));
  };
}

function safeValue(value: unknown, max = 100): string | null {
  if (typeof value !== "string" || !value || value.length > max || !/^[a-zA-Z0-9_./:-]+$/.test(value)) return null;
  return value;
}
const SAFE_CODES = new Set([
  "INVALID_ARGUMENT", "RESOURCE_EXHAUSTED", "PERMISSION_DENIED", "UNAVAILABLE", "INTERNAL",
  "DEADLINE_EXCEEDED", "NOT_FOUND", "FAILED_PRECONDITION", "UNAUTHENTICATED", "CANCELLED",
  "ABORTED", "OUT_OF_RANGE", "DATA_LOSS", "UNKNOWN", "ALREADY_EXISTS",
  "rate_limit_exceeded", "insufficient_quota", "invalid_request_error", "server_error",
  "model_not_found", "context_length_exceeded", "invalid_api_key", "unsupported_parameter",
  "rate_limit_error", "api_error", "authentication_error", "permission_error",
  "overloaded_error", "invalid_request", "not_found_error", "billing_hard_limit_reached",
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT",
  "UND_ERR_SOCKET", "ABORT_ERR", "uncertain_exposure_retained",
  "standalone_outcome_unknown", "standalone_cancelled", "standalone_receipt_conflict",
  "standalone_usage_unpriced", "standalone_time_budget_exhausted",
  "standalone_approval_required", "standalone_context_missing",
]);
function safeCode(value: unknown): string | undefined {
  const result = safeValue(value, 64);
  return result && SAFE_CODES.has(result) ? result : undefined;
}
function ms(delta: bigint): number { return Math.round(Number(delta) / 100_000) / 10; }

export function recordProviderTrace(phase: ProviderTracePhase, details: TraceDetails = {}): void {
  const state = traceStorage.getStore();
  if (!state) return;
  // Instrumentation must never change request success/failure.
  try {
    const now = process.hrtime.bigint();
    const seen = state.seen;
    if (phase === "cancellation_requested" && seen.has(phase)) return;
    const event: ProviderTraceEvent = {
      event: "katie_provider_attempt_timing", version: 1, traceId: state.traceId,
      taskName: safeValue(state.meta.taskName) ?? "unknown",
      requestId: safeValue(state.meta.requestId) ?? null,
      attemptKey: safeValue(state.attemptKey) ?? null,
      attemptId: safeValue(state.attemptId) ?? null,
      provider: safeValue(state.meta.provider) ?? "unknown",
      modelId: safeValue(state.meta.modelId) ?? "unknown",
      endpoint: safeValue(state.meta.endpoint, 180) ?? null,
      deploymentCommit: safeValue(process.env.VERCEL_GIT_COMMIT_SHA, 64) ?? null,
      phase, at: new Date().toISOString(), elapsedMs: ms(now - state.start),
      sincePreviousMs: ms(now - state.previous),
      ...(Number.isInteger(details.httpStatus) && details.httpStatus! >= 100 && details.httpStatus! <= 599
        ? { httpStatus: details.httpStatus } : {}),
      ...(safeCode(details.errorCode) ? { errorCode: safeCode(details.errorCode) } : {}),
      ...(details.failureCategory ? { failureCategory: details.failureCategory } : {}),
      ...(details.timeoutSource ? { timeoutSource: details.timeoutSource } : {}),
      ...(details.cancellationReason ? { cancellationReason: details.cancellationReason } : {}),
      ...(details.outcome ? { outcome: details.outcome } : {}),
      ...(phase === "attempt_finalized" ? { observed: {
        dispatched: seen.has("dispatch_initiated"), headers: seen.has("response_headers_received"),
        firstChunk: seen.has("first_response_chunk_received"),
        completeBody: seen.has("response_body_received"),
        parsed: seen.has("response_parsing_completed"),
        receipt: seen.has("provider_receipt_observed"),
        cancellationRequested: seen.has("cancellation_requested"),
        cancellationAcknowledged: seen.has("cancellation_acknowledged"),
      } } : {}),
    };
    state.previous = now;
    seen.add(phase);
    state.sink(event);
  } catch { /* Observability is never an execution gate. */ }
}
function isUnknownOutcome(error: unknown): boolean {
  const item = error as { code?: unknown; type?: unknown } | null;
  return item?.code === "standalone_outcome_unknown" || item?.type === "uncertain_exposure_retained";
}

/** Only categorized errors and safe codes are logged; raw messages are never read. */
export function safeFailureDetails(error: unknown): TraceDetails {
  const item = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; status?: unknown; type?: unknown } : {};
  const status = typeof item.status === "number" && Number.isInteger(item.status) ? item.status : undefined;
  const code = safeCode(item.code) ?? safeCode(item.type);
  let failureCategory: ProviderFailureCategory = "unknown";
  if (code === "standalone_outcome_unknown" || code === "standalone_receipt_conflict" || code === "standalone_usage_unpriced" || code === "uncertain_exposure_retained") {
    failureCategory = code === "standalone_outcome_unknown" || code === "uncertain_exposure_retained"
      ? "unknown_outcome" : "receipt_reconciliation_failure";
  } else if (code === "standalone_cancelled" || item.name === "AbortError" || code === "ABORT_ERR") {
    failureCategory = "local_cancellation";
  } else if (code === "ETIMEDOUT" || item.name === "TimeoutError") {
    failureCategory = "local_timeout";
  } else if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED") {
    failureCategory = "connection_failure";
  } else if (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET") {
    failureCategory = "network_interruption";
  } else if (status === 429) {
    failureCategory = "provider_rate_limit";
  } else if (status && status >= 500) {
    failureCategory = "provider_internal_error";
  } else if (status && status >= 400) {
    failureCategory = "provider_http_rejection";
  }
  return { failureCategory, ...(status ? { httpStatus: status } : {}), ...(code ? { errorCode: code } : {}) };
}

/** Read the same bytes as Response.text(), observing the first actual stream chunk.
 * Used only while explicitly tracing; preserves the normal path otherwise. */
export async function readProviderResponseText(response: Response): Promise<string> {
  if (!traceStorage.getStore() || !response.body) {
    const body = await response.text();
    recordProviderTrace("response_body_received");
    return body;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const fragments: string[] = [];
  let first = true;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (first && value.byteLength > 0) {
        first = false;
        recordProviderTrace("first_response_chunk_received");
      }
      fragments.push(decoder.decode(value, { stream: true }));
    }
    fragments.push(decoder.decode());
    recordProviderTrace("response_body_received");
    return fragments.join("");
  } finally { reader.releaseLock(); }
}

/** Safe status name only; never log the provider's free-form message or body. */
export function safeHttpErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return;
    const error = (parsed as { error?: unknown }).error;
    if (!error || typeof error !== "object") return;
    const e = error as { status?: unknown; code?: unknown; type?: unknown };
    return safeCode(e.status) ?? safeCode(e.type) ?? safeCode(e.code);
  } catch { return undefined; }
}

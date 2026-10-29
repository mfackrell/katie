import { isTerminalProviderError, ProviderResponseError } from "@/lib/providers/response-errors";
import { isStandaloneAccountingError } from "@/lib/standalone-accounting/context";
/** A local timeout cannot establish that the remote provider stopped billing. */
export async function withProviderAttemptTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ProviderResponseError(
      `${label} has no remaining execution time. No provider attempt was started.`,
      false,
      "standalone_time_budget_exhausted",
    );
  }
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return work(signal);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new ProviderResponseError(
            `${label} timed out after ${timeoutMs}ms; provider cancellation requested and billing outcome is unknown. Automatic retry stopped.`,
            false,
            "standalone_outcome_unknown",
          );
          controller.abort(error);
          reject(error);
        }, Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Approval, uncertain billing and cancellation never trigger automatic fallback. */
export function isTerminalAttemptError(error: unknown): boolean {
  return isTerminalProviderError(error) || isStandaloneAccountingError(error) ||
    (error instanceof Error && (error.name === "AbortError" || ("code" in error && error.code === "ABORT_ERR")));
}

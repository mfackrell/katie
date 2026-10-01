import type { ProviderResponse } from "./types";

export class ProviderResponseError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly code: string) {
    super(message); this.name = "ProviderResponseError";
  }
}
export function assertProviderOutput(result: ProviderResponse): void {
  if (!result.text?.trim() && !result.content?.length) {
    throw new ProviderResponseError("The AI provider returned no answer. Please try again.", true, "EMPTY_RESPONSE");
  }
}
export function isTerminalProviderError(error: unknown): boolean {
  return error instanceof ProviderResponseError && !error.retryable;
}

type GoogleStatus = {
  promptFeedback?: { blockReason?: string; safetyRatings?: unknown[] };
  candidates?: Array<{ finishReason?: string; safetyRatings?: unknown[]; content?: { parts?: Array<{ text?: string; thought?: boolean; inlineData?: unknown }> } }>;
};
export function inspectGoogleStatus(response: GoogleStatus, model: string): string | undefined {
  const candidate = response.candidates?.[0];
  const reason = candidate?.finishReason;
  const block = response.promptFeedback?.blockReason;
  console.info("[GoogleProvider] Response status", {
    model, candidateCount: response.candidates?.length ?? 0,
    finishReason: reason ?? null, blockReason: block ?? null,
    hasContent: Boolean(candidate?.content?.parts?.some(part => !part.thought && (part.text?.trim() || part.inlineData))),
    safetyRatings: candidate?.safetyRatings ?? response.promptFeedback?.safetyRatings ?? [],
  });
  if ((block && block !== "BLOCK_REASON_UNSPECIFIED") ||
      (reason && !["STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"].includes(reason))) {
    throw new ProviderResponseError(
      `Google stopped this response (${block || reason}). This request was not retried.`, false, "PROVIDER_STOPPED_RESPONSE");
  }
  if (reason === "MAX_TOKENS") {
    throw new ProviderResponseError("Google reached its output limit before completing the answer. Please narrow the request.", false, "OUTPUT_LIMIT");
  }
  return reason;
}

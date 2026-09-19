import type { ProviderResponse } from "@/lib/providers/types";

const STRONG_REFUSAL_PATTERNS: RegExp[] = [
  /\bi\s*(?:can(?:not|'t)|am\s+unable\s+to|won't)\s+(?:help|assist|comply|answer|provide)\s+(?:with\s+)?that\b/i,
  /\bi\s*(?:can(?:not|'t)|am\s+unable\s+to)\s+describe\s+explicit\s+sexual\s+content\b/i,
  /\b(?:this|that)\s+request\s+(?:violates|goes\s+against)\s+(?:our\s+)?content\s+policy\b/i,
  /\bi\s+can\s+still\s+help\s+in\s+a\s+safer\s+way\b/i,
  /\b(?:instead|however),?\s+i\s+can\s+offer\s+(?:a\s+)?safer\s+(?:alternative|approach|way)\b/i,
  /\bi\s*(?:can(?:not|'t)|won't)\s+provide\s+that\b/i,
  /\bi\s+must\s+refuse\b/i,
  /^\s*(?:sorry[,—:\s-]*)?(?:i(?:'m| am)\s+)?not\s+going\s+there\b/i,
  /^\s*(?:sorry[,—:\s-]*)?i\s+won't\s+go\s+there\b/i
];

const SAFER_WAY_PATTERN = /\bsafer\s+way\b/i;
const POLICY_PATTERN = /\bcontent\s+policy\b/i;

function normalizeText(input: string): string {
  return input
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function shouldRetryOnProviderRefusal(): boolean {
  const raw = process.env.RETRY_ON_PROVIDER_REFUSAL;
  if (!raw) {
    return true;
  }

  return raw.toLowerCase() !== "false";
}

export function isLikelyProviderRefusal(result: ProviderResponse, _providerName?: string): boolean {
  const normalized = normalizeText(result.text ?? "");
  if (!normalized) {
    return false;
  }

  if (STRONG_REFUSAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const policyMentioned = POLICY_PATTERN.test(normalized);
  const saferWayMentioned = SAFER_WAY_PATTERN.test(normalized);
  return policyMentioned && saferWayMentioned;
}

export async function runWithRefusalFallback<TAttempt>({
  attempts,
  runAttempt,
  detectRefusal,
  shouldRetryRefusal,
  rerouteOnRefusal,
  onRefusalReroute,
  onRefusalFallback,
  onRerouteError,
  onError
}: {
  attempts: TAttempt[];
  runAttempt: (attempt: TAttempt, attemptIndex: number) => Promise<ProviderResponse>;
  detectRefusal: (result: ProviderResponse, attempt: TAttempt) => boolean;
  shouldRetryRefusal: boolean;
  rerouteOnRefusal?: (context: {
    attempt: TAttempt;
    attemptIndex: number;
    attemptedAttempts: TAttempt[];
    remainingAttempts: TAttempt[];
  }) => Promise<TAttempt | null>;
  onRefusalReroute?: (context: {
    attempt: TAttempt;
    attemptIndex: number;
    reroutedAttempt: TAttempt;
  }) => void;
  onRefusalFallback?: (context: { attempt: TAttempt; attemptIndex: number; nextAttempt: TAttempt }) => void;
  onRerouteError?: (context: { attempt: TAttempt; attemptIndex: number; error: unknown }) => void;
  onError?: (context: { attempt: TAttempt; attemptIndex: number; error: unknown }) => void;
}): Promise<{ result: ProviderResponse; attempt: TAttempt }> {
  let lastGenerationError: unknown = null;
  let lastRefusal: { result: ProviderResponse; attempt: TAttempt } | null = null;
  const pendingAttempts = [...attempts];
  const attemptedAttempts: TAttempt[] = [];
  let attemptIndex = 0;

  while (pendingAttempts.length > 0) {
    const attempt = pendingAttempts.shift() as TAttempt;
    const currentAttemptIndex = attemptIndex;
    attemptIndex += 1;
    attemptedAttempts.push(attempt);

    try {
      const result = await runAttempt(attempt, currentAttemptIndex);

      if (!shouldRetryRefusal || !detectRefusal(result, attempt)) {
        return { result, attempt };
      }

      lastRefusal = { result, attempt };

      if (rerouteOnRefusal) {
        try {
          const reroutedAttempt = await rerouteOnRefusal({
            attempt,
            attemptIndex: currentAttemptIndex,
            attemptedAttempts: [...attemptedAttempts],
            remainingAttempts: [...pendingAttempts]
          });

          if (reroutedAttempt) {
            pendingAttempts.unshift(reroutedAttempt);
            onRefusalReroute?.({
              attempt,
              attemptIndex: currentAttemptIndex,
              reroutedAttempt
            });
            continue;
          }
        } catch (error: unknown) {
          onRerouteError?.({ attempt, attemptIndex: currentAttemptIndex, error });
        }
      }

      const nextAttempt = pendingAttempts[0];
      if (!nextAttempt) {
        return { result, attempt };
      }

      onRefusalFallback?.({ attempt, attemptIndex: currentAttemptIndex, nextAttempt });
      continue;
    } catch (error: unknown) {
      lastGenerationError = error;
      onError?.({ attempt, attemptIndex: currentAttemptIndex, error });
    }
  }

  if (lastRefusal) {
    return lastRefusal;
  }

  throw (lastGenerationError ?? new Error("Generation failed for all routed candidates."));
}

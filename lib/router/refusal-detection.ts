import type { ProviderResponse } from "@/lib/providers/types";

const REFUSAL_RETRY_PROVIDERS = new Set(["openai", "google"]);

const STRONG_REFUSAL_PATTERNS: RegExp[] = [
  /\bi\s*(?:can(?:not|'t)|am\s+unable\s+to|won't)\s+(?:help|assist|comply)\s+with\s+that\b/i,
  /\bi\s*(?:can(?:not|'t)|am\s+unable\s+to)\s+describe\s+explicit\s+sexual\s+content\b/i,
  /\b(?:this|that)\s+request\s+(?:violates|goes\s+against)\s+(?:our\s+)?content\s+policy\b/i,
  /\bi\s+can\s+still\s+help\s+in\s+a\s+safer\s+way\b/i,
  /\b(?:instead|however),?\s+i\s+can\s+offer\s+(?:a\s+)?safer\s+(?:alternative|approach|way)\b/i,
  /\bi\s*(?:can(?:not|'t)|won't)\s+provide\s+that\b/i,
  /\bi\s+must\s+refuse\b/i
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

export function isLikelyProviderRefusal(result: ProviderResponse, providerName: string): boolean {
  if (!REFUSAL_RETRY_PROVIDERS.has(providerName)) {
    return false;
  }

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
  onRefusalFallback,
  onError
}: {
  attempts: TAttempt[];
  runAttempt: (attempt: TAttempt, attemptIndex: number) => Promise<ProviderResponse>;
  detectRefusal: (result: ProviderResponse, attempt: TAttempt) => boolean;
  shouldRetryRefusal: boolean;
  onRefusalFallback?: (context: { attempt: TAttempt; attemptIndex: number; nextAttempt: TAttempt }) => void;
  onError?: (context: { attempt: TAttempt; attemptIndex: number; error: unknown }) => void;
}): Promise<{ result: ProviderResponse; attempt: TAttempt }> {
  let lastGenerationError: unknown = null;
  let lastRefusal: { result: ProviderResponse; attempt: TAttempt } | null = null;

  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
    const attempt = attempts[attemptIndex];

    try {
      const result = await runAttempt(attempt, attemptIndex);

      if (!shouldRetryRefusal || !detectRefusal(result, attempt)) {
        return { result, attempt };
      }

      const hasNextAttempt = attemptIndex < attempts.length - 1;
      if (!hasNextAttempt) {
        return { result, attempt };
      }

      lastRefusal = { result, attempt };
      const nextAttempt = attempts[attemptIndex + 1];
      onRefusalFallback?.({ attempt, attemptIndex, nextAttempt });
      continue;
    } catch (error: unknown) {
      lastGenerationError = error;
      onError?.({ attempt, attemptIndex, error });
    }
  }

  if (lastRefusal) {
    return lastRefusal;
  }

  throw (lastGenerationError ?? new Error("Generation failed for all routed candidates."));
}

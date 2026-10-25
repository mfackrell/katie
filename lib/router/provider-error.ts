import type { LlmProvider } from "@/lib/providers/types";

export type GenerationFailureScope = "provider" | "model" | "refusal";

/** Safe provider diagnostics: never log upstream bodies, request prompts, or credentials. */
export function getProviderErrorDiagnostics(error: unknown): {
  status: number | null;
  code: string | null;
  type: string | null;
} {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof value.status === "number" && Number.isInteger(value.status) ? value.status : null;
  const safeIdentifier = (candidate: unknown): string | null =>
    typeof candidate === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(candidate) ? candidate : null;
  return { status, code: safeIdentifier(value.code), type: safeIdentifier(value.type) };
}


function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

// A content refusal requires both a 403 status and an explicit refusal statement.
// A bare 403 can also mean that the API key lacks access to a model.
export function isExplicitContentRefusal(error: unknown): boolean {
  const message = errorText(error).replace(/[\u2018\u2019]/g, "'");
  return /\b403\b/.test(message) &&
    (/\bi\s+(?:can't|cannot|won't|will not)\s+(?:help|comply|assist)\s+with\s+(?:that|this|your)\s+request\b/i.test(message) ||
     /\b(?:request|content)\s+(?:violates|is blocked by|goes against)\s+(?:our\s+)?(?:content\s+)?policy\b/i.test(message));
}

const PROVIDER_WIDE_PATTERNS: RegExp[] = [
  /no credits remaining/i,
  /insufficient[_ -]?quota/i,
  /billing/i,
  /payment required/i,
  /credit balance/i,
  /invalid api key/i,
  /invalid_api_key/i,
  /authentication/i,
  /unauthorized/i,
  /organization.*(?:disabled|suspended|deactivated)/i,
  /account.*(?:disabled|suspended|deactivated)/i,
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/i,
];

export function classifyGenerationFailure(error: unknown): GenerationFailureScope {
  const text = errorText(error);
  if (isExplicitContentRefusal(error)) return "refusal";
  return PROVIDER_WIDE_PATTERNS.some((pattern) => pattern.test(text))
    ? "provider"
    : "model";
}

export function describeGenerationFailure(error: unknown): string {
  const text = errorText(error);
  if (isExplicitContentRefusal(error)) return "the model declined the request";

  if (/no credits remaining|insufficient[_ -]?quota|billing|payment required|credit balance/i.test(text)) {
    return "provider billing or quota is unavailable";
  }
  if (/does not exist|do not have access|not found/i.test(text)) {
    return "the selected model is unavailable";
  }
  if (/rate.?limit|429/i.test(text)) {
    return "the provider rate-limited the request";
  }
  if (/timed out|timeout/i.test(text)) {
    return "the provider timed out";
  }
  if (/authentication|unauthorized|invalid api key|invalid_api_key/i.test(text)) {
    return "provider authentication failed";
  }

  return "the provider could not complete the request";
}

export function filterHealthyProviders(
  providers: LlmProvider[],
  failedProviderNames: Set<LlmProvider["name"]>,
  additionallyAvoid?: LlmProvider["name"],
): LlmProvider[] {
  const filtered = providers.filter(
    (provider) =>
      !failedProviderNames.has(provider.name) &&
      (!additionallyAvoid || provider.name !== additionallyAvoid),
  );

  if (filtered.length > 0) {
    return filtered;
  }

  return providers.filter((provider) => !failedProviderNames.has(provider.name));
}

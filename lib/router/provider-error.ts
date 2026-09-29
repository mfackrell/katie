import type { LlmProvider } from "@/lib/providers/types";

export type GenerationFailureScope = "provider" | "model";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
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
];

export function classifyGenerationFailure(error: unknown): GenerationFailureScope {
  const text = errorText(error);
  return PROVIDER_WIDE_PATTERNS.some((pattern) => pattern.test(text))
    ? "provider"
    : "model";
}

export function describeGenerationFailure(error: unknown): string {
  const text = errorText(error);

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

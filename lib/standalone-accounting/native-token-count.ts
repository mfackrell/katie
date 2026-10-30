import type { FrozenPreparedRequest, JsonObject } from './estimate';

/**
 * The provider token-count endpoint sees the model and the exact frozen input
 * blocks. It does NOT generate an answer or create a paid ledger attempt.
 * Return null unless the provider supplies a trustworthy integer count.
 */
export async function countNativePreparedInput(
  prepared: FrozenPreparedRequest,
  transport: typeof fetch,
  originalHeaders: HeadersInit | undefined,
  signal?: AbortSignal,
): Promise<number | null> {
  const payload = prepared.payload;
  let url: string;
  let countPayload: JsonObject;
  if (prepared.provider === 'anthropic' && prepared.endpoint === '/v1/messages') {
    url = 'https://api.anthropic.com/v1/messages/count_tokens';
    const fields = ['model', 'system', 'messages', 'tools', 'tool_choice', 'thinking', 'cache_control', 'output_config'];
    countPayload = Object.fromEntries(fields.filter(key => payload[key] !== undefined).map(key => [key, payload[key]])) as JsonObject;
  } else if (prepared.provider === 'openai' && prepared.endpoint === '/v1/responses') {
    url = 'https://api.openai.com/v1/responses/input_tokens';
    const fields = ['model', 'input', 'instructions', 'tools', 'tool_choice', 'text', 'reasoning'];
    countPayload = Object.fromEntries(fields.filter(key => payload[key] !== undefined).map(key => [key, payload[key]])) as JsonObject;
  } else if (prepared.provider === 'google' && /^\/v1(?:beta)?\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(prepared.endpoint)) {
    url = 'https://generativelanguage.googleapis.com' + prepared.endpoint.replace(/:(?:generateContent|streamGenerateContent)$/, ':countTokens');
    countPayload = { generateContentRequest: payload };
  } else {
    return null; // Never invent provider-specific counts.
  }
  const headers = new Headers(originalHeaders);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');
  const limited = AbortSignal.timeout(12_000);
  const requestSignal = signal ? AbortSignal.any([signal, limited]) : limited;
  try {
    const response = await transport(url, {
      method: 'POST', headers, body: JSON.stringify(countPayload),
      signal: requestSignal, redirect: 'manual',
    });
    if (!response.ok) {
      console.info('[Accounting] Provider token count unavailable', {
        provider: prepared.provider, model: prepared.model, status: response.status,
      });
      return null;
    }
    const data = await response.json() as { input_tokens?: unknown; totalTokens?: unknown };
    const count = prepared.provider === 'google' ? data.totalTokens : data.input_tokens;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null;
    console.info('[Accounting] Provider input count verified', {provider: prepared.provider, model: prepared.model, inputTokens: count});
    return count;
  } catch (error) {
    console.warn('[Accounting] Provider token count failed without spending admission', {
      provider: prepared.provider, model: prepared.model,
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

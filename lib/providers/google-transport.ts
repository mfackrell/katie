import { GenerateContentResponse, type GenerateContentParameters } from '@google/genai';
import { createAccountingFetch } from '@/lib/standalone-accounting/dispatch';

/** The SDK does not expose a custom fetch transport. Build its public REST shape
 * explicitly so the final serialized request passes through the accounting boundary. */
function prepare(apiKey: string, request: GenerateContentParameters, stream: boolean) {
  const config = { ...request.config } as Record<string, unknown>;
  const suppliedSignal = config.abortSignal as AbortSignal | undefined;
  const timeout = (config.httpOptions as { timeout?: number } | undefined)?.timeout;
  const timeoutSignal = typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? AbortSignal.timeout(Math.ceil(timeout)) : undefined;
  const signals = [suppliedSignal, timeoutSignal].filter((value): value is AbortSignal => !!value);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  const system = config.systemInstruction;
  const body: Record<string, unknown> = { contents: request.contents };
  if (system !== undefined) body.systemInstruction = typeof system === 'string' ? { parts: [{ text: system }] } : system;
  for (const field of ['tools', 'toolConfig', 'safetySettings', 'cachedContent']) {
    if (config[field] !== undefined) body[field] = config[field];
    delete config[field];
  }
  for (const field of ['systemInstruction', 'abortSignal', 'httpOptions']) delete config[field];
  body.generationConfig = config;
  const model = request.model.replace(/^models\//, '');
  return { url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
    options: { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body), signal } };
}
async function send(apiKey: string, request: GenerateContentParameters, stream: boolean) {
  const prepared = prepare(apiKey, request, stream);
  const response = await createAccountingFetch('google')(prepared.url, prepared.options);
  if (!response.ok) throw Object.assign(new Error(`Google model request failed (HTTP ${response.status}).`), { status: response.status });
  return response;
}
function hydrate(data: unknown): GenerateContentResponse {
  return Object.assign(new GenerateContentResponse(), data);
}
export async function googleGenerateContent(apiKey: string, request: GenerateContentParameters): Promise<GenerateContentResponse> {
  return hydrate(await (await send(apiKey, request, false)).json());
}
export async function googleGenerateContentStream(apiKey: string, request: GenerateContentParameters): Promise<AsyncGenerator<GenerateContentResponse>> {
  const response = await send(apiKey, request, true);
  const text = await response.text();
  return (async function* () {
    for (const event of text.replace(/\r\n/g, '\n').split('\n\n')) {
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') yield hydrate(JSON.parse(data));
    }
  })();
}

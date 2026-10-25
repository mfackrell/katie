import type { ToolTurnParams, ToolTurn } from '@/lib/tools/types';
import type { LlmProvider } from './types';

/** Native function calling, using the router-selected model with no hidden fallback or SDK retries. */
export async function nativeToolTurn(provider: LlmProvider['name'], apiKey: string, p: ToolTurnParams): Promise<ToolTurn> {
  let url: string, body: unknown;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const responsesApi = provider === 'openai' && /^(?:gpt-5|o[1-4])/.test(p.modelId) && !/chat-latest/i.test(p.modelId);
  if (responsesApi) {
    url = 'https://api.openai.com/v1/responses';
    headers.Authorization = `Bearer ${apiKey}`;
    body = { model: p.modelId, max_output_tokens: 4096, instructions: p.system, store: false,
      tools: p.tools.map(t => ({ type: 'function', ...t, strict: false })),
      input: p.messages.flatMap(m => m.role === 'tool'
        ? [{ type: 'function_call_output', call_id: m.callId, output: m.text }]
        : m.nativeParts ?? [...(m.text ? [{ role: m.role, content: m.text }] : []), ...(m.calls ?? []).map(c => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) }))]) };
  } else if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01';
    body = { model: p.modelId, max_tokens: 4096, system: p.system,
      tools: p.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      messages: p.messages.map(m => m.role === 'tool'
        ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.callId, content: m.text }] }
        : { role: m.role, content: [ ...(m.text ? [{ type: 'text', text: m.text }] : []),
          ...(m.calls ?? []).map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments })) ] }) };
  } else if (provider === 'google') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.modelId)}:generateContent`;
    headers['x-goog-api-key'] = apiKey;
    body = { systemInstruction: { parts: [{ text: p.system }] }, generationConfig: { maxOutputTokens: 4096 },
      tools: [{ functionDeclarations: p.tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
      contents: p.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: m.role === 'tool'
        ? [{ functionResponse: { name: m.callId, response: { result: m.text } } }]
        : m.nativeParts ?? [...(m.text ? [{ text: m.text }] : []), ...(m.calls ?? []).map(c => ({ functionCall: { name: c.name, args: c.arguments } }))] })) };
  } else {
    url = provider === 'grok' ? 'https://api.x.ai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
    headers.Authorization = `Bearer ${apiKey}`;
    body = { model: p.modelId, max_completion_tokens: 4096,
      tools: p.tools.map(t => ({ type: 'function', function: t })),
      messages: [{ role: 'system', content: p.system }, ...p.messages.map(m => m.role === 'tool'
        ? { role: 'tool', tool_call_id: m.callId, content: m.text }
        : { role: m.role, content: m.text || null, ...(m.calls?.length ? { tool_calls: m.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) })] };
  }
  // Anthropic and Gemini require parallel results grouped into a single user turn.
  if (provider === 'anthropic' || provider === 'google') {
    type NativeMessage = { role: string; parts: unknown[]; content: unknown[] };
    const b = body as Record<string, NativeMessage[]>; const key = provider === 'google' ? 'contents' : 'messages';
    const content = provider === 'google' ? 'parts' : 'content';
    b[key] = b[key].reduce((all: NativeMessage[], message: NativeMessage) => {
      const previous = all.at(-1);
      if (previous?.role === message.role) previous[content].push(...message[content]);
      else all.push(message);
      return all;
    }, []);
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: p.signal, cache: 'no-store' });
  // Never propagate a credential-bearing upstream error body into model context or audit.
  if (!res.ok) {
    await res.body?.cancel();
    // Keep upstream payloads and credentials out of logs, but preserve diagnostic status.
    const error = new Error(`Tool model request failed (${provider}, HTTP ${res.status})`) as Error & { status: number; code: string };
    error.status = res.status;
    error.code = res.status === 429 ? 'upstream_rate_limited' : res.status === 401 || res.status === 403
      ? 'upstream_auth_or_access_denied' : res.status === 404 ? 'upstream_model_or_endpoint_not_found' : 'upstream_http_error';
    throw error;
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Tool model response missing');
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const {done, value} = await reader.read(); if (done) break; size += value.length;
    if (size > 256_000) throw new Error('Tool model response exceeded bounds'); chunks.push(value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  let text = ''; let calls: ToolTurn['calls'] = [];
  if (responsesApi) {
    for (const item of data.output ?? []) {
      if (item.type === 'function_call') calls.push({ id: item.call_id, name: item.name, arguments: JSON.parse(item.arguments) });
      if (item.type === 'message') for (const part of item.content ?? []) if (part.type === 'output_text') text += part.text;
    }
  } else if (provider === 'anthropic') {
    for (const item of data.content ?? []) {
      if (item.type === 'text') text += item.text;
      if (item.type === 'tool_use') calls.push({ id: item.id, name: item.name, arguments: item.input });
    }
  } else if (provider === 'google') {
    for (const item of data.candidates?.[0]?.content?.parts ?? []) {
      if (item.text && item.thought !== true) text += item.text;
      if (item.functionCall) calls.push({ id: item.functionCall.name, name: item.functionCall.name, arguments: item.functionCall.args });
    }
  } else {
    const message = data.choices?.[0]?.message; text = message?.content ?? '';
    calls = (message?.tool_calls ?? []).map((c: { id: string; function: { name: string; arguments: string } }) => ({
      id: c.id, name: c.function.name, arguments: JSON.parse(c.function.arguments),
    }));
  }
  if (!text && !calls.length) throw new Error('Tool model returned no text or calls');
  if (calls.length > 8 || calls.some(c => typeof c.id !== 'string' || typeof c.name !== 'string')) throw new Error('Invalid tool calls');
  return { response: { text, model: data.model ?? data.modelVersion ?? p.modelId, provider, truncated: data.status === 'incomplete' || data.stop_reason === 'max_tokens' || data.choices?.[0]?.finish_reason === 'length' || data.candidates?.[0]?.finishReason === 'MAX_TOKENS' }, calls, ...(provider === 'google' ? { nativeParts: data.candidates?.[0]?.content?.parts } : responsesApi ? { nativeParts: data.output } : {}) };
}

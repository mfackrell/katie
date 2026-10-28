import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createAccountingFetch } from '../lib/standalone-accounting/dispatch';
import { runWithStandaloneAccounting, runWithOrchestratorAccounting, runWithStandaloneActivity, isStandaloneAccountingError } from '../lib/standalone-accounting/context';
import { freezePreparedRequest, estimatePreparedRequest } from '../lib/standalone-accounting/estimate';
import { createStandaloneLedger } from '../lib/standalone-accounting/ledger';
import type { LedgerAttempt, AdmitAttemptInput, ResponseCheckpoint, SettlementInput } from '../lib/standalone-accounting/types';
import { OpenAiProvider } from '../lib/providers/openai-provider';
import { nativeToolTurn } from '../lib/providers/native-tools';

const context = { userId: 'owner', actorId: 'actor', chatId: 'chat', requestId: 'request' };
const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] }) };
const receipt = (id = 'receipt-1') => new Response(JSON.stringify({ id, choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { headers: { 'content-type': 'application/json' } });
function fakeLedger(paused = false) {
  const attempts: LedgerAttempt[] = [];
  const events: string[] = [];
  const identifiers: Array<{ requestId: string | null; responseId: string | null }> = [];
  const service = {
    async registerPricing() { events.push('pricing'); return true; },
    async lookupAttempt(_owner: string, _request: string, key: string) { return attempts.find(item => item.attempt_key === key) ?? null; },
    async admit(input: AdmitAttemptInput) {
      events.push('admit');
      const attempt = { id: `attempt-${attempts.length}`, owner_id: input.ownerId, actor_id: input.actorId, chat_id: input.chatId, request_id: input.requestId,
        attempt_key: input.attemptKey, base_attempt_key: input.attemptKey, source_prepared_hash: input.preparedHash, prepared_hash: input.preparedHash,
        prepared_payload: input.preparedPayload, pricing_version: input.pricingVersion, reserved_microusd: input.reservedMicrousd,
        preflight_estimate: input.preflightEstimate, estimator_version: input.estimatorVersion, reason: input.reason,
        provider: input.provider, model: input.model, state: paused ? 'paused' : 'reserved', response_checkpoint: null } as LedgerAttempt;
      attempts.push(attempt); return attempt;
    },
    async claimDispatch(_owner: string, id: string) { const attempt = attempts.find(item => item.id === id)!; if (attempt.state !== 'reserved') return null; events.push('claim'); attempt.state = 'dispatched'; return attempt; },
    async checkpointResponse(_owner: string, id: string, checkpoint: ResponseCheckpoint) { events.push('checkpoint'); const attempt = attempts.find(item => item.id === id)!; attempt.response_checkpoint = checkpoint; return attempt; },
    async recordProviderIdentifiers(_owner: string, id: string, requestId: string | null, responseId: string | null) { identifiers.push({ requestId, responseId }); return attempts.find(item => item.id === id)!; },
    async recordPartialUsage(_owner: string, id: string, usage: Record<string, unknown>, evidence: Record<string, unknown>) { events.push('partial-usage'); const attempt = attempts.find(item => item.id === id)!; attempt.usage = usage; attempt.evidence = evidence; attempt.state = 'uncertain'; attempt.actual_microusd = null; return attempt; },
    async settle(input: SettlementInput) { events.push('settle'); const attempt = attempts.find(item => item.id === input.attemptId)!; attempt.state = 'settled'; attempt.actual_microusd = input.actualMicrousd; attempt.usage = input.usage; attempt.evidence = input.evidence; return attempt; },
    async markUncertain(_owner: string, id: string) { events.push('uncertain'); const attempt = attempts.find(item => item.id === id)!; attempt.state = 'uncertain'; return attempt; },
    async cancel(_owner: string, id: string) { const attempt = attempts.find(item => item.id === id)!; attempt.state = 'cancelled'; return attempt; },
  } as unknown as ReturnType<typeof createStandaloneLedger>;
  return { service, attempts, events, identifiers, factory: () => service };
}

test('paid transport fails closed without trusted context and unsupported pricing never sends', async () => {
  let sends = 0;
  const fake = fakeLedger();
  const send = createAccountingFetch('openai', async () => { sends++; return receipt(); }, fake.factory);
  await assert.rejects(send('https://api.openai.com/v1/chat/completions', request), isStandaloneAccountingError);
  await assert.rejects(runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', { ...request, body: JSON.stringify({ model: 'unknown-unpriced', messages: [] }) })), isStandaloneAccountingError);
  assert.equal(sends, 0);
});

test('each transmission reserves then atomically claims its exact capped frozen payload and reconciles receipt', async () => {
  const fake = fakeLedger();
  const sent: string[] = [];
  const send = createAccountingFetch('openai', async (_url, init) => { fake.events.push('send'); sent.push(String(init?.body)); return receipt(`receipt-${sent.length}`); }, fake.factory);
  await runWithStandaloneAccounting(context, async () => { await send('https://api.openai.com/v1/chat/completions', request); await send('https://api.openai.com/v1/chat/completions', request); });
  assert.equal(sent.length, 2);
  assert.equal(fake.attempts.length, 2);
  assert.deepEqual(fake.events.slice(0, 6), ['pricing', 'admit', 'claim', 'send', 'checkpoint', 'settle']);
  assert.equal(JSON.parse(sent[0]).max_tokens, 4096);
  const prepared = fake.attempts[0].prepared_payload;
  assert.equal(sent[0], prepared.serializedBody);
  assert.equal(fake.attempts[0].usage?.inputTokens, 100);
  assert.equal(fake.attempts[0].actual_microusd, '450');
});

test('paused requests do not send; replay returns durable settled response without a second transmission', async () => {
  let sends = 0;
  const paused = fakeLedger(true);
  const blocked = createAccountingFetch('openai', async () => { sends++; return receipt(); }, paused.factory);
  await assert.rejects(runWithStandaloneAccounting(context, () => blocked('https://api.openai.com/v1/chat/completions', request)), (error: unknown) => isStandaloneAccountingError(error));
  assert.equal(sends, 0);
  const fake = fakeLedger();
  const send = createAccountingFetch('openai', async () => { sends++; return receipt(); }, fake.factory);
  const first = await runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request));
  const replay = await runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request));
  assert.equal(await first.text(), await replay.text());
  assert.equal(sends, 1);
  await assert.rejects(runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', { ...request, body: request.body.replace('hello', 'changed') })), isStandaloneAccountingError);
  assert.equal(sends, 1);
});

test('missing receipts retain exposure and block automatic continuation and replay', async () => {
  const fake = fakeLedger(); let sends = 0;
  const send = createAccountingFetch('openai', async () => { sends++; return new Response('{"choices":[]}'); }, fake.factory);
  await assert.rejects(runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request)), isStandaloneAccountingError);
  assert.equal(fake.attempts[0].state, 'uncertain');
  assert.ok(fake.attempts[0].response_checkpoint);
  await assert.rejects(runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request)), isStandaloneAccountingError);
  assert.equal(sends, 1);
  assert.equal(fake.attempts[0].actual_microusd, undefined);
});

test('cancellation aborts the actual transmission and retains dispatched exposure', async () => {
  const fake = fakeLedger(); const controller = new AbortController(); let observedSignal: AbortSignal | null | undefined;
  const send = createAccountingFetch('openai', async (_url, init) => {
    observedSignal = init?.signal; controller.abort();
    observedSignal?.throwIfAborted(); throw new Error('should abort');
  }, fake.factory);
  await assert.rejects(runWithStandaloneAccounting({ ...context, signal: controller.signal }, () => send('https://api.openai.com/v1/chat/completions', request)), isStandaloneAccountingError);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(fake.attempts[0].state, 'uncertain');
});

test('standalone child cannot opt out by entering an orchestrator scope', async () => {
  const fake = fakeLedger(true); let sends = 0;
  const send = createAccountingFetch('openai', async () => { sends++; return receipt(); }, fake.factory);
  await assert.rejects(runWithStandaloneAccounting(context, () => runWithOrchestratorAccounting(() => send('https://api.openai.com/v1/chat/completions', request))), isStandaloneAccountingError);
  assert.equal(sends, 0);
});

test('OpenAI SDK cannot hide retries after an ambiguous network failure', async () => {
  const fake = fakeLedger(); let sends = 0;
  const client = new OpenAI({ apiKey: 'offline-test', maxRetries: 0, fetch: createAccountingFetch('openai', async () => { sends++; throw new Error('socket closed after send'); }, fake.factory) });
  await assert.rejects(runWithStandaloneAccounting(context, () => client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] })), isStandaloneAccountingError);
  assert.equal(sends, 1);
  assert.equal(fake.attempts[0].state, 'uncertain');
});

test('SSE receipt merges Anthropic input/output without inventing a missing dimension', async () => {
  const fake = fakeLedger();
  const events = [ { type: 'message_start', message: { id: 'anthropic-receipt', usage: { input_tokens: 100, output_tokens: 0 } } },
    { type: 'message_delta', usage: { output_tokens: 20 } }, { type: 'message_stop' } ];
  const send = createAccountingFetch('anthropic', async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }), fake.factory);
  await runWithStandaloneAccounting(context, () => send('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 4096, system: 'help', messages: [{ role: 'user', content: 'hello' }], stream: true }) }));
  assert.equal(fake.attempts[0].usage?.inputTokens, 100);
  assert.equal(fake.attempts[0].usage?.outputTokens, 20);
  assert.equal(fake.attempts[0].actual_microusd, '400');
});

test('approved reduced revision sends saved revised bytes while matching the original workflow hash', async () => {
  const fake = fakeLedger(true); let sends = 0; let sent = '';
  const send = createAccountingFetch('openai', async (_url, init) => { sends++; sent = String(init?.body); return receipt(); }, fake.factory);
  await assert.rejects(runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request)), isStandaloneAccountingError);
  const attempt = fake.attempts[0];
  const original = attempt.prepared_payload;
  const revised = freezePreparedRequest('openai', 'gpt-4o', '/v1/chat/completions', { ...(original.payload as object), max_tokens: 512 });
  attempt.prepared_payload = revised as unknown as Record<string, unknown>; attempt.prepared_hash = revised.hash; attempt.state = 'reserved';
  attempt.reserved_microusd = estimatePreparedRequest(revised).reservationMicrousd!;
  await runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request));
  assert.equal(sends, 1);
  assert.equal(sent, revised.serializedBody);
  assert.equal(JSON.parse(sent).max_tokens, 512);
});

test('activity attempt keys survive skipping already checkpointed independent memory work', async () => {
  const fake = fakeLedger(); let sends = 0;
  const send = createAccountingFetch('openai', async () => { sends++; return receipt(`receipt-${sends}`); }, fake.factory);
  await runWithStandaloneAccounting(context, async () => {
    await runWithStandaloneActivity('memory', () => send('https://api.openai.com/v1/chat/completions', request));
    await runWithStandaloneActivity('lead', () => send('https://api.openai.com/v1/chat/completions', request));
  });
  await runWithStandaloneAccounting(context, () => runWithStandaloneActivity('lead', () => send('https://api.openai.com/v1/chat/completions', request)));
  assert.equal(sends, 2);
  assert.deepEqual(fake.attempts.map(item => item.attempt_key), ['memory:0', 'lead:0']);
});

test('approved cheaper model revision dispatches and prices the approved model instead of the original', async () => {
  const fake = fakeLedger(true); let sentModel = '';
  const send = createAccountingFetch('openai', async (_url, init) => { sentModel = JSON.parse(String(init?.body)).model; return receipt('cheaper-model-receipt'); }, fake.factory);
  await assert.rejects(runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request)), isStandaloneAccountingError);
  const attempt = fake.attempts[0];
  const revised = freezePreparedRequest('openai', 'gpt-4o-mini', '/v1/chat/completions', { ...(attempt.prepared_payload.payload as object), model: 'gpt-4o-mini', max_tokens: 512 });
  attempt.prepared_payload = revised as unknown as Record<string, unknown>; attempt.prepared_hash = revised.hash; attempt.model = revised.model;
  attempt.supersedes_attempt_id = 'original-paused-attempt'; attempt.state = 'reserved'; attempt.reserved_microusd = estimatePreparedRequest(revised).reservationMicrousd!;
  await runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request));
  assert.equal(sentModel, 'gpt-4o-mini');
  assert.equal(attempt.actual_microusd, '27');
  assert.equal(attempt.state, 'settled');
});

test('truncated Anthropic stream never treats initial usage as a final receipt', async () => {
  const fake = fakeLedger();
  const start = { type: 'message_start', message: { id: 'partial-receipt', usage: { input_tokens: 100, output_tokens: 1 } } };
  const send = createAccountingFetch('anthropic', async () => new Response(`data: ${JSON.stringify(start)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }), fake.factory);
  await assert.rejects(runWithStandaloneAccounting(context, () => send('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 4096, system: 'help', messages: [{ role: 'user', content: 'hello' }], stream: true }) })), isStandaloneAccountingError);
  assert.equal(fake.attempts[0].state, 'uncertain');
  assert.equal(fake.events.includes('settle'), false);
});

test('saved approval with a different pricing version cannot dispatch', async () => {
  const fake = fakeLedger(true); let sends = 0;
  const send = createAccountingFetch('openai', async () => { sends++; return receipt(); }, fake.factory);
  await assert.rejects(runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request)), isStandaloneAccountingError);
  fake.attempts[0].pricing_version = 'old-price'; fake.attempts[0].state = 'reserved';
  await assert.rejects(runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request)), (error: unknown) => isStandaloneAccountingError(error));
  assert.equal(sends, 0);
});

test('deliberately selected GPT-5.5 Pro uses nonstream Responses through the streaming facade', async () => {
  const original = globalThis.fetch; const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ id: 'premium-response', status: 'completed', model: 'gpt-5.5-pro', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Approved answer', annotations: [] }] }] }), { headers: { 'content-type': 'application/json' } }); };
  try {
    const provider = new OpenAiProvider('offline-key');
    const result = await runWithOrchestratorAccounting(() => provider.generateStream({ name: 'Katie', persona: '', summary: '', history: [], user: 'Solve it', modelId: 'gpt-5.5-pro' }, {}));
    assert.equal(result.text, 'Approved answer');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].stream, undefined);
  } finally { globalThis.fetch = original; }
});

test('upstream header request ID survives an interrupted response body without a fabricated response ID', async () => {
  const fake = fakeLedger();
  const send = createAccountingFetch('openai', async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('body interrupted')); } }), { headers: { 'x-request-id': 'observed-upstream-request' } }), fake.factory);
  await assert.rejects(runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request)), isStandaloneAccountingError);
  assert.deepEqual(fake.identifiers, [{ requestId: 'observed-upstream-request', responseId: null }]);
  assert.equal(fake.attempts[0].state, 'uncertain');
  assert.equal(fake.attempts[0].actual_microusd, undefined);
});

test('native function tool dispatch uses the standalone ledger and reconciles its actual HTTP receipt', async () => {
  const ledgerModule = require('../lib/standalone-accounting/ledger') as { createStandaloneLedger: typeof createStandaloneLedger };
  const savedFactory = ledgerModule.createStandaloneLedger, savedFetch = globalThis.fetch;
  const fake = fakeLedger(); let sends = 0;
  ledgerModule.createStandaloneLedger = fake.factory;
  globalThis.fetch = async (_url, init) => {
    sends++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools[0].function.name, 'read_local_file');
    return new Response(JSON.stringify({ id: 'native-tool-receipt', model: 'gpt-4o', choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_local_file', arguments: '{"path":"app.ts"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 20 } }), { headers: { 'content-type': 'application/json', 'x-request-id': 'native-request' } });
  };
  try {
    const turn = await runWithStandaloneAccounting(context, () => nativeToolTurn('openai', 'offline-key', { modelId: 'gpt-4o', system: 'Read a local file', messages: [{ role: 'user', text: 'inspect app.ts' }], tools: [{ name: 'read_local_file', description: 'Read local file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }], signal: new AbortController().signal }));
    assert.equal(turn.calls[0].name, 'read_local_file');
    assert.equal(sends, 1);
    assert.equal(fake.attempts[0].state, 'settled');
    assert.equal(fake.attempts[0].actual_microusd, '500');
    assert.equal(fake.attempts[0].usage?.inputTokens, 120);
    assert.deepEqual(fake.identifiers.at(-1), { requestId: 'native-request', responseId: 'native-tool-receipt' });
  } finally { ledgerModule.createStandaloneLedger = savedFactory; globalThis.fetch = savedFetch; }
});

test('an unpriced resolved model retains known tokens and full exposure without guessing a family rate', async () => {
  const fake = fakeLedger(); let sends = 0;
  const send = createAccountingFetch('openai', async () => {
    sends++;
    return new Response(JSON.stringify({ id: 'unknown-model-response', model: 'gpt-4o-2099-01-01', usage: { prompt_tokens: 100, completion_tokens: 20 } }), { headers: { 'content-type': 'application/json', 'x-request-id': 'unknown-model-request' } });
  }, fake.factory);
  await assert.rejects(runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request)), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'standalone_resolved_model_unpriced'); return true;
  });
  const attempt = fake.attempts[0];
  assert.equal(attempt.state, 'uncertain');
  assert.equal(attempt.actual_microusd, null);
  assert.equal(attempt.usage?.inputTokens, 100);
  assert.equal(attempt.usage?.outputTokens, 20);
  assert.equal(attempt.evidence?.requestedModel, 'gpt-4o');
  assert.equal(attempt.evidence?.resolvedModel, 'gpt-4o-2099-01-01');
  assert.equal(attempt.evidence?.pricingUnknown, true);
  assert.equal(attempt.evidence?.pricedModel, null);
  assert.ok(BigInt(attempt.reserved_microusd) > 0n);
  assert.ok(attempt.response_checkpoint?.body.includes('unknown-model-response'));
  assert.deepEqual(fake.identifiers.at(-1), { requestId: 'unknown-model-request', responseId: 'unknown-model-response' });
  assert.equal(fake.events.includes('settle'), false);
  await assert.rejects(runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request)), isStandaloneAccountingError);
  assert.equal(sends, 1, 'A saved unresolved receipt must not cause another transmission');
});

test('a different exactly priced resolved model settles using its own reviewed rate and retains both model IDs', async () => {
  const fake = fakeLedger();
  const send = createAccountingFetch('openai', async () => new Response(JSON.stringify({ id: 'different-model-response', model: 'gpt-4o-mini', usage: { prompt_tokens: 100, completion_tokens: 20 } }), { headers: { 'content-type': 'application/json' } }), fake.factory);
  await runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request));
  const attempt = fake.attempts[0];
  assert.equal(attempt.state, 'settled');
  assert.equal(attempt.actual_microusd, '27', 'Requested GPT-4o would cost450 microUSD for this usage');
  assert.equal(attempt.evidence?.requestedModel, 'gpt-4o');
  assert.equal(attempt.evidence?.resolvedModel, 'gpt-4o-mini');
  assert.equal(attempt.evidence?.pricedModel, 'gpt-4o-mini');
  assert.equal(attempt.evidence?.pricingUnknown, false);
});

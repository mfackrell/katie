import { PRICING_SNAPSHOT, type PricingSnapshot } from '../lib/standalone-accounting/pricing';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createAccountingFetch } from '../lib/standalone-accounting/dispatch';
import { runWithStandaloneAccounting, runWithOrchestratorAccounting, runWithStandaloneActivity, isStandaloneAccountingError, standaloneAccountingCause } from '../lib/standalone-accounting/context';
import { freezePreparedRequest, estimatePreparedRequest } from '../lib/standalone-accounting/estimate';
import { createStandaloneLedger } from '../lib/standalone-accounting/ledger';
import type { LedgerAttempt, AdmitAttemptInput, ResponseCheckpoint, SettlementInput } from '../lib/standalone-accounting/types';
import { OpenAiProvider } from '../lib/providers/openai-provider';
import { nativeToolTurn } from '../lib/providers/native-tools';
import * as accountingDispatch from '../lib/standalone-accounting/dispatch';
import { googleGenerateContent } from '../lib/providers/google-transport';
import type { GenerateContentParameters } from '@google/genai';
import { selectStoredAttachments } from '../lib/chat/attachment-selection';
import { ClaudeProvider } from '../lib/providers/claude-provider';
import { claudeCachedSystem } from '../lib/providers/claude-cache';

const context = { userId: 'owner', actorId: 'actor', chatId: 'chat', requestId: 'request' };
const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] }) };
const receipt = (id = 'receipt-1') => new Response(JSON.stringify({ id, choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { headers: { 'content-type': 'application/json' } });
function fakeLedger(paused = false) {
  const attempts: LedgerAttempt[] = [];
  const events: string[] = [];
  const identifiers: Array<{ requestId: string | null; responseId: string | null }> = [];
  const service = {
    async uncertainExposureAccepted() { return false; },
    async loadPricing() { return {snapshot:PRICING_SNAPSHOT,retrievedAt:new Date().toISOString()}; },
    async registerPricing() { events.push('pricing'); return true; },
    async lookupAttempt(_owner: string, _request: string, key: string) { return attempts.find(item => item.attempt_key === key) ?? null; },
    async admit(input: AdmitAttemptInput) {
      events.push('admit');
      const attempt = { id: `attempt-${attempts.length}`, owner_id: input.ownerId, actor_id: input.actorId, chat_id: input.chatId, request_id: input.requestId,
        attempt_key: input.attemptKey, base_attempt_key: input.attemptKey, source_prepared_hash: input.preparedHash, prepared_hash: input.preparedHash,
        prepared_payload: input.preparedPayload, pricing_version: input.pricingVersion, reserved_microusd: input.reservedMicrousd,
        preflight_estimate: input.preflightEstimate, estimator_version: input.estimatorVersion, reason: input.reason,
        provider: input.provider, model: input.model, category: input.category, state: paused ? 'paused' : 'reserved', response_checkpoint: null } as LedgerAttempt;
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

for (const native of [false, true]) {
  test(`Claude five-minute cache prefix is frozen, reserved and priced through the real ${native ? 'native tool' : 'chat'} adapter`, async () => {
    const ledgerModule = require('../lib/standalone-accounting/ledger') as { createStandaloneLedger: typeof createStandaloneLedger };
    const savedFactory = ledgerModule.createStandaloneLedger, savedFetch = globalThis.fetch;
    const fake = fakeLedger(); let sentBody: Record<string, unknown> | undefined; let sentSerialized = '';
    ledgerModule.createStandaloneLedger = fake.factory;
    globalThis.fetch = async (_url, init) => {
      sentSerialized = String(init?.body); sentBody = JSON.parse(sentSerialized);
      return new Response(JSON.stringify({ id: 'claude-cache-response', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Cached answer' }], stop_reason: 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 200, output_tokens: 20 } }), { headers: { 'content-type': 'application/json' } });
    };
    try {
      const result = await runWithStandaloneAccounting(context, () => native
        ? nativeToolTurn('anthropic', 'offline-key', { modelId: 'claude-sonnet-5-5', system: 'Stable instructions\n\nCURRENT_REQUEST_TIMESTAMP_UTC: dynamic', cacheablePersona: 'Stable instructions', messages: [{ role: 'user', text: 'Answer' }], tools: [{ name: 'read_local_file', description: 'Read local file', parameters: { type: 'object' } }], signal: new AbortController().signal }).then(turn => turn.response)
        : new ClaudeProvider('offline-key').generate({ modelId: 'claude-sonnet-5-5', name: 'Katie', persona: 'Stable instructions\n\nCURRENT_REQUEST_TIMESTAMP_UTC: dynamic', cacheablePersona: 'Stable instructions', summary: '', history: [], user: 'Answer' }));
      const attempt = fake.attempts[0];
      assert.equal(attempt.state, 'settled');
      assert.equal(attempt.actual_microusd, '730', 'Ten uncached +100 read +200 five-minute write +20 output tokens use their distinct reviewed rates');
      assert.equal(attempt.usage?.inputTokens, 310);
      assert.equal(attempt.usage?.cacheReadInputTokens, 100);
      assert.equal(attempt.usage?.cacheWriteInputTokens, 200);
      assert.equal(attempt.usage?.cacheCreationInputTokens, 200);
      assert.equal(attempt.usage?.cacheWriteTtl, '5m');
      assert.equal(result.usage?.inputTokens, 310);
      assert.equal(result.usage?.cacheCreationInputTokens, 200);
      const system = sentBody?.system as Array<{ text: string; cache_control?: unknown }>;
      assert.deepEqual(system[0].cache_control, { type: 'ephemeral', ttl: '5m' });
      assert.ok(!system[0].text.includes('CURRENT_REQUEST_TIMESTAMP'));
      assert.ok(system[1].text.includes('CURRENT_REQUEST_TIMESTAMP_UTC: dynamic'));
      assert.equal(system[1].cache_control, undefined);
      assert.deepEqual((attempt.prepared_payload.payload as Record<string, unknown>).system, system);
      assert.equal(attempt.prepared_payload.serializedBody, sentSerialized);
      assert.equal(attempt.preflight_estimate.cacheWriteTtl, '5m');
      assert.ok(Number(attempt.preflight_estimate.cacheWriteInputAllowance) > 0);
    } finally { ledgerModule.createStandaloneLedger = savedFactory; globalThis.fetch = savedFetch; }
  });
}

test('Claude SSE final receipt prices five-minute writes proven by a conserving lifetime split', async () => {
  const fake = fakeLedger();
  const events = [
    { type: 'message_start', message: { id: 'claude-cache-stream', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 }, output_tokens: 1 } } },
    { type: 'message_delta', usage: { output_tokens: 20 } }, { type: 'message_stop' },
  ];
  const send = createAccountingFetch('anthropic', async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')), fake.factory);
  await runWithStandaloneAccounting(context, () => send('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 4096, system: 'System with no requested breakpoint', messages: [{ role: 'user', content: 'Answer' }], stream: true }) }));
  assert.equal(fake.attempts[0].state, 'settled');
  assert.equal(fake.attempts[0].actual_microusd, '730');
  assert.equal(fake.attempts[0].usage?.inputTokens, 310);
  assert.equal(fake.attempts[0].usage?.cacheWriteInputTokens, 200);
  assert.equal(fake.attempts[0].usage?.cacheWriteTtl, '5m');
});

test('Claude default five-minute request policy proves the write lifetime when the receipt has no lifetime split', async () => {
  const fake = fakeLedger();
  const send = createAccountingFetch('anthropic', async () => new Response(JSON.stringify({ id: 'claude-default-cache', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 200, output_tokens: 20 } })), fake.factory);
  await runWithStandaloneAccounting(context, () => send('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 4096, system: [{ type: 'text', text: 'Stable prefix', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'Answer' }] }) }));
  assert.equal(fake.attempts[0].state, 'settled');
  assert.equal(fake.attempts[0].actual_microusd, '730');
  assert.equal(fake.attempts[0].usage?.cacheWriteTtl, '5m');
});

for (const scenario of ['one-hour', 'missing-lifetime', 'conflicting-split', 'schema-is-not-policy'] as const) {
  test(`Claude ${scenario} cache writes retain known tokens and exposure without a fabricated cache price`, async () => {
    const fake = fakeLedger();
    const split = scenario === 'one-hour' ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 }
      : scenario === 'conflicting-split' ? { ephemeral_5m_input_tokens: 199, ephemeral_1h_input_tokens: 0 } : undefined;
    const send = createAccountingFetch('anthropic', async () => new Response(JSON.stringify({ id: `claude-${scenario}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 200, ...(split ? { cache_creation: split } : {}), output_tokens: 20 } })), fake.factory);
    const system = scenario === 'one-hour' || scenario === 'conflicting-split' ? claudeCachedSystem('Stable\nDynamic', 'Stable') : 'No provider cache policy';
    const tools = scenario === 'schema-is-not-policy' ? [{ name: 'read_local_file', input_schema: { type: 'object', properties: { cache_control: { const: { type: 'ephemeral', ttl: '5m' } } } } }] : undefined;
    await assert.rejects(runWithStandaloneAccounting(context, () => send('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 4096, system, ...(tools ? { tools } : {}), messages: [{ role: 'user', content: 'Answer' }] }) })), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'standalone_usage_unpriced'); return true;
    });
    const attempt = fake.attempts[0];
    assert.equal(attempt.state, 'uncertain');
    assert.equal(attempt.actual_microusd, null);
    assert.equal(attempt.usage?.inputTokens, 310);
    assert.equal(attempt.usage?.cacheCreationInputTokens, 200);
    assert.equal(attempt.usage?.cacheWriteInputTokens, 200);
    assert.equal(attempt.evidence?.pricingUnknown, true);
    assert.ok(BigInt(attempt.reserved_microusd) > 0n);
    assert.equal(fake.events.includes('settle'), false);
  });
}


// Capture before per-test transport replacement; all accounting policy stays real.
const actualAccountingFetch = createAccountingFetch;
function googleFixture(t: TestContext) {
  const fake = fakeLedger(true), sent: string[] = [];
  t.mock.method(accountingDispatch, 'createAccountingFetch', (provider: Parameters<typeof createAccountingFetch>[0]) =>
    actualAccountingFetch(provider, async (_url, init) => {
      sent.push(String(init?.body));
      return new Response(JSON.stringify({ responseId: 'google-fixture', modelVersion: 'gemini-2.5-flash',
        candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify({
          selections: [{ id: 'saved', mode: 'source' }], rationale: 'Named saved file.'
        }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 0 }
      }), { headers: { 'content-type': 'application/json' } });
    }, fake.factory));
  return { ...fake, sent };
}

test('saved attachment selector approves normalized Google REST bytes and sends that exact quote on resume', async t => {
  const f = googleFixture(t), previous = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = 'offline-fixture';
  t.after(() => { if (previous === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = previous; });
  const catalog = [{ id: 'saved', fileName: 'budget.pdf', mimeType: 'application/pdf', observedSummary: 'Budget report', summaryCoverage: 'full' as const }];
  const select = () => selectStoredAttachments('Read budget.pdf', catalog, []);
  await assert.rejects(runWithStandaloneAccounting(context, select), { code: 'standalone_approval_required' });
  assert.equal(f.sent.length, 0); assert.equal(f.attempts.length, 1);
  const a = f.attempts[0], quoted = a.prepared_payload as unknown as ReturnType<typeof freezePreparedRequest>;
  assert.equal(a.category, 'attachment-selection');
  assert.deepEqual(quoted.payload.contents, [{ role: 'user', parts: [{ text: JSON.stringify({
    request: 'Read budget.pdf', taskContext: null, newlyAttachedFiles: [], recentConversation: [],
    files: [{ id: 'saved', name: 'budget.pdf', mimeType: 'application/pdf', coverage: 'full', summary: 'Budget report' }]
  }) }] }]);
  assert.ok(quoted.payload.systemInstruction);
  assert.equal(a.preflight_estimate.requestHash, quoted.hash);
  assert.equal(estimatePreparedRequest(quoted).reservationMicrousd, a.reserved_microusd);
  // The approval RPC itself is exercised against PostgreSQL in the ledger suite.
  const approvedHash = a.prepared_hash; a.state = 'reserved';
  const decision = await runWithStandaloneAccounting(context, select);
  assert.equal(decision.method, 'summary-selector'); assert.equal(decision.selections[0].attachment.id, 'saved');
  assert.equal(decision.rationale, 'Named saved file.', 'current main attachment diagnostics survive');
  assert.equal(a.state, 'settled'); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0], quoted.serializedBody);
  assert.equal(freezePreparedRequest('google', quoted.model, quoted.endpoint, JSON.parse(f.sent[0])).hash, approvedHash);
  await runWithStandaloneAccounting(context, select);
  assert.equal(f.sent.length, 1, 'settled selector replays without another transmission');
});

test('Google SDK content unions group strings/parts and preserve explicit turns and system instructions', async t => {
  const f = googleFixture(t);
  const turns = [{ role: 'user', parts: [{ text: 'hello' }] }, { role: 'model', parts: [{ functionCall: { name: 'lookup', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { ok: true } } }] }];
  const cases: Array<[GenerateContentParameters['contents'], unknown]> = [
    ['hello', [{ role: 'user', parts: [{ text: 'hello' }] }]],
    [{ text: 'hello' }, [{ role: 'user', parts: [{ text: 'hello' }] }]],
    [['hello', { text: 'world' }], [{ role: 'user', parts: [{ text: 'hello' }, { text: 'world' }] }]],
    [{ role: 'model', parts: [{ text: 'answer' }] }, [{ role: 'model', parts: [{ text: 'answer' }] }]],
    [turns, turns],
  ];
  for (const [contents, expected] of cases) {
    const before = JSON.stringify(contents);
    await assert.rejects(runWithStandaloneAccounting({ ...context, requestId: 'shape-' + f.attempts.length }, () => googleGenerateContent('offline-fixture', {
      model: 'gemini-2.5-flash', contents,
      config: { systemInstruction: ['system', { text: 'rules' }], maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } }
    })), isStandaloneAccountingError);
    const body = f.attempts.at(-1)!.prepared_payload.payload as Record<string, unknown>;
    assert.deepEqual(body.contents, expected);
    assert.deepEqual(body.systemInstruction, { role: 'user', parts: [{ text: 'system' }, { text: 'rules' }] });
    assert.equal(JSON.stringify(contents), before);
    // Each independent workflow starts its activity counter at zero.
    f.attempts.length = 0;
  }
  assert.equal(f.sent.length, 0);
});

test('invalid mixed/empty/unscoped function Google inputs fail before estimation or admission', async t => {
  const f = googleFixture(t);
  for (const contents of [[], null, [{ role: 'user', parts: [{ text: 'hello' }] }, 'mixed'], { functionCall: { name: 'lookup' } }, [{ functionResponse: { name: 'lookup' } }]]) {
    await assert.rejects(runWithStandaloneAccounting(context, () => googleGenerateContent('offline-fixture', {
      model: 'gemini-2.5-flash', contents: contents as GenerateContentParameters['contents']
    })));
    assert.equal(f.attempts.length, 0); assert.equal(f.sent.length, 0);
  }
});

test('cost admission allows a cheap Pro name and pauses an expensive ordinary name; approval uses its historical price after refresh',async()=>{
 for(const [model,inputNanoUsd,shouldPause] of [['fixture-pro','100',false],['fixture-ordinary','1000000',true]] as const){
  const f=fakeLedger();let sends=0;
  const snapshot={...PRICING_SNAPSHOT,version:'fixture-price-v1',models:[{provider:'openai' as const,model,inputNanoUsd,outputNanoUsd:'100',maxContextTokens:100000,maxOutputTokens:1000,source:'fixture'}]};
  let current:PricingSnapshot={...snapshot};
  f.service.loadPricing=async version=>({snapshot:version===snapshot.version?snapshot:current,retrievedAt:new Date().toISOString()});
  const admit=f.service.admit;f.service.admit=async input=>{const a=await admit(input);a.state=BigInt(input.reservedMicrousd)>5000n?'paused':'reserved';return a;};
  const send=createAccountingFetch('openai',async()=>{sends++;return receipt();},f.factory);
  const payload={method:'POST',body:JSON.stringify({model,input:'hello',max_output_tokens:10})};
  const execute=()=>runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/responses',payload));
  if(shouldPause){
   await assert.rejects(execute(),{code:'standalone_approval_required'});assert.equal(sends,0);
   const approved=f.attempts[0];assert.equal(approved.pricing_version,snapshot.version);
   approved.state='reserved';await execute();assert.equal(sends,1);
   assert.equal(approved.actual_microusd,'100002','receipt uses the v1 rate applicable at dispatch');
   current={...snapshot,version:'fixture-price-v2',models:[{...snapshot.models[0],inputNanoUsd:'2000000'}]};
   await execute();assert.equal(sends,1,'settled approval replay does not dispatch');
  }else{await execute();assert.equal(sends,1);assert.equal(f.attempts[0].state,'settled');}
 }
});

test('current OpenAI cache-write receipts reconcile against the selected TTL instead of losing write charges',async()=>{
 const f=fakeLedger();const snapshot={...PRICING_SNAPSHOT,version:'fixture-cache-v1',models:[{provider:'openai' as const,model:'fixture-sol',inputNanoUsd:'1000',outputNanoUsd:'2000',cachedInputNanoUsd:'100',cacheWriteNanoUsd:'1250',cacheWrite12hNanoUsd:'2500',maxContextTokens:100000,maxOutputTokens:10000,source:'fixture'}]};
 f.service.loadPricing=async()=>({snapshot,retrievedAt:new Date().toISOString()});
 const send=createAccountingFetch('openai',async()=>new Response(JSON.stringify({id:'cache-receipt',model:'fixture-sol',usage:{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:20,cache_write_tokens:30}}})),f.factory);
 await runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/responses',{method:'POST',body:JSON.stringify({model:'fixture-sol',input:'hello',max_output_tokens:10,prompt_cache_key:'scope',prompt_cache_options:{ttl:'12h'}})}));
 assert.equal(f.attempts[0].actual_microusd,'147');assert.equal(f.attempts[0].usage?.cacheWriteInputTokens,30);assert.equal(f.attempts[0].usage?.cacheWriteTtl,'12h');
});

test('application storage image URLs are frozen before approval without fetching arbitrary external URLs',async t=>{
 const before=process.env.NEXT_PUBLIC_SUPABASE_URL;process.env.NEXT_PUBLIC_SUPABASE_URL='https://storage.example.test';
 t.after(()=>{if(before===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_URL;else process.env.NEXT_PUBLIC_SUPABASE_URL=before;});
 const bytes=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(128,16);bytes.writeUInt32BE(128,20);
 let reads=0,sends=0;const f=fakeLedger(true);
 t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL,init?:RequestInit)=>{reads++;assert.equal(String(url),'https://storage.example.test/storage/v1/object/sign/uploads/photo.png?token=fixture');assert.equal(init?.redirect,'error');assert.equal(init?.headers,undefined);return new Response(bytes,{headers:{'content-type':'image/png'}});});
 const send=createAccountingFetch('openai',async()=>{sends++;return receipt();},f.factory);
 const body={model:'gpt-4o',messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://storage.example.test/storage/v1/object/sign/uploads/photo.png?token=fixture'}}]}],max_tokens:10};
 await assert.rejects(runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/chat/completions',{method:'POST',body:JSON.stringify(body)})),{code:'standalone_approval_required'});
 assert.equal(reads,1);assert.equal(sends,0);assert.ok(String(f.attempts[0].prepared_payload.serializedBody).includes('data:image/png;base64,'));assert.ok(!String(f.attempts[0].prepared_payload.serializedBody).includes('token=fixture'));
 body.messages[0].content[0].image_url.url='https://untrusted.example.test/photo.png';
 await assert.rejects(runWithStandaloneAccounting({...context,requestId:'external'},()=>send('https://api.openai.com/v1/chat/completions',{method:'POST',body:JSON.stringify(body)})),isStandaloneAccountingError);
 assert.equal(reads,1,'untrusted URL was never fetched');assert.equal(sends,0);
});

test('a changed pending model price creates an unapproved replacement instead of spending on a stale approval',async()=>{
 const f=fakeLedger(true);let sends=0;
 const original:PricingSnapshot={...PRICING_SNAPSHOT,version:'fixture-old',models:[{...PRICING_SNAPSHOT.models[0]}]};
 let current=original;
 f.service.loadPricing=async version=>({snapshot:version===original.version?original:current,retrievedAt:new Date().toISOString()});
 f.service.lookupAttempt=async()=>f.attempts.at(-1)??null;
 f.service.reprice=async(_owner,id,version,estimate)=>{
  const parent=f.attempts.find(a=>a.id===id)!;
  const next={...parent,id:'repriced',state:'paused' as const,pricing_version:version,preflight_estimate:estimate,reserved_microusd:String(estimate.reservationMicrousd),supersedes_attempt_id:parent.id,pause_reason:'pricing_updated'};
  parent.state='cancelled';f.attempts.push(next);return next;
 };
 const send=createAccountingFetch('openai',async()=>{sends++;return receipt();},f.factory);
 const execute=()=>runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/chat/completions',request));
 await assert.rejects(execute(),{code:'standalone_approval_required'});
 const old=f.attempts[0],oldEstimate=structuredClone(old.preflight_estimate);old.state='reserved';
 current={...original,version:'fixture-new',models:[{...original.models[0],inputNanoUsd:'5000'}]};
 await assert.rejects(execute(),{code:'standalone_approval_required'});assert.equal(sends,0);assert.equal(f.attempts.length,2);
 assert.equal(old.state,'cancelled');assert.deepEqual(old.preflight_estimate,oldEstimate);assert.equal(f.attempts[1].pricing_version,current.version);
 f.attempts[1].state='reserved';await execute();assert.equal(sends,1);assert.equal(f.attempts[1].actual_microusd,'700');
});

test('missing modern OpenAI write counts retain exposure rather than billing writes as zero',async()=>{
 const f=fakeLedger();const snapshot={...PRICING_SNAPSHOT,version:'fixture-missing-write',models:[{provider:'openai' as const,model:'fixture-sol',inputNanoUsd:'1000',outputNanoUsd:'2000',cacheWriteNanoUsd:'1250',maxContextTokens:100000,maxOutputTokens:10000,source:'fixture'}]};
 f.service.loadPricing=async()=>({snapshot,retrievedAt:new Date().toISOString()});
 const send=createAccountingFetch('openai',async()=>new Response(JSON.stringify({id:'missing-write',usage:{input_tokens:100,output_tokens:10}})),f.factory);
 await assert.rejects(runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/responses',{method:'POST',body:JSON.stringify({model:'fixture-sol',input:'hello',max_output_tokens:10})})),{code:'standalone_usage_unpriced'});
 assert.equal(f.attempts[0].state,'uncertain');assert.equal(f.attempts[0].actual_microusd,null);assert.equal(f.attempts[0].usage?.inputTokens,100);assert.equal(f.attempts[0].usage?.cacheWriteInputTokens,undefined,'missing write usage must remain unknown for late reconciliation');
});

test('durable resume dispatches the exact approved preparation despite mutable upstream routing metadata', async () => {
  const fake = fakeLedger(true);
  const bodies: string[] = [];
  const send = createAccountingFetch('openai', async (_url, init) => { bodies.push(String(init?.body)); return receipt(); }, fake.factory);
  await assert.rejects(runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request)), isStandaloneAccountingError);
  const attempt = fake.attempts[0];
  const approved = attempt.prepared_payload;
  const hash = attempt.prepared_hash, version = attempt.pricing_version;
  attempt.state = 'reserved';
  const changed = {...request, body: JSON.stringify({model:'gpt-4o',messages:[{role:'user',content:'Regenerated routing scores differ'}]})};
  await runWithStandaloneAccounting({...context,resumed:true}, () => send('https://api.openai.com/v1/chat/completions', changed));
  await runWithStandaloneAccounting({...context,resumed:true}, () => send('https://api.openai.com/v1/chat/completions', changed));
  assert.deepEqual(bodies, [approved.serializedBody]);
  assert.equal(attempt.prepared_hash, hash); assert.equal(attempt.pricing_version, version);
  assert.equal(fake.attempts.length, 1); assert.equal(attempt.state, 'settled');
});


test('OpenAI Connection error preserves the exact pre-transmission replay mismatch cause', async () => {
  const fake=fakeLedger(true); let sends=0;
  const client=new OpenAI({apiKey:'offline-test',maxRetries:0,fetch:createAccountingFetch('openai',async()=>{sends++;return receipt();},fake.factory)});
  const invoke=(content:string)=>runWithStandaloneAccounting(context,()=>client.chat.completions.create({model:'gpt-4o',messages:[{role:'user',content}]}));
  await assert.rejects(invoke('Original routing candidate metadata'),isStandaloneAccountingError);
  fake.attempts[0].state='reserved';
  await assert.rejects(invoke('Changed routing candidate metadata'),error=>{
    assert.match((error as Error).message,/Connection error/);
    assert.equal(standaloneAccountingCause(error)?.code,'standalone_replay_mismatch');
    assert.match(standaloneAccountingCause(error)!.message,/prepared request changed/);
    return true;
  });
  assert.equal(sends,0); assert.equal(fake.attempts[0].state,'reserved');
});


test('accepted uncertain exposure replays complete saved output without settlement or retransmission', async () => {
 const f=fakeLedger();let sends=0;const accepted=new Set<string>();
 f.service.uncertainExposureAccepted=async(_owner,id)=>accepted.has(id);
 const send=createAccountingFetch('openai',async()=>{sends++;return Response.json({id:'unconfirmed-'+sends,choices:[{finish_reason:'stop',message:{content:'real saved output'}}]});},f.factory);
 await assert.rejects(runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/chat/completions',request)),{code:'standalone_outcome_unknown'});
 const uncertain=f.attempts[0];const retained=JSON.stringify(uncertain);
 await assert.rejects(runWithStandaloneAccounting({...context,resumed:true},()=>send('https://api.openai.com/v1/chat/completions',request)),{code:'standalone_outcome_unknown'});
 accepted.add(uncertain.id);
 for(let restart=0;restart<2;restart++){
   const response=await runWithStandaloneAccounting({...context,resumed:true},()=>send('https://api.openai.com/v1/chat/completions',request));
   assert.match(await response.text(),/real saved output/);
 }
 assert.equal(sends,1);assert.equal(JSON.stringify(uncertain),retained,'state, identity, evidence and full reservation remain untouched');
 assert.equal(f.events.filter(event=>event==='settle').length,0);
 // The remaining logical call is a distinct ordinal and still enters admission.
 await assert.rejects(runWithStandaloneAccounting({...context,resumed:true},async()=>{
   await send('https://api.openai.com/v1/chat/completions',request);
   await send('https://api.openai.com/v1/chat/completions',request);
 }),{code:'standalone_outcome_unknown'});
 assert.equal(sends,2);assert.equal(f.attempts.length,2);assert.equal(f.attempts[1].state,'uncertain');
 assert.equal(await f.service.uncertainExposureAccepted(context.userId,f.attempts[1].id),false,'a second uncertain attempt needs a new decision');
});

test('accepting exposure never fabricates a missing or incomplete provider result',async()=>{
 const f=fakeLedger();let sends=0;
 const send=createAccountingFetch('openai',async()=>{sends++;throw Error('socket lost');},f.factory);
 await assert.rejects(runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/chat/completions',request)),isStandaloneAccountingError);
 f.service.uncertainExposureAccepted=async()=>true;
 for(const checkpoint of [null,{status:200,statusText:'OK',headers:[],body:JSON.stringify({choices:[{message:{content:'partial'},finish_reason:null}]})}] as Array<ResponseCheckpoint|null>){
  f.attempts[0].response_checkpoint=checkpoint;
  await assert.rejects(runWithStandaloneAccounting({...context,resumed:true},()=>send('https://api.openai.com/v1/chat/completions',request)),{code:'standalone_safe_checkpoint_unavailable'});
 }
 assert.equal(sends,1);assert.equal(f.attempts[0].state,'uncertain');
});


test('accepted exposure cannot promote truncated streaming output to a safe checkpoint',async()=>{
 for(const provider of ['openai','anthropic'] as const){
  const f=fakeLedger();let sends=0;
  const stream=provider==='openai'?'data: '+JSON.stringify({choices:[{delta:{content:'partial'},finish_reason:'length'}]})+'\n\ndata: [DONE]\n\n'
   :'data: '+JSON.stringify({type:'message_delta',delta:{stop_reason:'max_tokens'}})+'\n\ndata: '+JSON.stringify({type:'message_stop'})+'\n\n';
  const send=createAccountingFetch(provider,async()=>{sends++;return new Response(stream,{headers:{'content-type':'text/event-stream'}});},f.factory);
  const url=provider==='openai'?'https://api.openai.com/v1/chat/completions':'https://api.anthropic.com/v1/messages';
  const body={method:'POST',body:JSON.stringify({model:provider==='openai'?'gpt-4o':'claude-sonnet-5-5',messages:[{role:'user',content:'hello'}],stream:true})};
  await assert.rejects(runWithStandaloneAccounting(context,()=>send(url,body)),isStandaloneAccountingError);
  f.service.uncertainExposureAccepted=async()=>true;
  await assert.rejects(runWithStandaloneAccounting({...context,resumed:true},()=>send(url,body)),{code:'standalone_safe_checkpoint_unavailable'});
  assert.equal(sends,1);assert.equal(f.attempts[0].state,'uncertain');
 }
});

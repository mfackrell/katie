import { PRICING_SNAPSHOT, type PricingSnapshot } from '../lib/standalone-accounting/pricing';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createAccountingFetch } from '../lib/standalone-accounting/dispatch';
import { runWithStandaloneAccounting, runWithOrchestratorAccounting, runWithStandaloneActivity, runWithDurablePostAnswerAccounting, isStandaloneAccountingError, standaloneAccountingCause } from '../lib/standalone-accounting/context';
import { freezePreparedRequest, prepareStandaloneRequest, estimatePreparedRequest } from '../lib/standalone-accounting/estimate';
import { createStandaloneLedger } from '../lib/standalone-accounting/ledger';
import type { LedgerAttempt, AdmitAttemptInput, ResponseCheckpoint, SettlementInput } from '../lib/standalone-accounting/types';
import { OpenAiProvider } from '../lib/providers/openai-provider';
import { openAiCacheSettings } from '../lib/providers/openai-cache';
import { nativeToolTurn } from '../lib/providers/native-tools';
import * as accountingDispatch from '../lib/standalone-accounting/dispatch';
import { describeAttachmentEvidence } from '../lib/uploads/attachment-observations';
import { googleGenerateContent } from '../lib/providers/google-transport';
import { recordProviderTrace, readProviderResponseText, runProviderAttemptTrace, type ProviderTraceEvent } from '../lib/diagnostics/provider-attempt-timing';
import type { GenerateContentParameters } from '@google/genai';
import { selectStoredAttachments } from '../lib/chat/attachment-selection';
import { ClaudeProvider } from '../lib/providers/claude-provider';
import { claudeCachedSystem } from '../lib/providers/claude-cache';

const context = { userId: 'owner', actorId: 'actor', chatId: 'chat', requestId: 'request' };

test('bounded xAI Responses Web Search settles provider reported tool-inclusive cost and replays without a second call',async()=>{
  const fake=fakeLedger();let sends=0;
  const body={model:'grok-4.3',input:[{role:'user',content:[{type:'input_text',text:'Find Wild Horse Nine'}]}],
    tools:[{type:'web_search'}],include:['web_search_call.action.sources'],
    max_turns:1,parallel_tool_calls:false,max_output_tokens:2048};
  const result=()=>new Response(JSON.stringify({
    id:'resp_web_1',status:'completed',model:'grok-4.3',
    output:[{type:'web_search_call',status:'completed',action:{sources:[{url:'https://example.com/source'}]}},
      {type:'message',content:[{type:'output_text',text:'Grounded source summary'}]}],
    usage:{input_tokens:240,output_tokens:80,total_tokens:320,
      cost_in_usd_ticks:60000000,num_server_side_tools_used:1,
      server_side_tool_usage_details:{web_search_calls:1,x_search_calls:0,x_posts_fetched:0,x_users_fetched:0,
        code_interpreter_calls:0,file_search_calls:0,mcp_calls:0,document_search_calls:0,image_generation_calls:0}}
  }),{headers:{'content-type':'application/json'}});
  const send=createAccountingFetch('grok',async(_url,init)=>{
    sends++;assert.equal(JSON.parse(String(init?.body)).max_turns,1);
    assert.equal(JSON.parse(String(init?.body)).parallel_tool_calls,false);return result();
  },fake.factory);
  const first=await runWithStandaloneAccounting(context,()=>send('https://api.x.ai/v1/responses',{method:'POST',body:JSON.stringify(body)}));
  const replay=await runWithStandaloneAccounting(context,()=>send('https://api.x.ai/v1/responses',{method:'POST',body:JSON.stringify(body)}));
  assert.equal(await first.text(),await replay.text());
  assert.equal(sends,1);
  assert.equal(fake.attempts.length,1);
  assert.equal(fake.attempts[0].state,'settled');
  assert.equal(fake.attempts[0].actual_microusd,'6000');
  assert.equal(fake.attempts[0].usage?.cost_in_usd_ticks,60000000);
  assert.equal(fake.attempts[0].evidence?.webSearchCalls,1);
  assert.equal(fake.attempts[0].evidence?.providerCostTicks,'60000000');
  assert.ok(BigInt(fake.attempts[0].reserved_microusd)>=BigInt(fake.attempts[0].actual_microusd!));
});

test('unpriced, unbounded or mixed xAI server tools fail preflight without spending',async()=>{
  const fake=fakeLedger();let sends=0;
  const send=createAccountingFetch('grok',async()=>{sends++;throw Error('must not send');},fake.factory);
  const base={model:'grok-4.3',input:'Lookup',max_turns:1,max_output_tokens:2048,
    parallel_tool_calls:false,include:['web_search_call.action.sources'],tools:[{type:'web_search'}]};
  const invalid=[
    {...base,include:['web_search_call.action.sources','unexpected']},
    {...base,tools:[{type:'web_search'},{type:'x_search'}]},
    {...base,max_turns:2},
    {...base,parallel_tool_calls:true},
    {...base,max_output_tokens:8192},
    {...base,tools:[{type:'web_search',enable_image_search:true}]},
    {...base,include:undefined},
  ];
  for(const payload of invalid){
    const checked=Object.fromEntries(Object.entries(payload).filter(([,value])=>value!==undefined));
    await assert.rejects(runWithStandaloneAccounting({...context,requestId:'blocked-'+invalid.indexOf(payload)},()=>
      send('https://api.x.ai/v1/responses',{method:'POST',body:JSON.stringify(checked)})),isStandaloneAccountingError);
  }
  assert.equal(sends,0);
  assert.equal(fake.attempts.length,0);
});

test('unverified xAI web usage stays uncertain and can never be retransmitted',async()=>{
  for(const usageOverride of [
    {cost_in_usd_ticks:undefined},
    {server_side_tool_usage_details:{web_search_calls:2}},
    {server_side_tool_usage_details:{web_search_calls:1,x_search_calls:1}},
    {cost_in_usd_ticks:100000000000},
  ]){
    const fake=fakeLedger();let sends=0;
    const body={model:'grok-4.3',input:'Look up topic',max_turns:1,max_output_tokens:2048,
      parallel_tool_calls:false,include:['web_search_call.action.sources'],tools:[{type:'web_search'}]};
    const usage={input_tokens:200,output_tokens:70,total_tokens:270,
      cost_in_usd_ticks:60000000,server_side_tool_usage_details:{web_search_calls:1},...usageOverride};
    const send=createAccountingFetch('grok',async()=>{sends++;
      return new Response(JSON.stringify({id:'resp_failed',status:'completed',model:'grok-4.3',output:[{type:'message',content:[]}],usage}));
    },fake.factory);
    await runWithStandaloneAccounting(context,()=>
      send('https://api.x.ai/v1/responses',{method:'POST',body:JSON.stringify(body)}));
    assert.equal(fake.attempts[0].state,'uncertain');
    assert.ok(fake.attempts[0].response_checkpoint,'the original response remains durable');
    await runWithStandaloneAccounting(context,()=>send('https://api.x.ai/v1/responses',{method:'POST',body:JSON.stringify(body)}));
    assert.equal(sends,1);
  }
});

const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] }) };
const receipt = (id = 'receipt-1') => new Response(JSON.stringify({ id, choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { headers: { 'content-type': 'application/json' } });
function fakeLedger(paused = false, pricing: PricingSnapshot = PRICING_SNAPSHOT) {
  const attempts: LedgerAttempt[] = [];
  const events: string[] = [];
  const identifiers: Array<{ requestId: string | null; responseId: string | null }> = [];
  const uncertaintyReasons: string[] = [];
  const service = {
    async uncertainExposureAccepted() { return false; },
    async loadPricing() { return {snapshot:pricing,retrievedAt:new Date().toISOString()}; },
    async publishPricing() { return true; },
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
    async markUncertain(_owner: string, id: string, reason?: string) { events.push('uncertain'); uncertaintyReasons.push(reason ?? ''); const attempt = attempts.find(item => item.id === id)!; attempt.state = 'uncertain'; return attempt; },
    async cancel(_owner: string, id: string) { const attempt = attempts.find(item => item.id === id)!; attempt.state = 'cancelled'; return attempt; },
  } as unknown as ReturnType<typeof createStandaloneLedger>;
  return { service, attempts, events, identifiers, uncertaintyReasons, factory: () => service };
}


test('paid transport requires trusted scope, while unpriced usage is reported as unknown without a spending veto', async () => {
  let sends = 0;
  const fake = fakeLedger();
  const send = createAccountingFetch('openai', async () => { sends++; return receipt(); }, fake.factory);
  await assert.rejects(send('https://api.openai.com/v1/chat/completions', request), isStandaloneAccountingError);
  assert.equal(sends, 0, 'untrusted transport cannot send');
  const response = await runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions',
    { ...request, body: JSON.stringify({ model: 'unknown-unpriced', messages: [] }) }));
  assert.equal(response.status, 200);
  assert.equal(sends, 1, 'unknown accounting price alone must not veto authorized inference');
  assert.equal(fake.attempts[0].state, 'uncertain', 'unpriced actual charge remains recorded as unknown');
  assert.equal(fake.attempts[0].preflight_estimate.reservationMicrousd, '0',
    'zero is only an accounting marker when model pricing is missing');
  assert.equal(fake.attempts[0].preflight_estimate.estimatedCostMicrousd, null,
    'never manufacture a price for unpriced generation');
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
  await runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request));
  assert.equal(fake.attempts[0].state, 'uncertain');
  assert.ok(fake.attempts[0].response_checkpoint);
  await runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request));
  assert.equal(sends, 1);
  assert.equal(fake.attempts[0].actual_microusd, undefined);
});

test('closed response signal blocks old ITM admission, but durable post-answer scope preserves metered transport', async () => {
  const oldHttpRequest = new AbortController();
  oldHttpRequest.abort();
  const fake = fakeLedger();
  let providerSends = 0;
  const send = createAccountingFetch('openai', async () => {
    providerSends++;
    return receipt();
  }, fake.factory);

  await runWithStandaloneAccounting({ ...context, signal: oldHttpRequest.signal }, async () => {
    await assert.rejects(
      send('https://api.openai.com/v1/chat/completions', request),
      error => standaloneAccountingCause(error)?.code === 'standalone_cancelled',
    );
    assert.equal(fake.attempts.length, 0, 'aborted request cannot create an accounting attempt');
    assert.equal(providerSends, 0);

    const response = await runWithDurablePostAnswerAccounting(
      () => send('https://api.openai.com/v1/chat/completions', request),
    );
    assert.equal(response.status, 200);
    assert.equal(fake.attempts[0].actor_id, context.actorId);
    assert.equal(fake.attempts[0].request_id, context.requestId);
  });
  assert.equal(providerSends, 1);
  assert.equal(fake.attempts[0].state, 'settled');
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

test('activity-specific timeout is enforced at the paid transport boundary and records a distinct memory timeout', async () => {
  const fake = fakeLedger();
  fake.service.uncertainExposureAccepted = async () => true;
  let sends = 0;
  const send = createAccountingFetch('openai', async (_url, init) => {
    sends++;
    const signal = init?.signal;
    assert.ok(signal);
    if (signal.aborted) signal.throwIfAborted();
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }, fake.factory, {
    timeoutMs: 10,
    timeoutCode: 'memory_timeout',
    timeoutMessage: timeoutMs => `Intermediate memory provider transmission timed out after ${timeoutMs}ms.`,
    uncertaintyReason: timeoutMs => `Memory-summary provider transmission timed out after ${timeoutMs}ms; reservation remains held.`,
  });
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(
      runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request)),
      error => {
        assert.equal(standaloneAccountingCause(error)?.code, 'standalone_memory_timeout');
        return true;
      },
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(sends, 1);
  assert.equal(fake.attempts[0].state, 'uncertain');
  assert.match(fake.uncertaintyReasons[0], /Memory-summary provider transmission timed out after 10ms/);
});

test('standalone child cannot opt out by entering an orchestrator scope', async () => {
  const fake = fakeLedger(true); let sends = 0;
  const send = createAccountingFetch('openai', async () => { sends++; return receipt(); }, fake.factory);
  await assert.rejects(runWithStandaloneAccounting(context, () => runWithOrchestratorAccounting(() => send('https://api.openai.com/v1/chat/completions', request))), isStandaloneAccountingError);
  assert.equal(sends, 0);
});


test('OpenAI SDK cannot hide retries after an ambiguous network failure', async () => {
  const fake = fakeLedger(); let sends = 0;
  const client = new OpenAI({ apiKey: 'offline-test', maxRetries: 0,
    fetch: createAccountingFetch('openai', async () => { sends++; throw new Error('socket closed after send'); }, fake.factory) });
  await assert.rejects(runWithStandaloneAccounting(context, () =>
    client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] })),
    error => error instanceof Error && /prior provider outcome is unavailable/.test(error.message));
  assert.equal(sends, 1, 'the uncertain paid operation must never be retransmitted by the SDK');
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
  await runWithStandaloneAccounting(context, () => send('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 4096, system: 'help', messages: [{ role: 'user', content: 'hello' }], stream: true }) }));
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
  await runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request));
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
  const response=await runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request));
  assert.equal(response.status,200,'provider output can be consumed despite unknown monetary charge');
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
  await runWithStandaloneAccounting(context, () => send('https://api.openai.com/v1/chat/completions', request));
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
    const delivered=await runWithStandaloneAccounting(context, () => send('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 4096, system, ...(tools ? { tools } : {}), messages: [{ role: 'user', content: 'Answer' }] }) }));
    assert.equal(delivered.status,200,'unpriced cache usage cannot erase provider output');
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
  const fake = fakeLedger(), sent: string[] = [];
  t.mock.method(accountingDispatch, 'createAccountingFetch', (provider: Parameters<typeof createAccountingFetch>[0]) =>
    actualAccountingFetch(provider, async (url, init) => {
      if (String(url).endsWith(':countTokens')) return Response.json({ totalTokens: 100 });
      sent.push(String(init?.body));
      return new Response(JSON.stringify({ responseId: 'google-fixture', modelVersion: 'gemini-2.5-flash',
        candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify({
          selections: [{ id: 'saved', mode: 'source' }], rationale: 'Named saved file.'
        }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 0 }
      }), { headers: { 'content-type': 'application/json' } });
    }, fake.factory));
  return { ...fake, sent };
}

test('saved selector dispatches frozen Google REST bytes without accounting approval', async t => {
  const f = googleFixture(t), previous = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = 'offline-fixture';
  t.after(() => { if (previous === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = previous; });
  const catalog = [{ id: 'saved', fileName: 'budget.pdf', mimeType: 'application/pdf', observedSummary: 'Budget report', summaryCoverage: 'full' as const }];
  const select = () => selectStoredAttachments('Read budget.pdf', catalog, []);
  const decision = await runWithStandaloneAccounting(context, select);
  assert.equal(f.sent.length, 1); assert.equal(f.attempts.length, 1);
  const a = f.attempts[0], quoted = a.prepared_payload as unknown as ReturnType<typeof freezePreparedRequest>;
  assert.equal(a.category, 'attachment-selection');
  assert.deepEqual(quoted.payload.contents, [{ role: 'user', parts: [{ text: JSON.stringify({
    request: 'Read budget.pdf', taskContext: null, newlyAttachedFiles: [], recentConversation: [],
    files: [{ id: 'saved', name: 'budget.pdf', mimeType: 'application/pdf', coverage: 'full', summary: 'Budget report' }]
  }) }] }]);
  assert.ok(quoted.payload.systemInstruction);
  assert.equal(a.preflight_estimate.requestHash, quoted.hash);
  assert.equal(estimatePreparedRequest(quoted, PRICING_SNAPSHOT, { requestHash: quoted.hash, inputTokens: 100 }).reservationMicrousd, a.reserved_microusd);
  // The approval RPC itself is exercised against PostgreSQL in the ledger suite.
  const approvedHash = a.prepared_hash;
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
    const result = await runWithStandaloneAccounting({ ...context, requestId: 'shape-' + f.sent.length },
      () => googleGenerateContent('offline-fixture', {
        model: 'gemini-2.5-flash', contents,
        config: { systemInstruction: ['system', { text: 'rules' }], maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } }
      }));
    assert.ok(result, 'valid adapter output is returned without a financial approval veto');
    const body = f.attempts.at(-1)!.prepared_payload.payload as Record<string, unknown>;
    assert.deepEqual(body.contents, expected);
    assert.deepEqual(body.systemInstruction, { role: 'user', parts: [{ text: 'system' }, { text: 'rules' }] });
    assert.equal(JSON.stringify(contents), before);
    f.attempts.length = 0; // new distinct workflow resets the fake ledger's ordinal
  }
  assert.equal(f.sent.length, cases.length, 'one transmission per genuinely distinct request');
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

test('model pricing is only a preference: both high and low quotes execute and retain historical actual cost',async()=>{
 for(const [model,inputNanoUsd] of [['fixture-pro','100'],['fixture-ordinary','1000000']] as const){
  const f=fakeLedger();let sends=0;
  const snapshot={...PRICING_SNAPSHOT,version:'fixture-price-v1',models:[{provider:'openai' as const,model,inputNanoUsd,outputNanoUsd:'100',maxContextTokens:100000,maxOutputTokens:1000,source:'fixture'}]};
  let current:PricingSnapshot={...snapshot};
  f.service.loadPricing=async version=>({snapshot:version===snapshot.version?snapshot:current,retrievedAt:new Date().toISOString()});
  const send=createAccountingFetch('openai',async(url)=>{
    if(String(url).endsWith('/input_tokens'))return Response.json({input_tokens:100});
    sends++;return receipt();
  },f.factory);
  const payload={method:'POST',body:JSON.stringify({model,input:'hello',max_output_tokens:10})};
  const execute=()=>runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/responses',payload));
  const response=await execute();
  assert.equal(response.status,200);
  const saved=f.attempts[0];
  assert.equal(saved.state,'settled');assert.equal(saved.pricing_version,snapshot.version);
  assert.equal(sends,1,'no internal per-call threshold can refuse high-quality model dispatch');
  const actual=saved.actual_microusd;
  assert.ok(actual!==null && actual!==undefined,'provider usage is reliably priced after execution');
  current={...snapshot,version:'fixture-price-v2',models:[{...snapshot.models[0],inputNanoUsd:'2000000'}]};
  await execute();
  assert.equal(sends,1,'history replay is one shot');
  assert.equal(saved.actual_microusd,actual,'later catalog repricing never rewrites incurred charge');
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
 let reads=0,sends=0;const f=fakeLedger();
 t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL,init?:RequestInit)=>{reads++;assert.equal(String(url),'https://storage.example.test/storage/v1/object/sign/uploads/photo.png?token=fixture');assert.equal(init?.redirect,'error');assert.equal(init?.headers,undefined);return new Response(bytes,{headers:{'content-type':'image/png'}});});
 const send=createAccountingFetch('openai',async()=>{sends++;return receipt();},f.factory);
 const body={model:'gpt-4o',messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://storage.example.test/storage/v1/object/sign/uploads/photo.png?token=fixture'}}]}],max_tokens:10};
 await runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/chat/completions',{method:'POST',body:JSON.stringify(body)}));
 assert.equal(reads,1);assert.equal(sends,1,'image is frozen before one paid generation');assert.ok(String(f.attempts[0].prepared_payload.serializedBody).includes('data:image/png;base64,'));assert.ok(!String(f.attempts[0].prepared_payload.serializedBody).includes('token=fixture'));
 body.messages[0].content[0].image_url.url='https://untrusted.example.test/photo.png';
 await assert.rejects(runWithStandaloneAccounting({...context,requestId:'external'},()=>send('https://api.openai.com/v1/chat/completions',{method:'POST',body:JSON.stringify(body)})),isStandaloneAccountingError);
 assert.equal(reads,1,'untrusted URL was never fetched');assert.equal(sends,1,'untrusted content cannot dispatch');
});

test('subsequent price changes cannot veto a saved provider request or revise settled cost',async()=>{
 const f=fakeLedger();let sends=0;
 const original:PricingSnapshot={...PRICING_SNAPSHOT,version:'fixture-old',models:[{...PRICING_SNAPSHOT.models[0]}]};
 let current=original;
 f.service.loadPricing=async version=>({snapshot:version===original.version?original:current,retrievedAt:new Date().toISOString()});
 const send=createAccountingFetch('openai',async()=>{sends++;return receipt();},f.factory);
 const execute=()=>runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/chat/completions',request));
 await execute();
 const saved=f.attempts[0],immutable=structuredClone(saved);
 assert.equal(saved.state,'settled');assert.equal(sends,1);
 current={...original,version:'fixture-new',models:[{...original.models[0],inputNanoUsd:'5000'}]};
 await execute();
 assert.equal(sends,1);
 assert.equal(saved.id,immutable.id);
 assert.equal(saved.prepared_hash,immutable.prepared_hash);
 assert.equal(saved.pricing_version,original.version);
 assert.equal(saved.actual_microusd,immutable.actual_microusd);
});

test('missing modern OpenAI write counts retain exposure rather than billing writes as zero',async()=>{
 const f=fakeLedger();const snapshot={...PRICING_SNAPSHOT,version:'fixture-missing-write',models:[{provider:'openai' as const,model:'fixture-sol',inputNanoUsd:'1000',outputNanoUsd:'2000',cacheWriteNanoUsd:'1250',maxContextTokens:100000,maxOutputTokens:10000,source:'fixture'}]};
 f.service.loadPricing=async()=>({snapshot,retrievedAt:new Date().toISOString()});
 const send=createAccountingFetch('openai',async()=>new Response(JSON.stringify({id:'missing-write',usage:{input_tokens:100,output_tokens:10}})),f.factory);
 await runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/responses',{method:'POST',body:JSON.stringify({model:'fixture-sol',input:'hello',max_output_tokens:10})}));
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



test('uncertain usage replays complete saved output without settlement, approval, or retransmission', async () => {
  const f = fakeLedger(); let sends = 0;
  const send = createAccountingFetch('openai', async () => {
    sends++;
    return Response.json({ id: 'unconfirmed-' + sends, choices: [{ finish_reason: 'stop', message: { content: 'real saved output' } }] });
  }, f.factory);
  const first = await runWithStandaloneAccounting(context,
    () => send('https://api.openai.com/v1/chat/completions', request));
  assert.match(await first.text(), /real saved output/);
  const uncertain = f.attempts[0]; const retained = JSON.stringify(uncertain);
  for (let restart = 0; restart < 2; restart++) {
    const response = await runWithStandaloneAccounting({ ...context, resumed: true },
      () => send('https://api.openai.com/v1/chat/completions', request));
    assert.match(await response.text(), /real saved output/);
  }
  assert.equal(sends, 1, 'saved complete output is returned without replaying paid inference');
  assert.equal(JSON.stringify(uncertain), retained, 'original uncertain usage and attempt identity stay intact');
  assert.equal(f.events.filter(event => event === 'settle').length, 0, 'missing receipt is not fabricated');
  const second = await runWithStandaloneAccounting({ ...context, resumed: true }, async () => {
    await send('https://api.openai.com/v1/chat/completions', request); // saved original
    return send('https://api.openai.com/v1/chat/completions', request); // new distinct ordinal
  });
  assert.match(await second.text(), /real saved output/);
  assert.equal(sends, 2);
  assert.equal(f.attempts.length, 2);
  assert.equal(f.attempts[1].state, 'uncertain');
});

test('accepting exposure never fabricates a missing or incomplete provider result',async()=>{
 const f=fakeLedger();let sends=0;
 const send=createAccountingFetch('openai',async()=>{sends++;throw Error('socket lost');},f.factory);
 await runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/chat/completions',request));
 f.service.uncertainExposureAccepted=async()=>true;
 for(const checkpoint of [null,{status:200,statusText:'OK',headers:[],body:JSON.stringify({choices:[{message:{content:'partial'},finish_reason:null}]})}] as Array<ResponseCheckpoint|null>){
  f.attempts[0].response_checkpoint=checkpoint;
  const unavailable=await runWithStandaloneAccounting({...context,resumed:true},()=>send('https://api.openai.com/v1/chat/completions',request));assert.equal(unavailable.status,400);assert.match(await unavailable.text(),/not retransmitted/);
 }
 assert.equal(sends,1);assert.equal(f.attempts[0].state,'uncertain');
});


test('accepted exposure cannot promote truncated streaming output to a safe checkpoint',async()=>{
 for(const provider of ['openai','anthropic'] as const){
  const f=fakeLedger();let sends=0;
  const stream=provider==='openai'?'data: '+JSON.stringify({choices:[{delta:{content:'partial'},finish_reason:'length'}]})+'\n\ndata: [DONE]\n\n'
   :'data: '+JSON.stringify({type:'message_delta',delta:{stop_reason:'max_tokens'}})+'\n\ndata: '+JSON.stringify({type:'message_stop'})+'\n\n';
  const send=createAccountingFetch(provider,async(url)=>{
   if(String(url).endsWith('/count_tokens'))return Response.json({input_tokens:100});
   sends++;return new Response(stream,{headers:{'content-type':'text/event-stream'}});
  },f.factory);
  const url=provider==='openai'?'https://api.openai.com/v1/chat/completions':'https://api.anthropic.com/v1/messages';
  const body={method:'POST',body:JSON.stringify({model:provider==='openai'?'gpt-4o':'claude-sonnet-5-5',messages:[{role:'user',content:'hello'}],stream:true})};
  await runWithStandaloneAccounting(context,()=>send(url,body));
  f.service.uncertainExposureAccepted=async()=>true;
  const unavailable=await runWithStandaloneAccounting({...context,resumed:true},()=>send(url,body));assert.equal(unavailable.status,400);assert.doesNotMatch(await unavailable.text(),/partial/);
  assert.equal(sends,1);assert.equal(f.attempts[0].state,'uncertain');
 }
});



test('legacy explicit Google observation replays blocked response without observing twice', async t => {
  const f = fakeLedger(); let sends = 0; const oldKey = process.env.GOOGLE_API_KEY; process.env.GOOGLE_API_KEY = 'offline-fixture';
  t.after(() => { if (oldKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = oldKey; });
  t.mock.method(accountingDispatch, 'createAccountingFetch', (provider: Parameters<typeof createAccountingFetch>[0]) =>
    actualAccountingFetch(provider, async url => {
      if (String(url).endsWith(':countTokens')) return Response.json({ totalTokens: 100 });
      sends++; return Response.json({ responseId: 'saved-blocked-observation', modelVersion: 'gemini-2.5-flash',
        promptFeedback: { blockReason: 'OTHER' }, usageMetadata: { promptTokenCount: 10 } });
    }, f.factory));
  const image = { fileId: 'file', fileName: 'photo.png', mimeType: 'image/png', preview: 'Stored photo metadata',
    imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/f9sAAAAASUVORK5CYII=' };
  const first = await runWithStandaloneAccounting(context, () => describeAttachmentEvidence(image, { standaloneImages: false }));
  const held = f.attempts[0]; const preserved = JSON.stringify(held);
  const replay = await runWithStandaloneAccounting({ ...context, resumed: true },
    () => describeAttachmentEvidence(image, { standaloneImages: false }));
  for (const result of [first, replay]) {
    assert.equal(result.summaryModel, 'source-excerpt');
    assert.equal(result.summaryCoverage, 'metadata');
  }
  assert.equal(sends, 1, 'blocked receipt must not trigger repeated inference');
  assert.equal(JSON.stringify(held), preserved, 'usage and evidence remain uncertain, not fabricated');
  assert.equal(f.events.filter(event => event === 'settle').length, 0);
});

test('auto-authorized incomplete usage replays genuine Gemini selector output without approval or retransmission',async()=>{
 const f=fakeLedger();f.service.uncertainExposureAccepted=async()=>true;let sends=0;
 const send=createAccountingFetch('google',async(url)=>{if(String(url).endsWith(':countTokens'))return Response.json({totalTokens:100});sends++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"selections":[]}'}]}}]});},f.factory);
 const url='https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
 const init={method:'POST',body:JSON.stringify({contents:[{role:'user',parts:[{text:'Select relevant saved attachments'}]}],generationConfig:{maxOutputTokens:1000}})};
 for(let i=0;i<3;i++){const response=await runWithStandaloneAccounting({...context,resumed:i>0},()=>send(url,init));assert.equal(response.status,200);assert.match(await response.text(),/selections/);}
 assert.equal(sends,1);assert.equal(f.attempts[0].state,'uncertain');assert.ok(BigInt(f.attempts[0].reserved_microusd)>0n);
});
test('auto-authorized lost transmission returns a non-retryable local failure and never resends',async()=>{
 const f=fakeLedger();f.service.uncertainExposureAccepted=async()=>true;let sends=0;
 const send=createAccountingFetch('openai',async()=>{sends++;throw Error('unknown transport outcome');},f.factory);
 const client=new OpenAI({apiKey:'fixture',fetch:send,maxRetries:2});
 for(let i=0;i<2;i++)await assert.rejects(runWithStandaloneAccounting({...context,resumed:i>0},()=>client.chat.completions.create({model:'gpt-4o',messages:[{role:'user',content:'hello'}]})),error=>error instanceof Error&&/400/.test(error.message));
 assert.equal(sends,1);assert.equal(f.attempts[0].state,'uncertain');assert.equal(f.attempts.length,1);
});


test('large Claude input uses native count and replays exact settled generation without another quote', async () => {
  const fake = fakeLedger();
  const system = 'Long standing executive context. '.repeat(11000);
  const body = JSON.stringify({ model: 'claude-sonnet-4-5', system, max_tokens: 16384,
    messages: [{ role: 'user', content: 'hi katie' }] });
  const original = { method: 'POST', headers: { 'x-api-key': 'fixture-key', 'anthropic-version': '2023-06-01' }, body };
  let counts = 0, paid = 0;
  const send = createAccountingFetch('anthropic', async (input, init) => {
    if (String(input).endsWith('/count_tokens')) {
      counts++;
      const counted = JSON.parse(String(init?.body));
      assert.equal(counted.system, system);
      assert.equal(counted.max_tokens, undefined);
      assert.equal(counted.model, 'claude-sonnet-4-5');
      return Response.json({ input_tokens: 90000 });
    }
    paid++;
    assert.deepEqual(JSON.parse(String(init?.body)), JSON.parse(String(fake.attempts[0].prepared_payload.serializedBody)),
      'paid request must match the frozen native-counted payload');
    return Response.json({ id: 'approved-claude-receipt', model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'Saved answer' }], stop_reason: 'end_turn',
      usage: { input_tokens: 90000, output_tokens: 64, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  }, fake.factory);
  const first = await runWithStandaloneAccounting(context,
    () => send('https://api.anthropic.com/v1/messages', original));
  assert.equal((await first.json()).content[0].text, 'Saved answer');
  const attempt = fake.attempts[0];
  assert.equal(attempt.preflight_estimate.inputTokens, 90000);
  assert.equal(attempt.preflight_estimate.outputAllowance, 16384);
  assert.equal(attempt.preflight_estimate.inputCountSource, 'provider');
  assert.equal(attempt.reserved_microusd, '515760', 'full quoted usage is retained for reporting');
  assert.equal(attempt.state, 'settled');
  assert.equal(counts, 1); assert.equal(paid, 1);
  const resumed = await runWithStandaloneAccounting({ ...context, resumed: true },
    () => send('https://api.anthropic.com/v1/messages', original));
  assert.equal((await resumed.json()).content[0].text, 'Saved answer');
  assert.equal(counts, 1, 'native count is not repeated');
  assert.equal(paid, 1, 'saved receipt prevents duplicate inference');
});

test('unverified oversized context has no approvable ledger attempt or paid dispatch',async()=>{
  const fake=fakeLedger();let counts=0,paid=0;
  const original={method:'POST',headers:{'x-api-key':'fixture-key'},body:JSON.stringify({
    model:'claude-sonnet-4-5',system:'Historical system reference. '.repeat(12000),
    messages:[{role:'user',content:'hi katie'}],max_tokens:16384,
  })};
  const send=createAccountingFetch('anthropic',async(input)=>{
    if(String(input).endsWith('/count_tokens')){counts++;return Response.json({error:'model token count unsupported'},{status:400});}
    paid++;return Response.json({});
  },fake.factory);
  await assert.rejects(runWithStandaloneAccounting(context,()=>send('https://api.anthropic.com/v1/messages',original)),
    error=>standaloneAccountingCause(error)?.code==='standalone_context_capacity_unverified');
  assert.equal(counts,1);assert.equal(paid,0);
  assert.equal(fake.attempts.length,0,'non-priceable technical context does not manufacture an approval');
});

/** Reproduces the November 2, 2026 GPT-5.4 mini context-admission shape
 * without retaining user text or hitting a paid provider. The input byte
 * heuristic equals the observed 321,685; provider counts below are mocks. */
function november2MiniFixture() {
  const model='gpt-5.4-mini';
  const reviewed=PRICING_SNAPSHOT.models.find(row=>row.provider==='openai'&&row.model==='gpt-5-mini')!;
  const pricing:PricingSnapshot={...PRICING_SNAPSHOT,version:'sanitized-20261102-mini-272k',models:[
    ...PRICING_SNAPSHOT.models,{...reviewed,model,maxContextTokens:272000,responsesOnly:true}
  ]};
  const makeBody=(history:string)=>({
    model,max_output_tokens:4096,prompt_cache_key:'sanitized-same-chat-cache-hint',
    input:[
      {role:'system',content:[{type:'input_text',text:history}]},
      {role:'user',content:[{type:'input_text',text:'Respond using all of the preserved history in sequence.'}]},
    ],
  });
  const seed='Historical chronology, actor state, and business reference text. '.repeat(4000);
  const seedEstimate=estimatePreparedRequest(prepareStandaloneRequest('openai',model,'/v1/responses',makeBody(seed)),pricing);
  const extra=321685-seedEstimate.inputTokens;
  assert.ok(extra>0,'fixture seed must leave room for exact observed heuristic');
  const body=makeBody(seed+'X'.repeat(extra));
  const initial=prepareStandaloneRequest('openai',model,'/v1/responses',body);
  assert.equal(estimatePreparedRequest(initial,pricing).inputTokens,321685);
  return {model,pricing,body,initial,original:{
    method:'POST',headers:{authorization:'Bearer fake-no-network', 'content-type':'application/json'},
    body:JSON.stringify(body),
  }};
}


test('Nov 2 mini inflated heuristic obtains native count and preserves exact uncached replay without approval veto', async () => {
  const fixture = november2MiniFixture();
  const f = fakeLedger(false, fixture.pricing);
  let native = 0, paid = 0;
  const send = createAccountingFetch('openai', async (url, init) => {
    if (String(url) === 'https://api.openai.com/v1/responses/input_tokens') {
      native++;
      const counted = JSON.parse(String(init?.body));
      assert.deepEqual(counted, { model: fixture.model, input: fixture.body.input },
        'native count must receive complete original ordered model input');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake-no-network');
      assert.equal('max_output_tokens' in counted, false);
      return Response.json({ object: 'response.input_tokens', input_tokens: 69133 });
    }
    paid++;
    const saved = f.attempts[0].prepared_payload;
    assert.equal(String(init?.body), saved.serializedBody, 'only frozen request can be sent');
    assert.deepEqual(JSON.parse(String(init?.body)).input, fixture.body.input, 'preserve entire input');
    assert.equal(JSON.parse(String(init?.body)).prompt_cache_key, undefined, 'optional unsupported cache hint is removed');
    return Response.json({ id: 'mock-mini-receipt', model: fixture.model, status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Mocked completion', annotations: [] }] }],
      usage: { input_tokens: 69133, output_tokens: 128, input_tokens_details: { cached_tokens: 0 } } });
  }, f.factory);
  const first = await runWithStandaloneAccounting(context,
    () => send('https://api.openai.com/v1/responses', fixture.original));
  assert.equal((await first.json()).output[0].content[0].text, 'Mocked completion');
  assert.equal(native, 1); assert.equal(paid, 1); assert.equal(f.attempts.length, 1);
  const attempt = f.attempts[0];
  assert.equal(attempt.preflight_estimate.inputTokens, 69133);
  assert.equal(attempt.preflight_estimate.outputAllowance, 4096);
  assert.equal(attempt.preflight_estimate.inputCountSource, 'provider');
  assert.notEqual(attempt.prepared_hash, fixture.initial.hash, 'unsupported cache metadata changes the frozen body hash');
  assert.deepEqual(JSON.parse(String(attempt.prepared_payload.serializedBody)).input, fixture.body.input);
  assert.equal(attempt.state, 'settled');
  const replay = await runWithStandaloneAccounting({ ...context, resumed: true },
    () => send('https://api.openai.com/v1/responses', fixture.original));
  assert.equal((await replay.json()).output[0].content[0].text, 'Mocked completion');
  assert.equal(native, 1, 'replay preserves counted evidence');
  assert.equal(paid, 1, 'replay does not retransmit');
  assert.equal(f.attempts.length, 1); assert.equal(attempt.usage?.inputTokens, 69133);
});

test('Nov 2 mini without an optional cache hint may use native-counted context without escalation',async()=>{
  const fixture=november2MiniFixture();
  const body={...fixture.body};
  delete (body as {prompt_cache_key?:string}).prompt_cache_key;
  const f=fakeLedger(false,fixture.pricing);let native=0,paid=0;
  const send=createAccountingFetch('openai',async(url,init)=>{
    if(String(url).endsWith('/input_tokens')){native++;return Response.json({object:'response.input_tokens',input_tokens:69133});}
    paid++;assert.deepEqual(JSON.parse(String(init?.body)).input,body.input);
    return Response.json({id:'mini-uncached-mock',model:fixture.model,status:'completed',output:[],usage:{input_tokens:69133,output_tokens:64}});
  },f.factory);
  await runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/responses',{...fixture.original,body:JSON.stringify(body)}));
  assert.equal(native,1);assert.equal(paid,1);assert.equal(f.attempts.length,1);
  assert.equal(f.attempts[0].preflight_estimate.inputCountSource,'provider');
});

test('Nov 2 mini genuinely oversized provider-native input is rejected without charge or approval',async()=>{
  const fixture=november2MiniFixture();
  const f=fakeLedger(false,fixture.pricing);let counts=0,paid=0;
  const send=createAccountingFetch('openai',async(url)=>{
    if(String(url).endsWith('/input_tokens')){counts++;return Response.json({object:'response.input_tokens',input_tokens:270000});}
    paid++;return Response.json({});
  },f.factory);
  await assert.rejects(runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/responses',fixture.original)),
    error=>standaloneAccountingCause(error)?.code==='standalone_context_window_exceeded');
  assert.equal(counts,1);assert.equal(paid,0);assert.equal(f.attempts.length,0);
});

test('Nov 2 mini native count HTTP, timeout, and malformed responses fail closed with correct uncertainty',async()=>{
  const fixture=november2MiniFixture();
  const cases=[
    {name:'http',response:()=>Response.json({error:{message:'unavailable'}},{status:503})},
    {name:'timeout',response:()=>Promise.reject(Object.assign(new Error('fixture timeout'),{name:'TimeoutError'}))},
    {name:'malformed',response:()=>Response.json({object:'response.input_tokens',input_tokens:'69133'})},
    {name:'invalid-json',response:()=>new Response('not-json',{status:200})},
  ];
  for(const scenario of cases){
    const f=fakeLedger(false,fixture.pricing);let count=0,paid=0;
    const send=createAccountingFetch('openai',async(url)=>{
      if(String(url).endsWith('/input_tokens')){count++;return scenario.response();}
      paid++;return Response.json({});
    },f.factory);
    await assert.rejects(runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/responses',fixture.original)),
      error=>standaloneAccountingCause(error)?.code==='standalone_context_capacity_unverified',scenario.name);
    assert.equal(count,1,scenario.name);assert.equal(paid,0,scenario.name);
    assert.equal(f.attempts.length,0,scenario.name);
  }
});

test('mixed unpriceable dimension and heuristic context is a billing error, not a false capacity upgrade',async()=>{
  const fixture=november2MiniFixture();
  const body={...fixture.body,service_tier:'priority'};
  const f=fakeLedger(false,fixture.pricing);let counts=0,paid=0;
  const send=createAccountingFetch('openai',async(url)=>{
    if(String(url).endsWith('/input_tokens'))counts++;
    else paid++;
    return Response.json({});
  },f.factory);
  await assert.rejects(runWithStandaloneAccounting(context,()=>send('https://api.openai.com/v1/responses',{...fixture.original,body:JSON.stringify(body)})),
    error=>standaloneAccountingCause(error)?.code==='standalone_unsupported_billing');
  assert.equal(counts,0);assert.equal(paid,0);assert.equal(f.attempts.length,0);
});


test('short valid requests count provider-native input before admission; resume never recounts',async()=>{
 const scenarios=[
  {provider:'anthropic' as const,model:'claude-sonnet-4-6',path:'/v1/messages',
   native:'https://api.anthropic.com/v1/messages/count_tokens',count:{input_tokens:20},
   body:{model:'claude-sonnet-4-6',messages:[{role:'user',content:'Short ordinary message.'}],max_tokens:64},
   receipt:{id:'counted-claude',model:'claude-sonnet-4-6',content:[{type:'text',text:'ok'}],stop_reason:'end_turn',
    usage:{input_tokens:20,output_tokens:3,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
  {provider:'openai' as const,model:'gpt-5',path:'/v1/responses',
   native:'https://api.openai.com/v1/responses/input_tokens',count:{input_tokens:20},
   body:{model:'gpt-5',input:[{role:'user',content:'Short ordinary message.'}],max_output_tokens:64},
   receipt:{id:'counted-openai',model:'gpt-5',status:'completed',output:[],
    usage:{input_tokens:20,output_tokens:3,input_tokens_details:{cached_tokens:0}}}},
  {provider:'google' as const,model:'gemini-2.5-flash',path:'/v1beta/models/gemini-2.5-flash:generateContent',
   native:'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:countTokens',count:{totalTokens:20},
   body:{contents:[{role:'user',parts:[{text:'Short ordinary message.'}]}],generationConfig:{maxOutputTokens:64}},
   receipt:{responseId:'counted-google',modelVersion:'gemini-2.5-flash',
    candidates:[{finishReason:'STOP',content:{parts:[{text:'ok'}]}}],
    usageMetadata:{promptTokenCount:20,candidatesTokenCount:3,thoughtsTokenCount:0}}},
 ];
 for(const item of scenarios){
  const f=fakeLedger();let counts=0,paid=0,sent='';
  const host=item.provider==='anthropic'?'https://api.anthropic.com':item.provider==='openai'?'https://api.openai.com':'https://generativelanguage.googleapis.com';
  const initial=prepareStandaloneRequest(item.provider,item.model,item.path,item.body);
  const heuristic=estimatePreparedRequest(initial);
  assert.equal(heuristic.status,'estimated','already fits context without native count');
  assert.ok(heuristic.inputTokens>20);
  const send=createAccountingFetch(item.provider,async(url,init)=>{
   if(String(url)===item.native){
    counts++;const counted=JSON.parse(String(init?.body));
    if(item.provider==='google')assert.deepEqual(counted,{generateContentRequest:{model:'models/'+item.model,contents:initial.payload.contents}});
    else assert.equal(counted.model,item.model);
    assert.equal(counted.max_output_tokens,undefined);assert.equal(counted.max_tokens,undefined);
    return Response.json(item.count);
   }
   paid++;sent=String(init?.body);return Response.json(item.receipt);
  },f.factory);
  const input={method:'POST',body:JSON.stringify(item.body)};
  await runWithStandaloneAccounting({...context,requestId:'count-'+item.provider},()=>send(host+item.path,input));
  assert.equal(counts,1,item.provider);assert.equal(paid,1,item.provider);
  const attempt=f.attempts[0];
  assert.equal(attempt.state,'settled');
  assert.equal(attempt.preflight_estimate.inputCountSource,'provider');
  assert.equal(attempt.preflight_estimate.inputTokens,20);
  assert.equal(sent,attempt.prepared_payload.serializedBody);
  await runWithStandaloneAccounting({...context,requestId:'count-'+item.provider,resumed:true},()=>send(host+item.path,input));
  assert.equal(counts,1,'native count reused from the saved quote');
  assert.equal(paid,1,'no repeat generation');
 }
});

test('failed native count retains old conservative normal-request estimate and completes one paid call',async()=>{
 const f=fakeLedger();let counts=0,paid=0;
 const body={model:'gpt-5',input:'Small but nontrivial prompt',max_output_tokens:64};
 const original=prepareStandaloneRequest('openai','gpt-5','/v1/responses',body);
 const oldQuote=estimatePreparedRequest(original);
 const send=createAccountingFetch('openai',async(url,init)=>{
  if(String(url).endsWith('/input_tokens')){counts++;return Response.json({error:'not available'},{status:503});}
  paid++;assert.equal(String(init?.body),original.serializedBody);
  return Response.json({id:'fallback-provider-receipt',model:'gpt-5',status:'completed',output:[],
   usage:{input_tokens:12,output_tokens:4,input_tokens_details:{cached_tokens:0}}});
 },f.factory);
 await runWithStandaloneAccounting({...context,requestId:'fallback-count'},()=>send(
  'https://api.openai.com/v1/responses',{method:'POST',body:JSON.stringify(body)}));
 assert.equal(counts,1);assert.equal(paid,1);
 assert.equal(f.attempts[0].preflight_estimate.inputCountSource,'heuristic');
 assert.equal(f.attempts[0].preflight_estimate.inputTokens,oldQuote.inputTokens);
 assert.equal(f.attempts[0].reserved_microusd,oldQuote.reservationMicrousd);
});

for(const streaming of [false,true]){
 test('Grok '+(streaming?'SSE':'JSON')+' actual cost includes separately billed reasoning',async()=>{
  const f=fakeLedger();let paid=0;
  const receiptBody={id:'grok-reasoning',model:'grok-4.7',
   choices:[{finish_reason:'stop',message:{content:'done'}}],
   usage:{prompt_tokens:40308,completion_tokens:382,total_tokens:46991,
    prompt_tokens_details:{cached_tokens:1152,audio_tokens:0,image_tokens:0},
    completion_tokens_details:{reasoning_tokens:6301,audio_tokens:0}}};
  const send=createAccountingFetch('grok',async()=>{
   paid++;return new Response(streaming?'data: '+JSON.stringify(receiptBody)+'\n\ndata: [DONE]\n\n':JSON.stringify(receiptBody),
    {headers:{'content-type':streaming?'text/event-stream':'application/json'}});
  },f.factory);
  const body={model:'grok-4.7',messages:[{role:'user',content:'x'.repeat(60000)}],max_tokens:4096,stream:streaming};
  await runWithStandaloneAccounting({...context,requestId:'grok-reason-'+streaming},()=>send(
   'https://api.x.ai/v1/chat/completions',{method:'POST',body:JSON.stringify(body)}));
  assert.equal(paid,1,'Grok has no native count endpoint');
  assert.equal(f.attempts[0].state,'settled');
  assert.equal(f.attempts[0].usage?.outputTokens,6683,'382 visible plus 6301 reasoning');
  assert.equal(f.attempts[0].actual_microusd,'118986','exact provider-reported charge');
  assert.equal(f.attempts[0].preflight_estimate.outputAllowance,4096,'preflight policy unchanged');
 });
}

test('Grok malformed reasoning or conflicting totals fail closed without false settlement',async()=>{
 for(const v of [{reasoning:6301,total:46992},{reasoning:'6301',total:46991}]){
  const f=fakeLedger();let sends=0;
  const send=createAccountingFetch('grok',async()=>{sends++;return Response.json({
   id:'inconsistent-grok',model:'grok-4.7',choices:[{finish_reason:'stop',message:{content:'ok'}}],
   usage:{prompt_tokens:40308,completion_tokens:382,total_tokens:v.total,
    completion_tokens_details:{reasoning_tokens:v.reasoning}},
  });},f.factory);
  await runWithStandaloneAccounting({...context,requestId:'invalid-grok-'+String(v.reasoning)},
   ()=>send('https://api.x.ai/v1/chat/completions',{method:'POST',body:JSON.stringify({
    model:'grok-4.7',messages:[{role:'user',content:'x'.repeat(60000)}],max_tokens:4096,
   })}));
  assert.equal(sends,1);assert.equal(f.attempts[0].state,'uncertain');
  assert.equal(f.events.includes('settle'),false);
 }
});



test('GPT-5.5 unsupported cache hints retain exact same-model uncached dispatch and replay', async () => {
  const model = 'gpt-5.5', key = 'katie:v1:fixture-chat';
  const hints = openAiCacheSettings(model, key, 'responses');
  assert.deepEqual(hints, { prompt_cache_key: key, prompt_cache_retention: '24h' });
  const priced = PRICING_SNAPSHOT.models.find(row => row.provider === 'openai' && row.model === 'gpt-5.5-pro')!;
  const pricing: PricingSnapshot = { ...PRICING_SNAPSHOT, version: 'fixture-gpt55',
    models: [...PRICING_SNAPSHOT.models, { ...priced, model, supportsStreaming: true }] };
  const body = { model, input: [{ role: 'user', content: 'Preserve the complete original input.' }],
    max_output_tokens: 256, ...hints };
  const original = prepareStandaloneRequest('openai', model, '/v1/responses', body);
  assert.deepEqual(estimatePreparedRequest(original, pricing).issues, [
    'No reviewed no-fee cache metadata policy for this exact model',
    'Unsupported OpenAI prompt_cache_retention for this exact model',
  ]);
  const f = fakeLedger(false, pricing); let counts = 0, paid = 0;
  const send = createAccountingFetch('openai', async (url, init) => {
    if (String(url).endsWith('/input_tokens')) {
      counts++;
      assert.deepEqual(JSON.parse(String(init?.body)), { model, input: body.input });
      return Response.json({ input_tokens: 42 });
    }
    paid++;
    const transmitted = JSON.parse(String(init?.body));
    assert.equal(transmitted.model, model);
    assert.deepEqual(transmitted.input, body.input);
    assert.equal(transmitted.max_output_tokens, 256);
    assert.equal(transmitted.prompt_cache_key, undefined);
    assert.equal(transmitted.prompt_cache_retention, undefined);
    return Response.json({ id: 'mock-gpt55', model, status: 'completed', output: [],
      usage: { input_tokens: 42, output_tokens: 7, input_tokens_details: { cached_tokens: 0 } } });
  }, f.factory);
  const input = { method: 'POST', body: JSON.stringify(body) };
  const run = (resumed = false) => runWithStandaloneAccounting({ ...context, requestId: 'gpt55-cache-mismatch', resumed },
    () => send('https://api.openai.com/v1/responses', input));
  const first = await run();
  assert.equal((await first.json()).status, 'completed');
  assert.equal(paid, 1); assert.equal(f.attempts.length, 1);
  const quote = f.attempts[0];
  assert.equal(quote.state, 'settled');
  assert.equal(quote.model, model);
  assert.notEqual(quote.prepared_hash, original.hash);
  assert.deepEqual(JSON.parse(String(quote.prepared_payload.serializedBody)).input, body.input);
  const observedNativeCounts = counts;
  const resumed = await run(true);
  assert.equal((await resumed.json()).status, 'completed');
  assert.equal(paid, 1, 'no duplicate transmission');
  assert.equal(counts, observedNativeCounts, 'no repeated native count');
  assert.equal(f.attempts.length, 1); assert.equal(quote.state, 'settled');
});

test('Gemini PROHIBITED_CONTENT with provider-proven zero output settles input rather than accumulating uncertain exposure',async()=>{
 const f=fakeLedger();let counted=0,paid=0;
 const responseBody={responseId:'blocked-gemini-unique-receipt',modelVersion:'gemini-2.5-flash',
  promptFeedback:{blockReason:'PROHIBITED_CONTENT'},
  usageMetadata:{promptTokenCount:8249,totalTokenCount:8249,
   promptTokensDetails:[{modality:'TEXT',tokenCount:8249}],serviceTier:'standard'}};
 const send=createAccountingFetch('google',async(url)=>{
  if(String(url).endsWith(':countTokens')){counted++;return Response.json({totalTokens:8249});}
  paid++;return Response.json(responseBody);
 },f.factory);
 const url='https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
 const input={method:'POST',body:JSON.stringify({
  contents:[{role:'user',parts:[{text:'Classify the saved attachment references.'}]}],
  generationConfig:{maxOutputTokens:256,thinkingConfig:{thinkingBudget:0}},
 })};
 const run=(resumed=false)=>runWithStandaloneAccounting({...context,requestId:'blocked-gemini-usage',resumed},()=>send(url,input));
 const response=await run();
 assert.equal(response.status,200);
 const body=await response.json();
 assert.equal(body.promptFeedback.blockReason,'PROHIBITED_CONTENT');
 assert.equal(body.candidates,undefined,'do not fabricate a blocked model answer');
 assert.equal(paid,1);assert.equal(counted,1);
 const a=f.attempts[0];
 assert.equal(a.state,'settled');
 assert.equal(a.usage?.inputTokens,8249);
 assert.equal(a.usage?.outputTokens,0);
 assert.equal(a.actual_microusd,'2475','8249 billed input tokens at the reviewed Gemini Flash input rate');
 assert.equal(a.evidence?.resolvedModel,'gemini-2.5-flash');
 await run(true);
 assert.equal(paid,1,'saved receipt never replays provider generation');
 assert.equal(counted,1,'saved count is not repeated');
});

test('Gemini policy block without complete zero-output evidence holds uncertain exposure',async()=>{
 const invalid=[
  {promptTokenCount:8249}, // Missing total
  {promptTokenCount:8249,totalTokenCount:8250}, // Contradictory total
  {promptTokenCount:8249,totalTokenCount:8249,thoughtsTokenCount:1}, // Hidden output
  {promptTokenCount:8249,totalTokenCount:8249,candidatesTokenCount:1},
  {promptTokenCount:8249,totalTokenCount:8249,toolUsePromptTokenCount:1},
 ];
 for(const [i,usage] of invalid.entries()){
  const f=fakeLedger();let paid=0;
  const send=createAccountingFetch('google',async(url)=>{
   if(String(url).endsWith(':countTokens'))return Response.json({totalTokens:8249});
   paid++;
   return Response.json({responseId:'blocked-gemini-incomplete-'+i,modelVersion:'gemini-2.5-flash',
    promptFeedback:{blockReason:'PROHIBITED_CONTENT'},usageMetadata:usage});
  },f.factory);
  const url='https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  await runWithStandaloneAccounting({...context,requestId:'invalid-gemini-block-'+i},()=>send(url,{
   method:'POST',body:JSON.stringify({contents:[{role:'user',parts:[{text:'Classify the saved attachment references.'}]}],
    generationConfig:{maxOutputTokens:256}}),
  }));
  assert.equal(paid,1);
  assert.equal(f.attempts[0].state,'uncertain');
  assert.equal(f.attempts[0].actual_microusd,undefined);
  assert.equal(f.events.includes('settle'),false);
 }
});



const haiku55Pricing:PricingSnapshot={...PRICING_SNAPSHOT,version:'fixture-anthropic-haiku55',
 models:[...PRICING_SNAPSHOT.models,
  {...PRICING_SNAPSHOT.models.find(row=>row.provider==='anthropic'&&row.model==='claude-haiku-4-5')!,model:'claude-haiku-5-5'}]};
test('Anthropic definitive insufficient-credit 400 is recorded as zero-cost rejection without inventing a completion',async()=>{
 const f=fakeLedger(false,haiku55Pricing);let counts=0,paid=0;
 const rejection={type:'error',error:{type:'invalid_request_error',
  message:'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'},
  request_id:'req_011CfixtureCredit100'};
 const transport=createAccountingFetch('anthropic',async(url)=>{
  if(String(url).endsWith('/count_tokens')){counts++;return Response.json({input_tokens:55});}
  paid++;return Response.json(rejection,{status:400,headers:{'request-id':rejection.request_id}});
 },f.factory);
 const req={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
  model:'claude-haiku-5-5',max_tokens:128,messages:[{role:'user',content:'Test a definitive billing rejection.'}]
 })};
 const first=await runWithStandaloneAccounting({...context,requestId:'nonbillable-anthropic-400'},
  ()=>transport('https://api.anthropic.com/v1/messages',req));
 assert.equal(first.status,400);
 assert.equal((await first.json()).error.type,'invalid_request_error');
 assert.equal(paid,1);assert.equal(counts,1);
 const a=f.attempts[0];
 assert.equal(a.state,'settled','definitive rejection is not unknown spending');
 assert.equal(a.actual_microusd,'0');
 assert.equal(a.usage?.inputTokens,0);
 assert.equal(a.usage?.outputTokens,0);
 assert.equal(a.evidence?.kind,'provider_rejection');
 assert.equal(a.evidence?.providerRequestId,rejection.request_id);
 assert.deepEqual(f.identifiers.at(-1),{requestId:rejection.request_id,responseId:null});
 const replay=await runWithStandaloneAccounting({...context,requestId:'nonbillable-anthropic-400',resumed:true},
  ()=>transport('https://api.anthropic.com/v1/messages',req));
 assert.equal(replay.status,400,'the rejected request still fails for the SDK caller');
 assert.equal(paid,1,'no provider retransmission');
 assert.equal(counts,1,'no new count or charge');
});

test('Anthropic 400 without exact nonbillable proof remains uncertain',async()=>{
 for(const [index,reply] of [
  {type:'error',error:{type:'invalid_request_error',message:'Other invalid request'},request_id:'req_other'},
  {type:'error',error:{type:'invalid_request_error',message:'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'},request_id:'req_bad',usage:{input_tokens:3}},
  {type:'error',error:{type:'invalid_request_error',message:'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'}},
 ] .entries()){
  const f=fakeLedger(false,haiku55Pricing);let paid=0;
  const send=createAccountingFetch('anthropic',async(url)=>{
    if(String(url).endsWith('/count_tokens'))return Response.json({input_tokens:10});
    paid++;return Response.json(reply,{status:400});
  },f.factory);
  await runWithStandaloneAccounting({...context,requestId:'anthropic-unproved-'+index},()=>send(
   'https://api.anthropic.com/v1/messages',{method:'POST',body:JSON.stringify({
     model:'claude-haiku-5-5',max_tokens:64,messages:[{role:'user',content:'Test'}]
   })}));
  assert.equal(paid,1);
  assert.equal(f.attempts[0].state,'uncertain');
  assert.equal(f.attempts[0].actual_microusd,undefined);
 }
});

test('1K Gemini image output reserves reviewed image charges and settles actual output modalities',async()=>{
 const f=fakeLedger();let paid=0;
 const send=createAccountingFetch('google',async(url)=>{
  if(String(url).endsWith(':countTokens'))return Response.json({totalTokens:100});
  paid++;
  const response={
   responseId:'gemini-image-receipt',modelVersion:'gemini-3.1-flash-image',
   candidates:[{finishReason:'STOP',content:{parts:[{text:'Generated image'},{inlineData:{mimeType:'image/png',data:'aW1hZ2U='}}]}}],
   usageMetadata:{promptTokenCount:100,candidatesTokenCount:1150,thoughtsTokenCount:0,
    candidatesTokensDetails:[{modality:'IMAGE',tokenCount:1120},{modality:'TEXT',tokenCount:30}]}
  };
  return new Response('data: '+JSON.stringify(response)+'\n\n',{headers:{'content-type':'text/event-stream'}});
 },f.factory);
 const url='https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:streamGenerateContent?alt=sse';
 const payload={contents:[{role:'user',parts:[{text:'Generate a photorealistic portrait'}]}],
  generationConfig:{maxOutputTokens:1024,responseModalities:['TEXT','IMAGE'],imageConfig:{imageSize:'1K'}}};
 const result=await runWithStandaloneAccounting({...context,requestId:'reviewed-image-generation'},()=>send(url,{method:'POST',body:JSON.stringify(payload)}));
 assert.equal(result.status,200);
 assert.equal(paid,1);
 const attempt=f.attempts[0];
 assert.equal(attempt.state,'settled');
 assert.equal(attempt.usage?.imageOutputTokens,1120);
 assert.equal(attempt.actual_microusd,'67340'); // 100 input at 500 nano + 30 text at 3000 nano +1120 image at 60000 nano
 assert.ok(Number(attempt.reserved_microusd)>=Number(attempt.actual_microusd));
 const replay=await runWithStandaloneAccounting({...context,requestId:'reviewed-image-generation',resumed:true},()=>send(url,{method:'POST',body:JSON.stringify(payload)}));
 assert.equal(replay.status,200);assert.equal(paid,1,'replay never incurs duplicate image charges');
});

test('Gemini image quote refuses unreviewed model or resolution before provider transmission',async()=>{
 const f=fakeLedger();let paid=0;
 const send=createAccountingFetch('google',async()=>{paid++;return Response.json({})},f.factory);
 for(const [index,model,imageSize] of [['unpriced','nano-banana-pro-preview','1K'],['wrong-size','gemini-3.1-flash-image','2K']] as const){
  await assert.rejects(runWithStandaloneAccounting({...context,requestId:'image-'+index},()=>send(
   'https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent',
   {method:'POST',body:JSON.stringify({contents:[{role:'user',parts:[{text:'draw portrait'}]}],
    generationConfig:{maxOutputTokens:256,responseModalities:['TEXT','IMAGE'],imageConfig:{imageSize}}})}
  )),isStandaloneAccountingError);
 }
 assert.equal(paid,0);assert.equal(f.attempts.length,0);
});


test('diagnostic direct-versus-Katie mock sends byte-identical prepared payload without paid inference',async()=>{
  const fake=fakeLedger();const katieEvents:ProviderTraceEvent[]=[];const directEvents:ProviderTraceEvent[]=[];
  const transmitted:string[]=[];
  const upstream:typeof fetch=async(_url,init)=>{
    transmitted.push(String(init?.body));
    return receipt('mock-receipt');
  };
  const send=createAccountingFetch('openai',upstream,fake.factory);
  const meta={taskName:'routing-rerank',requestId:context.requestId,provider:'openai',modelId:'gpt-4o'};
  const viaKatie=await runWithStandaloneAccounting(context,()=>runProviderAttemptTrace(meta,async()=>{
    recordProviderTrace('request_preparation_started');
    const result=await send('https://api.openai.com/v1/chat/completions',request);
    recordProviderTrace('response_parsing_completed');
    return result;
  },event=>katieEvents.push(event)));
  assert.equal(viaKatie.status,200);
  assert.equal(fake.attempts[0].state,'settled');
  assert.equal(transmitted.length,1);
  assert.equal(transmitted[0],fake.attempts[0].prepared_payload.serializedBody);
  const exactPrepared=transmitted[0];
  await runProviderAttemptTrace(meta,async()=>{
    recordProviderTrace('request_preparation_started');
    recordProviderTrace('request_preparation_completed');
    recordProviderTrace('dispatch_initiated');
    const response=await upstream('https://api.openai.com/v1/chat/completions',{method:'POST',body:exactPrepared});
    recordProviderTrace('response_headers_received',{httpStatus:response.status});
    const text=await readProviderResponseText(response);
    assert.ok(JSON.parse(text).id);
    recordProviderTrace('response_parsing_completed');
  },event=>directEvents.push(event));
  assert.equal(transmitted.length,2);
  assert.equal(transmitted[1],transmitted[0]);
  for(const stages of [katieEvents,directEvents]){
    for(const stage of ['dispatch_initiated','response_headers_received','first_response_chunk_received','response_body_received','response_parsing_completed']){
      assert.ok(stages.some(event=>event.phase===stage),stage);
    }
  }
  const katieHeaders=katieEvents.find(event=>event.phase==='response_headers_received')!;
  const katieDispatch=katieEvents.find(event=>event.phase==='dispatch_initiated')!;
  assert.ok(katieHeaders.elapsedMs>=katieDispatch.elapsedMs);
  assert.equal(katieEvents.find(event=>event.phase==='provider_receipt_observed')?.attemptId,fake.attempts[0].id);
  assert.equal(katieEvents.at(-1)?.observed?.receipt,true);
  assert.equal(directEvents.at(-1)?.observed?.receipt,false,'direct mock has no accounting receipt reconciliation');
});

test('diagnostics distinguish actual provider HTTP rate limiting from missing receipt',async()=>{
  const fake=fakeLedger();const events:ProviderTraceEvent[]=[];let sends=0;
  const send=createAccountingFetch('openai',async()=>{
    sends++;
    return new Response(JSON.stringify({error:{type:'rate_limit_exceeded',message:'private response body'}}),{status:429});
  },fake.factory);
  const httpError=await runWithStandaloneAccounting({...context,requestId:'trace-rate-limited'},()=>runProviderAttemptTrace({
    taskName:'routing-rerank',requestId:'trace-rate-limited',provider:'openai',modelId:'gpt-4o',
  },()=>send('https://api.openai.com/v1/chat/completions',request),event=>events.push(event)));
  assert.equal(httpError.status,429,'real provider rate limit is returned verbatim, never synthesized');
  assert.equal(sends,1);
  assert.equal(fake.attempts[0].state,'uncertain');
  assert.equal(events.find(e=>e.phase==='response_headers_received')?.httpStatus,429);
  assert.equal(events.find(e=>e.phase==='provider_http_rejection')?.failureCategory,'provider_rate_limit');
  assert.equal(events.find(e=>e.phase==='provider_http_rejection')?.errorCode,'rate_limit_exceeded');
  assert.equal(events.some(e=>e.phase==='local_synthetic_response'),false);
  assert.equal(events.some(e=>e.phase==='provider_receipt_missing'),true);
  assert.equal(events.at(-1)?.observed?.receipt,false);
  assert.equal(JSON.stringify(events).includes('private response body'),false);
});

test('diagnostics mark complete HTTP body and missing provider receipt separately',async()=>{
  const fake=fakeLedger();const events:ProviderTraceEvent[]=[];
  const send=createAccountingFetch('openai',async()=>new Response('{"choices":[]}',{status:200}),fake.factory);
  const completed=await runWithStandaloneAccounting({...context,requestId:'trace-missing-receipt'},()=>runProviderAttemptTrace({
    taskName:'routing-rerank',requestId:'trace-missing-receipt',provider:'openai',modelId:'gpt-4o',
  },()=>send('https://api.openai.com/v1/chat/completions',request),event=>events.push(event)));
  assert.equal(completed.status,200,'a complete HTTP body is still returned even when usage reporting is incomplete');
  assert.equal(events.find(e=>e.phase==='response_headers_received')?.httpStatus,200);
  assert.equal(events.at(-1)?.observed?.completeBody,true);
  assert.equal(events.at(-1)?.observed?.receipt,false);
  assert.equal(events.some(e=>e.phase==='provider_receipt_missing'),true);
  assert.equal(fake.attempts[0].state,'uncertain');
});

test('diagnostics distinguish owner abort request from transport abort observation',async()=>{
  const fake=fakeLedger();const controller=new AbortController();const events:ProviderTraceEvent[]=[];
  const send=createAccountingFetch('openai',async(_url,init)=>{
    controller.abort();
    init?.signal?.throwIfAborted();
    throw Error('Unexpected transport continuation');
  },fake.factory);
  await assert.rejects(runWithStandaloneAccounting({...context,requestId:'trace-cancelled',signal:controller.signal},()=>runProviderAttemptTrace({
    taskName:'routing-rerank',requestId:'trace-cancelled',provider:'openai',modelId:'gpt-4o',
  },()=>send('https://api.openai.com/v1/chat/completions',request),event=>events.push(event))),isStandaloneAccountingError);
  assert.equal(fake.attempts[0].state,'uncertain');
  assert.equal(events.filter(e=>e.phase==='cancellation_requested').length,1);
  assert.equal(events.find(e=>e.phase==='cancellation_requested')?.cancellationReason,'parent_signal');
  assert.equal(events.some(e=>e.phase==='cancellation_acknowledged'),true);
  assert.equal(events.at(-1)?.observed?.cancellationAcknowledged,true);
});

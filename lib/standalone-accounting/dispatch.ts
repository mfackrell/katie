import { createStandaloneLedger, StandaloneAccountingError } from './ledger';
import { getAccountingScope, nextStandaloneAttempt } from './context';
import { prepareStandaloneRequest, estimatePreparedRequest, freezePreparedRequest, ESTIMATOR_VERSION } from './estimate';
import { getModelPrice, priceTokenUsage, PRICING_VERSION, PRICING_SNAPSHOT, type AccountingProvider } from './pricing';
import type { ResponseCheckpoint } from './types';

const hosts: Record<AccountingProvider, string> = { openai: 'api.openai.com', anthropic: 'api.anthropic.com', google: 'generativelanguage.googleapis.com', grok: 'api.x.ai' };
const activeTransmissions = new Map<string, AbortController>();
/** Owner binding is checked durably before aborting an in-flight local request. */
export async function cancelStandaloneAttempt(ownerId: string, attemptId: string) {
  const attempt = await createStandaloneLedger().cancel(ownerId, attemptId);
  activeTransmissions.get(`${ownerId}:${attemptId}`)?.abort();
  return attempt;
}
function failure(code: string, message: string): StandaloneAccountingError { return new StandaloneAccountingError(`standalone_${code}`, message); }
function restore(checkpoint: ResponseCheckpoint): Response {
  const headers = new Headers(checkpoint.headers);
  // fetch has already decompressed the captured body.
  headers.delete('content-encoding'); headers.delete('content-length');
  return new Response(checkpoint.body, { status: checkpoint.status, statusText: checkpoint.statusText, headers });
}
type Receipt = { id: string; responseId: string | null; input: number; output: number; cached: number; resolvedModel: string | null; raw: Record<string, unknown> };
function receiptFromResponse(body: string, headers: Headers, provider: AccountingProvider, endpoint: string, streaming: boolean): Receipt | undefined {
  let id = headers.get('x-request-id') ?? headers.get('request-id') ?? headers.get('x-goog-request-id') ?? '';
  let input: number | undefined, output: number | undefined, cached = 0;
  let resolvedModel: string | null = null;
  let responseId: string | null = null;
  let unsupportedUsage = false;
  let anthropicDelta = false, anthropicStop = false, responseTerminal = false, chatFinish = false, done = false, googleTerminal = false, googleFinalUsage = false, malformed = false;
  let raw: Record<string, unknown> = {};
  function inspect(candidate: unknown) {
    if (!candidate || typeof candidate !== 'object') return;
    const item = candidate as Record<string, unknown>;
    if (item.error || item.type === 'error') malformed = true;
    if (item.type === 'message_delta' && typeof (item.usage as Record<string, unknown> | undefined)?.output_tokens === 'number') anthropicDelta = true;
    if (item.type === 'message_stop') anthropicStop = true;
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(String(item.type))) {
      const finalUsage = (item.response as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
      responseTerminal = typeof finalUsage?.input_tokens === 'number' && typeof finalUsage?.output_tokens === 'number';
    }
    if (Array.isArray(item.choices) && item.choices.some(choice => choice && typeof choice === 'object' && typeof choice.finish_reason === 'string')) chatFinish = true;
    if (Array.isArray(item.candidates) && item.candidates.some(candidate => candidate && typeof candidate === 'object' && typeof candidate.finishReason === 'string' && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED')) {
      googleTerminal = true;
      const finalUsage = item.usageMetadata as Record<string, unknown> | undefined;
      googleFinalUsage = typeof finalUsage?.promptTokenCount === 'number' && typeof finalUsage?.candidatesTokenCount === 'number';
    }
    if (typeof item.id === 'string') id = responseId = item.id;
    if (typeof item.responseId === 'string') id = responseId = item.responseId;
    if (typeof item.model === 'string') resolvedModel = item.model;
    if (typeof item.modelVersion === 'string') resolvedModel = item.modelVersion;
    if (item.response) inspect(item.response);
    if (item.message) inspect(item.message);
    const usage = (item.usage ?? item.usageMetadata) as Record<string, unknown> | undefined;
    if (!usage) return;
    raw = { ...raw, ...usage };
    const nonzero = (value: unknown): boolean => typeof value === 'number' ? value !== 0
      : !!value && typeof value === 'object' ? Object.values(value).some(nonzero) : false;
    for (const key of ['cache_creation_input_tokens', 'server_tool_use', 'audio_tokens', 'audioTokenCount', 'image_output_tokens']) {
      if (nonzero(usage[key])) unsupportedUsage = true;
    }
    for (const key of ['input_tokens_details', 'prompt_tokens_details', 'completion_tokens_details', 'output_tokens_details']) {
      const details = usage[key] as Record<string, unknown> | undefined;
      if (details && (nonzero(details.audio_tokens) || nonzero(details.image_tokens))) unsupportedUsage = true;
    }
    const inValue = usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount;
    const outValue = usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount;
    if (typeof inValue === 'number') input = inValue;
    if (typeof outValue === 'number') output = outValue;
    if (provider === 'google' && typeof usage.thoughtsTokenCount === 'number') output = (typeof outValue === 'number' ? outValue : 0) + usage.thoughtsTokenCount;
    const details = (usage.input_tokens_details ?? usage.prompt_tokens_details) as Record<string, unknown> | undefined;
    const cachedValue = details?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cachedContentTokenCount;
    if (typeof cachedValue === 'number') cached = cachedValue;
    // Anthropic's input_tokens excludes cache read/write tokens. Writes have no
    // supported price here, so preserve exposure rather than inventing a cost.
    if (provider === 'anthropic' && typeof usage.cache_creation_input_tokens === 'number' && usage.cache_creation_input_tokens > 0) input = undefined;
    else if (provider === 'anthropic' && typeof inValue === 'number') input = inValue + cached;
  }
  if (!streaming) {
    try { inspect(JSON.parse(body)); } catch { malformed = true; }
  } else {
    for (const event of body.replace(/\r\n/g, '\n').split('\n\n')) {
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data === '[DONE]') done = true;
      else if (data) { try { inspect(JSON.parse(data)); } catch { malformed = true; } }
    }
  }
  const terminal = !streaming ? provider !== 'google' || googleTerminal
    : provider === 'anthropic' ? anthropicDelta && anthropicStop
    : provider === 'google' ? googleTerminal && googleFinalUsage
    : endpoint.endsWith('/responses') ? responseTerminal : chatFinish && done;
  if (!terminal || malformed || unsupportedUsage || !id || ![input, output, cached].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return undefined;
  return { id, responseId, input: input!, output: output!, cached, resolvedModel, raw };
}

/** Every actual paid HTTP transmission passes here, after SDK serialization.
 * The injected transport and ledger factory allow isolated tests with no paid calls. */
export function createAccountingFetch(provider: AccountingProvider, transport: typeof fetch = globalThis.fetch.bind(globalThis), ledgerFactory = createStandaloneLedger): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.hostname !== hosts[provider] || url.protocol !== 'https:' || url.port || url.username || url.password) throw failure('transport_destination', 'Provider accounting rejected an unexpected destination.');
    const freeCount = method === 'POST' && (provider === 'openai' && url.pathname === '/v1/responses/input_tokens'
      || provider === 'anthropic' && url.pathname === '/v1/messages/count_tokens'
      || provider === 'google' && /^\/v1(?:beta)?\/models\/[^/]+:countTokens$/.test(url.pathname));
    if (method === 'GET' || method === 'HEAD' || freeCount) return transport(input, init);
    const scope = getAccountingScope();
    if (scope?.kind === 'orchestrator') return transport(input, init);
    const attemptScope = nextStandaloneAttempt();
    if (!attemptScope) throw failure('context_missing', 'Provider transmission requires a trusted standalone accounting context.');
    const { context, attemptKey } = attemptScope;
    if (url.search && !(provider === 'google' && url.pathname.endsWith(':streamGenerateContent') && url.search === '?alt=sse')) throw failure('unsupported_transport', 'Provider accounting rejected unsupported request parameters.');
    const requestedSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signals = [context.signal, requestedSignal].filter((value): value is AbortSignal => !!value);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    if (signal?.aborted) throw failure('cancelled', 'Provider request was cancelled before admission.');
    if (method !== 'POST') throw failure('unsupported_transport', 'This provider operation has no supported accounting estimate.');
    let payload: Record<string, unknown>;
    try {
      const serialized = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      if (typeof serialized !== 'string') throw new Error('Expected JSON');
      const value = JSON.parse(serialized);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
      payload = value;
    } catch { throw failure('unsupported_payload', 'Provider accounting requires a supported JSON request.'); }
    const model = typeof payload.model === 'string' ? payload.model : decodeURIComponent(url.pathname.match(/\/models\/([^/:]+):/)?.[1] ?? '');
    let prepared = prepareStandaloneRequest(provider, model, url.pathname, payload);
    const ledger = ledgerFactory();
    await ledger.registerPricing(PRICING_VERSION, PRICING_SNAPSHOT);
    let attempt = await ledger.lookupAttempt(context.userId, context.requestId, attemptKey);
    if (attempt && (attempt.source_prepared_hash ?? attempt.prepared_hash) !== prepared.hash) throw failure('replay_mismatch', 'The prepared request changed. Resume requires the exact approved request.');
    if (attempt) {
      if (attempt.state !== 'settled' && attempt.pricing_version !== PRICING_VERSION) throw failure('pricing_changed', 'The saved approval uses a different pricing version. A fresh quote and approval are required.');
      if (attempt.state !== 'settled' && attempt.estimator_version !== ESTIMATOR_VERSION) throw failure('estimate_changed', 'The saved estimate uses a different formula version. A fresh quote and approval are required.');
      const saved = attempt.prepared_payload as unknown as typeof prepared;
      prepared = freezePreparedRequest(saved.provider, saved.model, saved.endpoint, saved.payload);
      if (prepared.hash !== attempt.prepared_hash || prepared.provider !== provider || prepared.model !== attempt.model || prepared.endpoint !== url.pathname
        || prepared.model !== model && !attempt.supersedes_attempt_id) throw failure('replay_mismatch', 'Saved approved request does not match its dispatch binding.');
    }
    const estimate = estimatePreparedRequest(prepared);
    if (estimate.status !== 'estimated' || estimate.reservationMicrousd === null) throw Object.assign(failure('unsupported_billing', 'This provider request has no supported accounting estimate.'), { issues: estimate.issues });
    if (attempt && attempt.state !== 'settled' && BigInt(attempt.reserved_microusd) !== BigInt(estimate.reservationMicrousd)) throw failure('estimate_changed', 'The saved reservation differs from the verified prepared request estimate. A fresh quote is required.');
    const reconcile = async (checkpoint: ResponseCheckpoint, attemptId: string) => {
      const receipt = receiptFromResponse(checkpoint.body, new Headers(checkpoint.headers), provider, prepared.endpoint, prepared.payload.stream === true || prepared.endpoint.endsWith(':streamGenerateContent'));
      if (!receipt) {
        await ledger.markUncertain(context.userId, attemptId, 'Response received without supported complete provider usage and receipt; reservation remains held.');
        throw failure('outcome_unknown', 'Provider usage is incomplete. Spending exposure remains reserved; automatic continuation stopped.');
      }
      const receiptHeaders = new Headers(checkpoint.headers);
      await ledger.recordProviderIdentifiers(context.userId, attemptId, receiptHeaders.get('request-id') ?? receiptHeaders.get('x-request-id') ?? receiptHeaders.get('x-goog-request-id'), receipt.responseId);
      const usage = { ...receipt.raw, inputTokens: receipt.input, outputTokens: receipt.output, cachedInputTokens: receipt.cached };
      // A returned dated alias is a distinct billing identity. Missing exact
      // reviewed applicability leaves actual cost unknown, even with full tokens.
      const billedModel = receipt.resolvedModel ?? prepared.model;
      const price = getModelPrice(provider, billedModel);
      const evidence = { kind: 'provider_receipt', requestHash: prepared.hash, httpStatus: checkpoint.status, pricingVersion: PRICING_VERSION,
        requestedModel: prepared.model, resolvedModel: receipt.resolvedModel, pricedModel: price ? billedModel : null, pricingUnknown: !price };
      if (!price) {
        await ledger.recordPartialUsage(context.userId, attemptId, usage, evidence);
        throw failure('resolved_model_unpriced', 'The provider returned a model without an exact reviewed price. Known usage is saved; spending exposure remains reserved.');
      }
      let actualMicrousd: string;
      try { actualMicrousd = priceTokenUsage(price, receipt.input, receipt.output, receipt.cached); }
      catch {
        await ledger.recordPartialUsage(context.userId, attemptId, usage, { ...evidence, pricedModel: null, pricingUnknown: true });
        throw failure('usage_unpriced', 'The provider returned an unsupported billing dimension. Known usage is saved; spending exposure remains reserved.');
      }
      await ledger.settle({ ownerId: context.userId, attemptId, provider, providerReceiptId: receipt.id,
        actualMicrousd, usage, evidence });
    };
    if (attempt?.response_checkpoint) {
      if (attempt.state !== 'settled') await reconcile(attempt.response_checkpoint, attempt.id);
      return restore(attempt.response_checkpoint);
    }
    if (attempt && ['dispatched', 'uncertain', 'settled'].includes(attempt.state)) throw failure('outcome_unknown', 'A previous provider attempt has no replayable response. Its reservation remains held.');
    if (!attempt) attempt = await ledger.admit({ ownerId: context.userId, actorId: context.actorId, chatId: context.chatId, requestId: context.requestId, attemptKey,
      preparedHash: prepared.hash, preparedPayload: prepared as unknown as Record<string, unknown>, pricingVersion: PRICING_VERSION, provider, model,
      reservedMicrousd: estimate.reservationMicrousd, category: context.activity ?? 'standalone',
      preflightEstimate: estimate, estimatorVersion: estimate.estimatorVersion, reason: context.reason ?? context.activity ?? 'Standalone provider request' });
    if (attempt.state === 'paused') throw Object.assign(failure('approval_required', 'This prepared provider request is paused for spending approval.'), { attemptId: attempt.id });
    if (signal?.aborted) { await ledger.cancel(context.userId, attempt.id); throw failure('cancelled', 'Provider request was cancelled before dispatch.'); }
    const claimed = await ledger.claimDispatch(context.userId, attempt.id);
    if (!claimed) throw failure('dispatch_conflict', 'This provider attempt cannot be dispatched again.');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete('content-length');
    const controller = new AbortController();
    const transmissionSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(180_000)]);
    const activeKey = `${context.userId}:${attempt.id}`;
    activeTransmissions.set(activeKey, controller);
    let pollingCancellation = false;
    const cancellationPoll = setInterval(() => {
      if (pollingCancellation) return;
      pollingCancellation = true;
      void ledger.lookupAttempt(context.userId, context.requestId, attemptKey).then(current => {
        if (!current || current.cancelled_by_owner_at) controller.abort();
      }).catch(() => controller.abort()).finally(() => { pollingCancellation = false; });
    }, 2_000);
    cancellationPoll.unref();
    try {
      // Serialize only the frozen, authorized value. Callbacks cannot mutate it.
      const response = await transport(url, { ...init, method, headers, body: prepared.serializedBody, signal: transmissionSignal, redirect: 'manual' });
      await ledger.recordProviderIdentifiers(context.userId, attempt.id, response.headers.get('request-id') ?? response.headers.get('x-request-id') ?? response.headers.get('x-goog-request-id'), null);
      const body = await response.text();
      const checkpoint: ResponseCheckpoint = { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body };
      await ledger.checkpointResponse(context.userId, attempt.id, checkpoint);
      await reconcile(checkpoint, attempt.id);
      return restore(checkpoint);
    } catch (error) {
      await ledger.markUncertain(context.userId, attempt.id, error instanceof StandaloneAccountingError ? error.message : 'Transmission or response reconciliation did not complete; reservation remains held.').catch(() => undefined);
      if (error instanceof StandaloneAccountingError) throw Object.assign(error, { attemptId: attempt.id });
      throw Object.assign(failure('outcome_unknown', 'The provider outcome is uncertain. Spending exposure remains reserved; automatic retry stopped.'), { cause: error, attemptId: attempt.id });
    } finally { clearInterval(cancellationPoll); activeTransmissions.delete(activeKey); }
  };
}

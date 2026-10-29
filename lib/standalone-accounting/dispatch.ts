import { captureControlPlanePreparation, isCapturingControlPlanePreparation } from '@/lib/router/control-plane-economics';
import { freezeStoredImages } from './immutable-media';
import { loadStandalonePricing } from './pricing-intake';
import { createStandaloneLedger, StandaloneAccountingError } from './ledger';
import { getAccountingScope, nextStandaloneAttempt } from './context';
import { canonicalJson, prepareStandaloneRequest, estimatePreparedRequest, freezePreparedRequest, ESTIMATOR_VERSION } from './estimate';
import { getModelPrice, priceTokenUsage, type AccountingProvider } from './pricing';
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
/** Acknowledgement permits using real saved output, never inventing a lost result.
 * Completion is checked separately from receipt/usage evidence. */
function safeUncertainCheckpoint(checkpoint: ResponseCheckpoint, provider: AccountingProvider, endpoint: string): boolean {
  if (checkpoint.status < 200 || checkpoint.status >= 300) return false;
  const googleBlocked = (body:{promptFeedback?:{blockReason?:string};candidates?:unknown[]}) => provider==='google'&&Boolean(body.promptFeedback?.blockReason)&&body.promptFeedback?.blockReason!=='BLOCK_REASON_UNSPECIFIED'&&!(body.candidates?.length);
  const streaming = new Headers(checkpoint.headers).get('content-type')?.includes('text/event-stream');
  if (streaming) {
    const events = checkpoint.body.replace(/\r\n/g,'\n').split('\n\n').flatMap(event => {
      const data=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if(!data||data==='[DONE]')return [];try{return [JSON.parse(data)];}catch{return [{error:true}];}
    });
    if(events.some(event=>event.error||event.type==='error'))return false;
    if(events.some(googleBlocked))return true;
    if(provider==='anthropic')return events.some(event=>event.type==='message_stop')&&events.some(event=>event.type==='message_delta'&&event.delta?.stop_reason&&event.delta.stop_reason!=='max_tokens');
    if(endpoint.endsWith('/responses'))return events.some(event=>event.type==='response.completed');
    if(provider!=='google')return checkpoint.body.includes('[DONE]')&&events.some(event=>event.choices?.some((choice:{finish_reason?:string})=>['stop','tool_calls','function_call'].includes(choice.finish_reason??'')))&&!events.some(event=>event.choices?.some((choice:{finish_reason?:string})=>choice.finish_reason&&!['stop','tool_calls','function_call'].includes(choice.finish_reason)));
    return events.some(event=>event.candidates?.some((candidate:{finishReason?:string})=>candidate.finishReason==='STOP'));
  }
  try {
    const body=JSON.parse(checkpoint.body);
    if(body.error)return false;
    // A definitive provider refusal is a complete saved outcome. Replay it to
    // the existing caller's refusal/fallback handling; never invent text or usage.
    if(googleBlocked(body))return true;
    if(provider==='anthropic')return Array.isArray(body.content)&&Boolean(body.stop_reason)&&body.stop_reason!=='max_tokens';
    if(provider==='google')return body.candidates?.some((candidate:{finishReason?:string})=>candidate.finishReason==='STOP')===true;
    if(endpoint.endsWith('/responses'))return body.status==='completed'&&Array.isArray(body.output);
    return Array.isArray(body.choices)&&body.choices.length>0&&body.choices.every((choice:{finish_reason?:string;message?:unknown})=>Boolean(choice.message)&&['stop','tool_calls','function_call'].includes(choice.finish_reason??''));
  }catch{return false;}
}
type Receipt = { id: string; responseId: string | null; input: number; output: number; cached: number; written: number; cacheWriteTtl: '5m' | '30m' | '12h' | null; cacheWriteUnpriced: boolean; resolvedModel: string | null; raw: Record<string, unknown> };
/** Only actual Anthropic breakpoint locations establish TTL. Arbitrary JSON in
 * tool arguments, schemas or results cannot prove a provider cache policy. */
function hasOnlyFiveMinuteClaudeCache(payload: Record<string, unknown>): boolean {
  const controls: unknown[] = [];
  const collect = (value: Record<string, unknown>) => { if (value.cache_control !== undefined) controls.push(value.cache_control); };
  const blocks = (content: unknown) => {
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const block = item as Record<string, unknown>;
      collect(block);
      if (block.type === 'tool_result') blocks(block.content);
    }
  };
  collect(payload); blocks(payload.system);
  if (Array.isArray(payload.messages)) for (const message of payload.messages) if (message && typeof message === 'object') blocks((message as Record<string, unknown>).content);
  if (Array.isArray(payload.tools)) for (const tool of payload.tools) if (tool && typeof tool === 'object') collect(tool as Record<string, unknown>);
  return controls.length > 0 && controls.length <= 4 && controls.every(control => {
    if (!control || typeof control !== 'object' || Array.isArray(control)) return false;
    const value = control as Record<string, unknown>;
    return value.type === 'ephemeral' && (value.ttl === undefined || value.ttl === '5m') && Object.keys(value).every(key => key === 'type' || key === 'ttl');
  });
}
function receiptFromResponse(body: string, headers: Headers, provider: AccountingProvider, endpoint: string, streaming: boolean, payload: Record<string, unknown>): Receipt | undefined {
  let id = headers.get('x-request-id') ?? headers.get('request-id') ?? headers.get('x-goog-request-id') ?? '';
  let input: number | undefined, output: number | undefined, cached = 0, written = 0;
  let cacheWriteTtl: '5m' | '30m' | '12h' | null = null, cacheWriteUnpriced = false;
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
    for (const key of ['server_tool_use', 'audio_tokens', 'audioTokenCount', 'image_output_tokens']) {
      if (nonzero(usage[key])) unsupportedUsage = true;
    }
    if (provider !== 'anthropic' && nonzero(usage.cache_creation_input_tokens)) unsupportedUsage = true;
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
    if(provider==='openai' && details?.cache_write_tokens!==undefined){
      if(typeof details.cache_write_tokens==='number'&&Number.isSafeInteger(details.cache_write_tokens)&&details.cache_write_tokens>=0)written=details.cache_write_tokens;
      else unsupportedUsage=true;
      const options=payload.prompt_cache_options as Record<string,unknown>|undefined;
      cacheWriteTtl=options?.ttl==='12h'?'12h':'30m';
    }
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
  if (provider === 'anthropic') {
    const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    const split = raw.cache_creation;
    const splitDetail = split && typeof split === 'object' && !Array.isArray(split) ? split as Record<string, unknown> : undefined;
    const splitFive = splitDetail?.ephemeral_5m_input_tokens ?? 0, splitHour = splitDetail?.ephemeral_1h_input_tokens ?? 0;
    const splitTotal = splitDetail && count(splitFive) && count(splitHour) ? splitFive + splitHour : undefined;
    const uncached = raw.input_tokens, read = raw.cache_read_input_tokens ?? 0, created = raw.cache_creation_input_tokens ?? splitTotal ?? 0;
    if (!count(uncached) || !count(read) || !count(created)) return undefined;
    cached = read; written = created; input = uncached + read + created;
    if (split !== undefined) {
      if (!split || typeof split !== 'object' || Array.isArray(split)) cacheWriteUnpriced = true;
      else {
        const detail = split as Record<string, unknown>;
        const five = detail.ephemeral_5m_input_tokens ?? 0, hour = detail.ephemeral_1h_input_tokens ?? 0;
        cacheWriteUnpriced = !count(five) || !count(hour) || hour > 0 || five + hour !== written
          || Object.keys(detail).some(key => !['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'].includes(key));
        if (!cacheWriteUnpriced && written > 0) cacheWriteTtl = '5m';
      }
    } else if (written > 0) {
      if (hasOnlyFiveMinuteClaudeCache(payload)) cacheWriteTtl = '5m';
      else cacheWriteUnpriced = true;
    }
  }
  if (!terminal || malformed || unsupportedUsage || !id || ![input, output, cached].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return undefined;
  return { id, responseId, input: input!, output: output!, cached, written, cacheWriteTtl, cacheWriteUnpriced, resolvedModel, raw };
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
    if (scope?.kind !== 'standalone') throw failure('context_missing', 'Provider transmission requires a trusted standalone accounting context.');
    const context = scope.context;
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
    let model = typeof payload.model === 'string' ? payload.model : decodeURIComponent(url.pathname.match(/\/models\/([^/:]+):/)?.[1] ?? '');
    // Capture candidate preparation before allocating an ordinal or touching the ledger.
    if (isCapturingControlPlanePreparation()) captureControlPlanePreparation(prepareStandaloneRequest(provider, model, url.pathname, payload));
    const { attemptKey } = nextStandaloneAttempt()!;
    const ledger = ledgerFactory();
    let attempt = await ledger.lookupAttempt(context.userId, context.requestId, attemptKey);
    let prepared;
    if (attempt && context.resumed) {
      // Resume is bound to the server-loaded original workflow. Mutable routing
      // metadata must never replace its already quoted provider request.
      const saved = attempt.prepared_payload as unknown as ReturnType<typeof prepareStandaloneRequest>;
      prepared = freezePreparedRequest(saved.provider, saved.model, saved.endpoint, saved.payload);
      if (prepared.hash !== attempt.prepared_hash || saved.serializedBody !== prepared.serializedBody
        || prepared.provider !== provider || prepared.model !== attempt.model || prepared.endpoint !== url.pathname) {
        throw failure('replay_mismatch', 'Saved approved request does not match its dispatch binding.');
      }
      model = prepared.model;
    } else {
      payload=await freezeStoredImages(payload);
      prepared = prepareStandaloneRequest(provider, model, url.pathname, payload);
      if (attempt && (attempt.source_prepared_hash ?? attempt.prepared_hash) !== prepared.hash) throw failure('replay_mismatch', 'The prepared request changed. Resume requires the exact approved request.');
      if (attempt) {
        const saved = attempt.prepared_payload as unknown as typeof prepared;
        prepared = freezePreparedRequest(saved.provider, saved.model, saved.endpoint, saved.payload);
        if (prepared.hash !== attempt.prepared_hash || prepared.provider !== provider || prepared.model !== attempt.model || prepared.endpoint !== url.pathname
          || prepared.model !== model && !attempt.supersedes_attempt_id) throw failure('replay_mismatch', 'Saved approved request does not match its dispatch binding.');
      }
    }
    let pricing=await loadStandalonePricing(ledger,attempt?.pricing_version);
    await ledger.registerPricing(pricing.version,pricing);
    if (attempt && attempt.state !== 'settled' && attempt.estimator_version !== ESTIMATOR_VERSION) throw failure('estimate_changed', 'The saved estimate uses a different formula version. A fresh quote and approval are required.');
    if(attempt&&['paused','reserved'].includes(attempt.state)){
      const current=await loadStandalonePricing(ledger);
      const oldPrice=getModelPrice(provider,prepared.model,pricing),currentPrice=getModelPrice(provider,prepared.model,current);
      if(!currentPrice)throw failure('unsupported_billing','The current validated catalog has no applicable price for this exact model. The saved attempt remains held.');
      if(!oldPrice||canonicalJson(oldPrice)!==canonicalJson(currentPrice)){
        const quote=estimatePreparedRequest(prepared,current);
        if(quote.status!=='estimated'||quote.reservationMicrousd===null)throw failure('unsupported_billing','Updated pricing cannot estimate this request: '+quote.issues.join('; '));
        attempt=await ledger.reprice(context.userId,attempt.id,current.version,quote as unknown as Record<string,unknown>);
        pricing=current;
      }
    }
    const estimate = estimatePreparedRequest(prepared,pricing);
    if (estimate.status !== 'estimated' || estimate.reservationMicrousd === null) throw Object.assign(failure('unsupported_billing', 'This provider request cannot be priced: '+estimate.issues.join('; ')), { issues: estimate.issues });
    if (attempt && attempt.state !== 'settled' && BigInt(attempt.reserved_microusd) !== BigInt(estimate.reservationMicrousd)) throw failure('estimate_changed', 'The saved reservation differs from the verified prepared request estimate. A fresh quote is required.');
    const reconcile = async (checkpoint: ResponseCheckpoint, attemptId: string) => {
      const receipt = receiptFromResponse(checkpoint.body, new Headers(checkpoint.headers), provider, prepared.endpoint, prepared.payload.stream === true || prepared.endpoint.endsWith(':streamGenerateContent'), prepared.payload);
      if (!receipt) {
        await ledger.markUncertain(context.userId, attemptId, 'Response received without supported complete provider usage and receipt; reservation remains held.');
        throw failure('outcome_unknown', 'Provider usage is incomplete. Spending exposure remains reserved; automatic continuation stopped.');
      }
      const receiptHeaders = new Headers(checkpoint.headers);
      await ledger.recordProviderIdentifiers(context.userId, attemptId, receiptHeaders.get('request-id') ?? receiptHeaders.get('x-request-id') ?? receiptHeaders.get('x-goog-request-id'), receipt.responseId);
      const usage:Record<string,unknown> = { ...receipt.raw, inputTokens: receipt.input, outputTokens: receipt.output, cachedInputTokens: receipt.cached,
        ...(['anthropic','openai'].includes(provider) ? { cacheReadInputTokens: receipt.cached, cacheCreationInputTokens: receipt.written, cacheWriteInputTokens: receipt.written, cacheWriteTtl: receipt.cacheWriteTtl } : {}) };
      // A returned dated alias is a distinct billing identity. Missing exact
      // reviewed applicability leaves actual cost unknown, even with full tokens.
      const billedModel = receipt.resolvedModel ?? prepared.model;
      const price = getModelPrice(provider, billedModel,pricing);
      const evidence = { kind: 'provider_receipt', requestHash: prepared.hash, httpStatus: checkpoint.status, pricingVersion: pricing.version,
        requestedModel: prepared.model, resolvedModel: receipt.resolvedModel, pricedModel: price ? billedModel : null, pricingUnknown: !price,
        ...(provider === 'anthropic' ? { cacheWriteTtl: receipt.cacheWriteTtl } : {}) };
      const inputDetails=(receipt.raw.input_tokens_details??receipt.raw.prompt_tokens_details) as Record<string,unknown>|undefined;
      if(provider==='openai'&&price?.cacheWriteNanoUsd&&typeof inputDetails?.cache_write_tokens!=='number'){
        delete usage.cacheWriteInputTokens;delete usage.cacheCreationInputTokens;delete usage.cacheWriteTtl;
        await ledger.recordPartialUsage(context.userId,attemptId,usage,{...evidence,pricingUnknown:true,missingDimension:'cache_write_tokens'});
        throw failure('usage_unpriced','OpenAI cache-write usage is missing. Known tokens and spending exposure remain held.');
      }
      if (receipt.cacheWriteUnpriced) {
        await ledger.recordPartialUsage(context.userId, attemptId, usage, { ...evidence, pricedModel: null, pricingUnknown: true });
        throw failure('usage_unpriced', 'The provider cache-write lifetime is unsupported or unproven. Known usage is saved; spending exposure remains reserved.');
      }
      if (!price) {
        await ledger.recordPartialUsage(context.userId, attemptId, usage, evidence);
        throw failure('resolved_model_unpriced', 'The provider returned a model without an exact reviewed price. Known usage is saved; spending exposure remains reserved.');
      }
      let actualMicrousd: string;
      try { actualMicrousd = priceTokenUsage(price, receipt.input, receipt.output, receipt.cached, receipt.written,receipt.cacheWriteTtl??'5m'); }
      catch {
        await ledger.recordPartialUsage(context.userId, attemptId, usage, { ...evidence, pricedModel: null, pricingUnknown: true });
        throw failure('usage_unpriced', 'The provider returned an unsupported billing dimension. Known usage is saved; spending exposure remains reserved.');
      }
      await ledger.settle({ ownerId: context.userId, attemptId, provider, providerReceiptId: receipt.id,
        actualMicrousd, usage, evidence });
    };
    if (attempt?.state === 'uncertain') {
      // Only durable server authority can acknowledge exposure. Never claim
      // dispatch, release money or reconcile incomplete evidence in this branch.
      if (!await ledger.uncertainExposureAccepted(context.userId,attempt.id)) throw Object.assign(failure('outcome_unknown','The provider call was already sent. Accept its uncertain exposure before continuing remaining work.'),{attemptId:attempt.id});
      if (!attempt.response_checkpoint || !safeUncertainCheckpoint(attempt.response_checkpoint,provider,prepared.endpoint)) throw Object.assign(failure('safe_checkpoint_unavailable','Uncertain exposure is accepted and retained, but this call has no complete saved response to replay safely. It will not be resent. Remaining dependent work cannot continue from this checkpoint.'),{attemptId:attempt.id});
      return restore(attempt.response_checkpoint);
    }
    if (attempt?.response_checkpoint) {
      if (attempt.state !== 'settled') await reconcile(attempt.response_checkpoint, attempt.id);
      return restore(attempt.response_checkpoint);
    }
    if (attempt && ['dispatched', 'uncertain', 'settled'].includes(attempt.state)) throw failure('outcome_unknown', 'A previous provider attempt has no replayable response. Its saved cost or exposure is retained; automatic resend is blocked.');
    if (!attempt) attempt = await ledger.admit({ ownerId: context.userId, actorId: context.actorId, chatId: context.chatId, requestId: context.requestId, attemptKey,
      preparedHash: prepared.hash, preparedPayload: prepared as unknown as Record<string, unknown>, pricingVersion: pricing.version, provider, model,
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

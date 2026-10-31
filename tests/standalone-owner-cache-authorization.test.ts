import {describe, it, expect} from 'vitest';
import { prepareStandaloneRequest, estimatePreparedRequest } from '../lib/standalone-accounting/estimate';
import { PRICING_SNAPSHOT, type PricingSnapshot } from '../lib/standalone-accounting/pricing';
import { OWNER_SELECTED_UNCACHED, proposeSelectedModelUncached, ownerSelectedUncachedEstimate } from '../lib/standalone-accounting/owner-cache-authorization';

const model = 'gpt-5.4-mini-2026-03-17';
const reviewed = PRICING_SNAPSHOT.models.find(price => price.provider === 'openai' && price.model === 'gpt-5-mini')!;
const pricing: PricingSnapshot = {...PRICING_SNAPSHOT,models:[...PRICING_SNAPSHOT.models,{...reviewed,model}]};
const prepare = (extra:Record<string,unknown>={}) => prepareStandaloneRequest('openai',model,'/v1/chat/completions',{
  model,messages:[{role:'user',content:'Keep this entire prompt and answer it.'}],max_completion_tokens:128,
  prompt_cache_key:'original-conversation-cache-key', ...extra,
});

describe('explicit same-model authorization when OpenAI cache metadata is unreviewed',()=>{
  it('offers an exact-model standard-rate alternative without transmitting any call',()=>{
    const initial = prepare();
    expect(estimatePreparedRequest(initial,pricing).issues).toContain('No reviewed no-fee cache metadata policy for this exact model');
    const quotePrepared = proposeSelectedModelUncached(initial,pricing)!;
    expect(quotePrepared).toBeDefined();
    expect(quotePrepared.hash).not.toBe(initial.hash);
    expect(quotePrepared.provider).toBe(initial.provider);
    expect(quotePrepared.model).toBe(initial.model);
    expect(quotePrepared.endpoint).toBe(initial.endpoint);
    expect(quotePrepared.payload.messages).toEqual(initial.payload.messages);
    expect(quotePrepared.payload.max_completion_tokens).toEqual(initial.payload.max_completion_tokens);
    expect(quotePrepared.payload).not.toHaveProperty('prompt_cache_key');
    expect(quotePrepared.payload).not.toHaveProperty('prompt_cache_retention');
    const quote = ownerSelectedUncachedEstimate(estimatePreparedRequest(quotePrepared,pricing),true);
    expect(quote.status).toBe('estimated');
    expect(BigInt(quote.reservationMicrousd!)).toBeGreaterThan(0n);
    expect(quote.ownerApprovalRequired).toBe(OWNER_SELECTED_UNCACHED);
    expect(quote.estimatorVersion).toBe('standalone-selected-model-uncached-v1');
    expect(quote.assumptions.join(' ')).toMatch(/Owner authorization is required/);
  });
  it('does not create an approval path for missing model rates, unsupported paid dimensions or non-OpenAI models',()=>{
    const unknown=prepareStandaloneRequest('openai','unknown-not-priced','/v1/chat/completions',{model:'unknown-not-priced',messages:[],prompt_cache_key:'x'});
    expect(proposeSelectedModelUncached(unknown,pricing)).toBeNull();
    expect(proposeSelectedModelUncached(prepare({service_tier:'priority'}),pricing)).toBeNull();
    const normal=prepareStandaloneRequest('openai','gpt-4o','/v1/chat/completions',{model:'gpt-4o',messages:[],prompt_cache_key:'approved-cache-key'});
    expect(proposeSelectedModelUncached(normal,pricing)).toBeNull();
    const claude=prepareStandaloneRequest('anthropic','claude-sonnet-4-6','/v1/messages',{model:'claude-sonnet-4-6',messages:[]});
    expect(proposeSelectedModelUncached(claude,pricing)).toBeNull();
  });
  it('does not mark an unsupported estimate as approved merely because it was requested',()=>{
    const unsupported=estimatePreparedRequest(prepare({service_tier:'priority'}),pricing);
    expect(ownerSelectedUncachedEstimate(unsupported,true)).toBe(unsupported);
  });
});

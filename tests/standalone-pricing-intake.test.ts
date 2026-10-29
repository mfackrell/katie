import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePricingCatalog, loadStandalonePricing, refreshStandalonePricing, MAX_PRICE_AGE_MS, PRICING_SOURCE } from '../lib/standalone-accounting/pricing-intake';
import { estimatePreparedRequest, freezePreparedRequest, actualCostFromUsage } from '../lib/standalone-accounting/estimate';
import { priceTokenUsage, type PricingSnapshot } from '../lib/standalone-accounting/pricing';
import type { createStandaloneLedger } from '../lib/standalone-accounting/ledger';
// Synthetic fixtures: rates below exercise arithmetic and are not provider prices.
const row={litellm_provider:'openai',mode:'chat',input_cost_per_token:0.000001,output_cost_per_token:0.000002,max_input_tokens:100000,max_output_tokens:10000};
const catalog=(extra={})=>({'fixture-pro':{...row,...extra}});
test('validated catalog is exact, content-addressed, frozen and independent of key order',()=>{
 const a=normalizePricingCatalog(catalog()),b=normalizePricingCatalog({'fixture-pro':{...row}});
 assert.equal(a.snapshot.version,b.snapshot.version);assert.ok(Object.isFrozen(a.snapshot.models[0]));
 assert.equal(a.snapshot.models[0].inputNanoUsd,'1000');
 assert.notEqual(normalizePricingCatalog(catalog({input_cost_per_token:0.000003})).snapshot.version,a.snapshot.version);
 const foreign=normalizePricingCatalog({...catalog(),'azure/fixture-pro':{...row,litellm_provider:'azure'},'openai/fixture-pro':{...row},'fixture-missing':{...row,output_cost_per_token:undefined}});
 assert.equal(foreign.snapshot.models.length,1);assert.ok(foreign.rejected['openai:fixture-missing']);
 assert.throws(()=>normalizePricingCatalog({'fixture':{...row,input_cost_per_token:-1}}));
 assert.throws(()=>normalizePricingCatalog({'fixture':{...row,input_cost_per_token:Infinity}}));
 assert.throws(()=>normalizePricingCatalog({'fixture':{...row,input_cost_per_token:1e-15}}));
 assert.throws(()=>normalizePricingCatalog({...catalog(),'openai/fixture-pro':{...row,input_cost_per_token:0.000004}}),/no validated/);
});
test('context, cache read/write and TTL dimensions survive intake and price separately',()=>{
 const snapshot=normalizePricingCatalog(catalog({cache_read_input_token_cost:0.0000001,cache_creation_input_token_cost:0.00000125,cache_creation_input_token_cost_above_12hr:0.0000025,
 input_cost_per_token_above_32k_tokens:0.000002,output_cost_per_token_above_32k_tokens:0.000004,cache_read_input_token_cost_above_32k_tokens:0.0000002,cache_creation_input_token_cost_above_32k_tokens:0.0000025,cache_creation_input_token_cost_above_12hr_above_32k_tokens:0.000005})).snapshot;
 const price=snapshot.models[0];assert.equal(price.tiers?.[0].cacheWrite12hNanoUsd,'5000');
 assert.equal(priceTokenUsage(price,100,10,20,30,'30m'),'110');
 assert.equal(priceTokenUsage(price,100,10,20,30,'12h'),'147');
 const req=freezePreparedRequest('openai','fixture-pro','/v1/responses',{model:'fixture-pro',input:'hi',max_output_tokens:10,prompt_cache_key:'scope',prompt_cache_options:{ttl:'30m'}});
 const quote=estimatePreparedRequest(req,snapshot);assert.equal(quote.status,'estimated');assert.equal(quote.cacheWriteTtl,'30m');assert.equal(quote.cacheWriteInputAllowance,quote.inputTokens);
 assert.equal(actualCostFromUsage(req,{inputTokens:100,outputTokens:10,cachedInputTokens:20,cacheWriteInputTokens:30,cacheWriteTtl:'30m'},snapshot).actualMicrousd,'110');
 const tierIncomplete=normalizePricingCatalog({...catalog(),'broken':{...row,input_cost_per_token_above_32k_tokens:0.000002}});
 assert.ok(tierIncomplete.rejected['openai:broken']);
});
test('scheduled refresh publishes validated immutable content; fresh reads and historical replay do not fetch',async()=>{
 const snapshot=normalizePricingCatalog(catalog()).snapshot;const published:unknown[]=[];
 const ledger={publishPricing:async(...args:unknown[])=>{published.push(args);return true;},loadPricing:async()=>({snapshot,retrievedAt:new Date().toISOString()})} as unknown as ReturnType<typeof createStandaloneLedger>;
 const transport:typeof fetch=async(url,init)=>{assert.equal(url,PRICING_SOURCE);assert.equal(init?.redirect,'error');return new Response(JSON.stringify(catalog()));};
 assert.equal((await refreshStandalonePricing(ledger,transport)).version,snapshot.version);assert.equal(published.length,1);
 assert.equal((published[0] as unknown[])[2]?.toString().length,64);
 assert.equal((await loadStandalonePricing(ledger)).version,snapshot.version);
 ledger.loadPricing=async()=>({snapshot,retrievedAt:new Date(Date.now()-MAX_PRICE_AGE_MS*2).toISOString()});
 assert.equal((await loadStandalonePricing(ledger,snapshot.version)).version,snapshot.version,'historical settlement remains valid after active-price expiry');
 ledger.loadPricing=async()=>({snapshot:{...snapshot,version:'wrong'},retrievedAt:new Date().toISOString()});
 await assert.rejects(loadStandalonePricing(ledger,snapshot.version),/mismatch/);
 const before=published.length;await assert.rejects(refreshStandalonePricing(ledger,async()=>new Response('{}')));assert.equal(published.length,before,'invalid source never activates');
 await assert.rejects(refreshStandalonePricing(ledger,async()=>new Response('outage',{status:503})));assert.equal(published.length,before);
});
test('supported text uses exact catalog rows for all four providers; unknown billing stays explicit',()=>{
 const raw=Object.fromEntries(['openai','anthropic','gemini','xai'].map((p,i)=>[`${p}/fixture-${i}`,{...row,litellm_provider:p}]));
 const snapshot=normalizePricingCatalog(raw).snapshot;assert.equal(snapshot.models.length,4);
 for(const p of snapshot.models){
  const endpoint=p.provider==='google'?'/v1beta/models/'+p.model+':generateContent':p.provider==='anthropic'?'/v1/messages':'/v1/responses';
  const payload=p.provider==='google'?{contents:[{role:'user',parts:[{text:'hello'}]}],generationConfig:{maxOutputTokens:10}}:p.provider==='anthropic'?{model:p.model,messages:[{role:'user',content:'hello'}],max_tokens:10}:{model:p.model,input:'hello',max_output_tokens:10};
  assert.equal(estimatePreparedRequest(freezePreparedRequest(p.provider,p.model,endpoint,payload),snapshot).status,'estimated');
 }
 const unsupported=estimatePreparedRequest(freezePreparedRequest('openai','fixture-0','/v1/responses',{model:'fixture-0',input:[{type:'input_audio',data:'bytes'}],max_output_tokens:10}),snapshot);
 assert.equal(unsupported.status,'unsupported');assert.ok(unsupported.issues.some(x=>/audio\/video/.test(x)));
});

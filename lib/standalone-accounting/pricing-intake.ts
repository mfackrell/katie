import { createHash } from 'node:crypto';
import { canonicalJson } from './estimate';
import { deepFreeze, PRICING_SNAPSHOT, type AccountingProvider, type ModelPrice, type PricingSnapshot, type PriceTier } from './pricing';
import type { createStandaloneLedger } from './ledger';
export const PRICING_SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const MAX_PRICE_AGE_MS = 24 * 60 * 60 * 1000;
type Row = Record<string, unknown>;
const providers: Record<string, AccountingProvider> = { openai:'openai', anthropic:'anthropic', gemini:'google', xai:'grok' };
function rate(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw Error('Missing or invalid price');
  const nano = value * 1e9, rounded = Math.round(nano);
  if (value>0&&rounded===0 || !Number.isSafeInteger(rounded) || Math.abs(nano-rounded)>1e-6) throw Error('Price precision exceeds nanoUSD');
  return String(rounded);
}
function limit(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value)<=0) throw Error('Missing finite model limit');
  return Number(value);
}
/** Only exact first-party identities are accepted, never suffix/family aliases or
 * hosted Azure/Bedrock/Vertex rates. Bad rows are quarantined independently. */
export function normalizePricingCatalog(raw: unknown): { snapshot: PricingSnapshot; rejected: Record<string,string> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid pricing catalog');
  const accepted = new Map<string,ModelPrice>(), rejected: Record<string,string> = {};
  for (const [key,value] of Object.entries(raw)) {
    if (!value || typeof value!=='object' || Array.isArray(value)) continue;
    const row=value as Row;
    if(!Object.hasOwn(providers,String(row.litellm_provider)))continue;
    const provider=providers[String(row.litellm_provider)];
    if (!provider || !['chat','responses'].includes(String(row.mode))) continue;
    const prefix=String(row.litellm_provider)+'/';
    const model=key.startsWith(prefix)?key.slice(prefix.length):key;
    if (!model || model.includes('/') || /[\s?#]/.test(model)) continue;
    try {
      for(const field of ['input_cost_per_request','output_cost_per_request','input_cost_per_query'])if(row[field]!==undefined&&row[field]!==0)throw Error('Unsupported fixed request charge: '+field);
      const known=PRICING_SNAPSHOT.models.find(p=>p.provider===provider&&p.model===model);
      const price:ModelPrice={provider,model,inputNanoUsd:rate(row.input_cost_per_token),outputNanoUsd:rate(row.output_cost_per_token),
        maxContextTokens:limit(row.max_input_tokens),maxOutputTokens:limit(row.max_output_tokens),source:PRICING_SOURCE,
        ...(known?.vision?{vision:known.vision}:{}),
        ...(row.supports_native_streaming===false?{supportsStreaming:false}:{}),
        ...(Array.isArray(row.supported_endpoints)&&row.supported_endpoints.includes('/v1/responses')&&!row.supported_endpoints.includes('/v1/chat/completions')?{responsesOnly:true}:{}),
      };
      if(row.cache_read_input_token_cost!==undefined)price.cachedInputNanoUsd=rate(row.cache_read_input_token_cost);
      if(row.cache_creation_input_token_cost!==undefined){
        if(provider==='anthropic')price.cacheWrite5mNanoUsd=rate(row.cache_creation_input_token_cost);
        else if(provider==='openai')price.cacheWriteNanoUsd=rate(row.cache_creation_input_token_cost);
        else throw Error('Unsupported cache-write schema');
      }
      if(provider==='openai'&&row.cache_creation_input_token_cost_above_12hr!==undefined)price.cacheWrite12hNanoUsd=rate(row.cache_creation_input_token_cost_above_12hr);
      // Preserve every standard text context tier. Different service tiers and
      // non-text prices are not applicable to standard text requests.
      const thresholds=new Set<number>();
      for(const field of Object.keys(row)){
        const m=/^(?:input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost(?:_above_12hr)?)_above_(\d+)k_tokens$/.exec(field);
        if(m)thresholds.add(Number(m[1])*1000);
        else if(/^(?:input_cost_per_token|output_cost_per_token)_above_/.test(field)&&!/(?:_batches|_flex|_priority|_ultrafast|_decisions)$/.test(field))throw Error('Unsupported context tier');
      }
      price.tiers=[...thresholds].sort((a,b)=>a-b).map(n=>{
        const suffix=`_above_${n/1000}k_tokens`;
        const t:PriceTier={aboveInputTokens:n,inclusive:provider==='grok',inputNanoUsd:rate(row['input_cost_per_token'+suffix]),outputNanoUsd:rate(row['output_cost_per_token'+suffix])};
        if(price.cachedInputNanoUsd!==undefined)t.cachedInputNanoUsd=rate(row['cache_read_input_token_cost'+suffix]);
        if(price.cacheWrite5mNanoUsd!==undefined)t.cacheWrite5mNanoUsd=rate(row['cache_creation_input_token_cost'+suffix]);
        if(price.cacheWriteNanoUsd!==undefined)t.cacheWriteNanoUsd=rate(row['cache_creation_input_token_cost'+suffix]);
        if(price.cacheWrite12hNanoUsd!==undefined)t.cacheWrite12hNanoUsd=rate(row['cache_creation_input_token_cost_above_12hr'+suffix]);
        return t;
      });
      const id=provider+':'+model, prior=accepted.get(id);
      if(prior&&canonicalJson(prior)!==canonicalJson(price))throw Error('Conflicting exact model entries');
      if(rejected[id])continue;accepted.set(id,price);
    } catch(error){const id=provider+':'+model;accepted.delete(id);rejected[id]=String(error instanceof Error?error.message:error);}
  }
  const models=[...accepted.values()].sort((a,b)=>(a.provider+':'+a.model).localeCompare(b.provider+':'+b.model));
  if(!models.length)throw Error('Catalog contains no validated first-party text prices');
  const data={currency:'USD',unit:'microUSD',rateUnit:'nanoUSD/token',scope:'first-party-global-standard',sources:[PRICING_SOURCE],models};
  const version='standalone-catalog-v1-'+createHash('sha256').update(canonicalJson(data)).digest('hex');
  return {snapshot:deepFreeze({...data,version}),rejected};
}
export async function refreshStandalonePricing(ledger:ReturnType<typeof createStandaloneLedger>, transport:typeof fetch=fetch){
  const response=await transport(PRICING_SOURCE,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('Pricing source unavailable');
  const bytes=await response.text();if(bytes.length>16*1024*1024)throw Error('Pricing catalog too large');
  const {snapshot,rejected}=normalizePricingCatalog(JSON.parse(bytes));
  await ledger.publishPricing(snapshot.version,snapshot,createHash('sha256').update(bytes).digest('hex'),rejected);
  return snapshot;
}
async function loadPricing(ledger:ReturnType<typeof createStandaloneLedger>,version?:string):Promise<PricingSnapshot>{
  if(version===PRICING_SNAPSHOT.version)return PRICING_SNAPSHOT;
  const saved=await ledger.loadPricing(version??null);
  if(saved){
    if(version&&saved.snapshot.version!==version)throw Object.assign(new Error('Historical pricing version mismatch'),{code:'standalone_pricing_changed'});
    if(version||Date.now()-Date.parse(saved.retrievedAt)<=MAX_PRICE_AGE_MS)return deepFreeze(saved.snapshot);
  }
  if(version)throw Error('Historical pricing version unavailable');
  // First use and stale-cache recovery are free catalog retrieval, not provider inference.
  return refreshStandalonePricing(ledger);
}

export async function loadStandalonePricing(ledger:ReturnType<typeof createStandaloneLedger>,version?:string):Promise<PricingSnapshot>{
  try{return await loadPricing(ledger,version);}
  catch(error){
    if(error&&typeof error==='object'&&'code' in error&&String(error.code).startsWith('standalone_'))throw error;
    throw Object.assign(new Error('Validated pricing is unavailable; paid dispatch is blocked.',{cause:error}),{code:'standalone_pricing_unavailable',terminal:true});
  }
}

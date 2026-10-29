/** Reviewed first-party global standard rates. Never derive money from model discovery. */
export const PRICING_VERSION = "standalone-pricing-2026-10-28-v3";
export type AccountingProvider = "openai" | "anthropic" | "google" | "grok";
export type PriceTier = { aboveInputTokens: number; inclusive?: boolean; inputNanoUsd: string; outputNanoUsd: string; cachedInputNanoUsd?: string;cacheWrite5mNanoUsd?:string;cacheWriteNanoUsd?:string;cacheWrite12hNanoUsd?:string };
export type ModelPrice = {
  provider: AccountingProvider; model: string; inputNanoUsd: string; outputNanoUsd: string;
  cachedInputNanoUsd?: string;cacheWrite5mNanoUsd?:string;cacheWriteNanoUsd?:string;cacheWrite12hNanoUsd?:string; maxContextTokens: number; maxOutputTokens: number;
  responsesOnly?: boolean; supportsStreaming?: boolean;
  vision?: { kind: "tiles"; base: number; tile: number } | { kind: "claude"; maximum: number } | { kind: "gemini25" };
  tiers?: PriceTier[]; source: string;
};
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
const openai = "https://developers.openai.com/api/docs/models/";
const claude = "https://platform.claude.com/docs/en/about-claude/pricing";
const google = "https://ai.google.dev/gemini-api/docs/pricing";
const grok = "https://docs.x.ai/developers/pricing";
const models: ModelPrice[] = [
  { provider:"openai", model:"gpt-4o", inputNanoUsd:"2500", outputNanoUsd:"10000", cachedInputNanoUsd:"1250", maxContextTokens:128000,maxOutputTokens:16384,vision:{kind:"tiles",base:85,tile:170},source:openai+"gpt-4o" },
  { provider:"openai", model:"gpt-4o-mini", inputNanoUsd:"150", outputNanoUsd:"600", cachedInputNanoUsd:"75", maxContextTokens:128000,maxOutputTokens:16384,vision:{kind:"tiles",base:2833,tile:5667},source:openai+"gpt-4o-mini" },
  { provider:"openai", model:"gpt-4.1", inputNanoUsd:"2000", outputNanoUsd:"8000", cachedInputNanoUsd:"500", maxContextTokens:1047576,maxOutputTokens:32768,vision:{kind:"tiles",base:85,tile:170},source:openai+"gpt-4.1" },
  { provider:"openai", model:"gpt-5", inputNanoUsd:"1250", outputNanoUsd:"10000",cachedInputNanoUsd:"125",maxContextTokens:400000,maxOutputTokens:128000,vision:{kind:"tiles",base:70,tile:140},source:openai+"gpt-5" },
  { provider:"openai", model:"gpt-5-mini", inputNanoUsd:"250", outputNanoUsd:"2000",cachedInputNanoUsd:"25",maxContextTokens:400000,maxOutputTokens:128000,source:openai+"gpt-5-mini" },
  { provider:"openai", model:"gpt-5.4", inputNanoUsd:"2500", outputNanoUsd:"15000",cachedInputNanoUsd:"250",maxContextTokens:1050000,maxOutputTokens:128000,tiers:[{aboveInputTokens:272000,inputNanoUsd:"5000",outputNanoUsd:"22500",cachedInputNanoUsd:"500"}],source:openai+"gpt-5.4" },
  ...["gpt-5.4-pro","gpt-5.4-pro-2026-03-05"].map((model):ModelPrice=>({provider:"openai",model,inputNanoUsd:"30000",outputNanoUsd:"180000",maxContextTokens:1050000,maxOutputTokens:128000,responsesOnly:true,supportsStreaming:true,tiers:[{aboveInputTokens:272000,inputNanoUsd:"60000",outputNanoUsd:"270000"}],source:openai+"gpt-5.4-pro"})),
  ...["gpt-5.5-pro","gpt-5.5-pro-2026-04-23"].map((model):ModelPrice=>({provider:"openai",model,inputNanoUsd:"30000",outputNanoUsd:"180000",cachedInputNanoUsd:"30000",maxContextTokens:1050000,maxOutputTokens:128000,responsesOnly:true,supportsStreaming:false,source:openai+"gpt-5.5-pro"})),
  { provider:"openai", model:"o3-pro", inputNanoUsd:"20000",outputNanoUsd:"80000",maxContextTokens:200000,maxOutputTokens:100000,source:openai+"o3-pro" },
  ...([ ["claude-sonnet-4-5","3000","15000","300","3750"], ["claude-haiku-4-5","1000","5000","100","1250"], ["claude-sonnet-4-6","3000","15000","300","3750"], ["claude-opus-4-6","5000","25000","500","6250"], ["claude-sonnet-5-5","2000","10000","100","2500"], ["claude-opus-5-5","4000","20000","200","5000"] ]).map(([model,inputNanoUsd,outputNanoUsd,cachedInputNanoUsd,cacheWrite5mNanoUsd]):ModelPrice => ({provider:"anthropic",model,inputNanoUsd,outputNanoUsd,cachedInputNanoUsd,cacheWrite5mNanoUsd,maxContextTokens:model.endsWith("4-5")?200000:1000000,maxOutputTokens:64000,vision:{kind:"claude",maximum:model.endsWith("5-5")?4784:1568},source:claude})),
  {provider:"google",model:"gemini-2.5-pro",inputNanoUsd:"1250",outputNanoUsd:"10000",cachedInputNanoUsd:"125",maxContextTokens:1048576,maxOutputTokens:65536,vision:{kind:"gemini25"},tiers:[{aboveInputTokens:200000,inputNanoUsd:"2500",outputNanoUsd:"15000",cachedInputNanoUsd:"250"}],source:google},
  {provider:"google",model:"gemini-2.5-flash",inputNanoUsd:"300",outputNanoUsd:"2500",cachedInputNanoUsd:"30",maxContextTokens:1048576,maxOutputTokens:65536,vision:{kind:"gemini25"},source:google},
  ...["grok-4.7","grok-4.6"].map((model):ModelPrice=>({provider:"grok",model,inputNanoUsd:"2000",outputNanoUsd:"6000",cachedInputNanoUsd:"500",maxContextTokens:500000,maxOutputTokens:30000,tiers:[{aboveInputTokens:200000,inclusive:true,inputNanoUsd:"4000",outputNanoUsd:"12000",cachedInputNanoUsd:"1000"}],source:grok})),
  {provider:"grok",model:"grok-4.3",inputNanoUsd:"1250",outputNanoUsd:"2500",cachedInputNanoUsd:"200",maxContextTokens:1000000,maxOutputTokens:30000,tiers:[{aboveInputTokens:200000,inclusive:true,inputNanoUsd:"2500",outputNanoUsd:"5000",cachedInputNanoUsd:"400"}],source:grok},
];
export const PRICING_SNAPSHOT = deepFreeze({version:PRICING_VERSION,verifiedAt:"2026-10-28",currency:"USD",unit:"microUSD",rateUnit:"nanoUSD/token",scope:"first-party-global-standard",sources:[...new Set(models.map(m=>m.source)),"https://developers.openai.com/api/docs/guides/images-vision","https://platform.claude.com/docs/en/build-with-claude/vision","https://platform.claude.com/docs/en/build-with-claude/prompt-caching","https://ai.google.dev/gemini-api/docs/image-understanding"],models});
/** Cache metadata eligibility, reviewed separately from immutable token rates.
 * Official prompt-caching model comparison: pre-5.6 retention has no additional
 * write charge; only the named earlier models support extended 24-hour retention.
 * New GPT-5.6+/GPT-6 cache-write lifetimes require separate financial support.
 */
export const OPENAI_NO_FEE_CACHE_RETENTIONS: Readonly<Record<string, readonly string[]>> = deepFreeze({
  "gpt-4o":["in_memory"],"gpt-4o-mini":["in_memory"],"gpt-4.1":["in_memory","24h"],
  "gpt-5":["in_memory","24h"],"gpt-5-mini":["in_memory"],"gpt-5.4":["in_memory","24h"],
  "gpt-5.4-pro":["in_memory"],"gpt-5.4-pro-2026-03-05":["in_memory"],
  "gpt-5.5-pro":["24h"],"gpt-5.5-pro-2026-04-23":["24h"],"o3-pro":["in_memory"],
});
export type PricingSnapshot = {version:string;verifiedAt?:string;currency:string;unit:string;rateUnit:string;scope:string;sources:string[];models:ModelPrice[]};
export function getModelPrice(provider: AccountingProvider, model: string, snapshot:PricingSnapshot=PRICING_SNAPSHOT): ModelPrice | undefined {
  // Deliberately no suffix stripping, family matching, registry fallback or guessed aliases.
  return snapshot.models.find(row => row.provider === provider && row.model === model);
}
export function selectPriceTier(price: ModelPrice, inputTokens: number): Pick<ModelPrice,"inputNanoUsd"|"outputNanoUsd"|"cachedInputNanoUsd"|"cacheWrite5mNanoUsd"|"cacheWriteNanoUsd"|"cacheWrite12hNanoUsd"> {
  return [...(price.tiers ?? [])].reverse().find(tier => tier.inclusive ? inputTokens >= tier.aboveInputTokens : inputTokens > tier.aboveInputTokens) ?? price;
}
/** Input is the total prompt: uncached + cache reads + verified five-minute writes. */
export function priceTokenUsage(price: ModelPrice, inputTokens: number, outputTokens: number, cachedInputTokens = 0,cacheWriteInputTokens=0,cacheWriteTtl:string="5m"): string {
  for (const count of [inputTokens,outputTokens,cachedInputTokens,cacheWriteInputTokens]) if (!Number.isSafeInteger(count)||count<0) throw new Error("Invalid token usage");
  if (BigInt(cachedInputTokens)+BigInt(cacheWriteInputTokens)>BigInt(inputTokens)) throw new Error("Cache reads and writes exceed total input");
  const tier=selectPriceTier(price,inputTokens);
  if (cachedInputTokens && !tier.cachedInputNanoUsd) throw new Error("Unpriced cache dimension");
  const writeRate=cacheWriteTtl==="5m"?tier.cacheWrite5mNanoUsd:cacheWriteTtl==="30m"?tier.cacheWriteNanoUsd:cacheWriteTtl==="12h"?tier.cacheWrite12hNanoUsd:undefined;
  if(cacheWriteInputTokens&&writeRate===undefined)throw new Error("Unpriced cache-write dimension");
  const nano = (BigInt(inputTokens)-BigInt(cachedInputTokens)-BigInt(cacheWriteInputTokens))*BigInt(tier.inputNanoUsd)+BigInt(cachedInputTokens)*BigInt(tier.cachedInputNanoUsd??0)+BigInt(cacheWriteInputTokens)*BigInt(writeRate??0)+BigInt(outputTokens)*BigInt(tier.outputNanoUsd);
  return ((nano+999n)/1000n).toString();
}

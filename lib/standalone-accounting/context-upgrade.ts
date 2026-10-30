import { getModelPrice, type AccountingProvider, type PricingSnapshot } from './pricing';

/**
 * An over-context request may move only to a newer model of the SAME
 * provider and capability family. In particular, Sonnet never becomes Haiku,
 * GPT never becomes GPT-mini, and Gemini Pro never becomes Flash.
 * All candidates must have an exact reviewed price and a larger context.
 */
function familyVersion(provider: AccountingProvider, model: string): { family: string; major: number; minor: number } | null {
  const id = model.toLowerCase();
  let match: RegExpExecArray | null = null;
  if (provider === 'anthropic') {
    match = /^claude-(sonnet|opus|haiku|fable)-(\d+)(?:-(\d+))?(?:-|$)/.exec(id);
    if (match) return {family: 'claude-'+match[1], major: Number(match[2]), minor: Number(match[3] ?? 0)};
  } else if (provider === 'openai') {
    match = /^gpt-(\d+)(?:\.(\d+))?(-mini|-nano|-pro)?(?:-|$)/.exec(id);
    if (match) return {family: 'gpt'+(match[3] ?? ':standard'), major: Number(match[1]), minor: Number(match[2] ?? 0)};
  } else if (provider === 'google') {
    match = /^gemini-(\d+)\.(\d+)-(pro|flash|flash-lite)(?:-|$)/.exec(id);
    if (match) return {family:'gemini-'+match[3],major:Number(match[1]),minor:Number(match[2])};
  } else if (provider === 'grok') {
    match = /^grok-(\d+)(?:\.(\d+))?(-(?:reasoning|non-reasoning))?(?:-|$)/.exec(id);
    if (match) return {family:'grok'+(match[3]??':standard'),major:Number(match[1]),minor:Number(match[2]??0)};
  }
  return null;
}

export function selectContextCapacityUpgrade(input: {
  provider: AccountingProvider;
  model: string;
  availableModels: readonly string[];
  pricing: PricingSnapshot;
  outputAllowance: number;
  excludedModels?: ReadonlySet<string>;
}): string | null {
  const from = familyVersion(input.provider,input.model);
  const original = getModelPrice(input.provider,input.model,input.pricing);
  if (!from || !original || !Number.isSafeInteger(input.outputAllowance) || input.outputAllowance<=0) return null;
  const candidates=input.availableModels.flatMap(model=>{
    const current=familyVersion(input.provider,model);
    const price=getModelPrice(input.provider,model,input.pricing);
    if(!current||!price||current.family!==from.family||
       (current.major<from.major || current.major===from.major&&current.minor<=from.minor) ||
       price.maxContextTokens<=original.maxContextTokens ||
       price.maxOutputTokens<input.outputAllowance ||
       input.excludedModels?.has(model.toLowerCase()))return [];
    return [{model,current,price}];
  });
  // Best qualifying same-family model first. No forced downgrade or cross-family substitution.
  candidates.sort((a,b)=>b.current.major-a.current.major || b.current.minor-a.current.minor ||
    b.price.maxContextTokens-a.price.maxContextTokens || a.model.localeCompare(b.model));
  return candidates[0]?.model??null;
}

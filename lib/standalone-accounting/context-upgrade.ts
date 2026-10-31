import { getModelPrice, type AccountingProvider, type PricingSnapshot } from './pricing';

/**
 * Admission after a context rejection may promote capability, but never demote
 * it. Only exact, reviewed model identities of the SAME provider and model
 * lineage qualify; cross-provider quality is not objectively comparable.
 */
type Capability = { family: string; major: number; minor: number; tier: number };
function capability(provider: AccountingProvider, model: string): Capability | null {
  const id = model.toLowerCase();
  let match: RegExpExecArray | null = null;
  if (provider === 'anthropic') {
    match = /^claude-(sonnet|opus|haiku|fable)-(\d+)(?:-(\d+))?(?:-|$)/.exec(id);
    if (match) return {
      family: match[1] === 'fable' ? 'claude-fable' : 'claude',
      major: Number(match[2]), minor: Number(match[3] ?? 0),
      tier: ({haiku:1,sonnet:2,opus:3,fable:1} as Record<string,number>)[match[1]],
    };
  } else if (provider === 'openai') {
    match = /^gpt-(\d+)(?:\.(\d+))?(-mini|-nano|-pro)?(?:-|$)/.exec(id);
    if (match) return {
      family:'gpt', major:Number(match[1]), minor:Number(match[2] ?? 0),
      tier: ({'-nano':0,'-mini':1,'':2,'-pro':3} as Record<string,number>)[match[3] ?? ''],
    };
  } else if (provider === 'google') {
    match = /^gemini-(\d+)\.(\d+)-(pro|flash|flash-lite)(?:-|$)/.exec(id);
    if (match) return {
      family:'gemini', major:Number(match[1]), minor:Number(match[2]),
      tier: ({'flash-lite':0,flash:1,pro:2} as Record<string,number>)[match[3]],
    };
  } else if (provider === 'grok') {
    match = /^grok-(\d+)(?:\.(\d+))?(-(reasoning|non-reasoning))?(?:-|$)/.exec(id);
    if (match) return {
      family:'grok'+(match[3]??':standard'),major:Number(match[1]),
      minor:Number(match[2]??0),tier:1,
    };
  }
  return null;
}

/** Require a candidate that fits the unchanged full input and output allowance.
 * An estimate still counts as an estimate: the receiving provider rechecks its
 * exact frozen request before accounting admits any paid generation. */
export function selectContextCapacityUpgrade(input: {
  provider: AccountingProvider;
  model: string;
  availableModels: readonly string[];
  pricing: PricingSnapshot;
  inputTokens: number;
  outputAllowance: number;
  excludedModels?: ReadonlySet<string>;
}): string | null {
  const from=capability(input.provider,input.model);
  const original=getModelPrice(input.provider,input.model,input.pricing);
  if(!from||!original||!Number.isSafeInteger(input.inputTokens)||input.inputTokens<0||
     !Number.isSafeInteger(input.outputAllowance)||input.outputAllowance<=0||
     !Number.isSafeInteger(input.inputTokens+input.outputAllowance))return null;
  const required=input.inputTokens+input.outputAllowance;
  const candidates=input.availableModels.flatMap(model=>{
    const current=capability(input.provider,model);
    const price=getModelPrice(input.provider,model,input.pricing);
    if(!current||!price||current.family!==from.family||
       current.tier<from.tier||
       (current.major<from.major || current.major===from.major&&current.minor<from.minor)||
       (current.tier===from.tier&&current.major===from.major&&current.minor===from.minor)||
       price.maxContextTokens<=original.maxContextTokens||
       price.maxContextTokens<required||
       price.maxOutputTokens<input.outputAllowance||
       price.supportsStreaming===false||
       input.excludedModels?.has(model.toLowerCase()))return [];
    return [{model,current,price}];
  });
  // Prefer a newer same-tier model before escalating to a higher tier.
  // Never select an unreviewed alias, lower capability, or oversized quote.
  candidates.sort((a,b)=>a.current.tier-b.current.tier ||
    b.current.major-a.current.major || b.current.minor-a.current.minor ||
    a.price.maxContextTokens-b.price.maxContextTokens || a.model.localeCompare(b.model));
  return candidates[0]?.model??null;
}

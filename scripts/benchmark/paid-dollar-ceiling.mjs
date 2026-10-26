// Trusted paid-host preflight only. A $10 arm authorization is NOT a token grant.
// Fail closed unless an owner-controlled conservative price ceiling is provided.
export function assertBenchmarkDollarCeiling({armUsdCents,priceCeilingMicrosPerMillion,
  publishedInputUsdPerMillion,publishedOutputUsdPerMillion,accountTokens,approvalTokens}){
 if(armUsdCents!==1000)throw Error('BENCHMARK_USD_AUTHORIZATION_MISMATCH');
 if(!Number.isSafeInteger(priceCeilingMicrosPerMillion)||priceCeilingMicrosPerMillion<=0)
  throw Error('BENCHMARK_PRICE_CEILING_UNVERIFIED');
 const rates=[publishedInputUsdPerMillion,publishedOutputUsdPerMillion];
 if(rates.some(v=>v==null||String(v).trim()===''||!Number.isFinite(Number(v))||Number(v)<=0))
  throw Error('BENCHMARK_MODEL_PRICING_UNAVAILABLE');
 if(Math.max(...rates.map(v=>Number(v)*1_000_000))>priceCeilingMicrosPerMillion)
  throw Error('BENCHMARK_APPROVED_RATE_TOO_LOW');
 // Any token may be billed at the highest validated rate. This forfeits
 // cheaper input-token headroom in exchange for conservative total-cost safety.
 const maxTokens=Number((BigInt(armUsdCents)*10_000n*1_000_000n)/BigInt(priceCeilingMicrosPerMillion));
 if(!Number.isSafeInteger(maxTokens)||maxTokens<=0||
    !Number.isSafeInteger(accountTokens)||accountTokens<=0||accountTokens>maxTokens||
    !Number.isSafeInteger(approvalTokens)||approvalTokens<=0||approvalTokens>maxTokens)
  throw Error('BENCHMARK_USD_TOKEN_CEILING_EXCEEDED');
 return Object.freeze({maxTokens,armUsdCents});
}

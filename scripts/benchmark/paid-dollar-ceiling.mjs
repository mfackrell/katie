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

// Read-only pre-grant probe. Never retry grant issuance or provider traffic.
// Only fixed diagnostics leave this boundary; transport messages may contain
// URLs, headers or credentials and must not be logged or attached as causes.
const transientPricingStatuses=new Set([408,429,500,502,503,504,522,524]);
const transientPricingCodes=new Set(['08000','08001','08003','08004','08006','53300','57P01','57P02','57P03','PGRST000','PGRST001','PGRST002','PGRST003']);
export async function readVerifiedBenchmarkPricing(read,{sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 for(let attempt=1;attempt<=3;attempt++){
  let result;
  try{result=await read(AbortSignal.timeout(5000));}
  catch(error){
   const transport=error?.name==='AbortError'||error?.name==='TimeoutError'||
    (error instanceof TypeError&&error.message==='fetch failed');
   result={error,status:transport?0:undefined};
  }
  const {data,error,status}=result??{};
  if(error||!result||Number(status)>=400){
   const transient=status===0||transientPricingStatuses.has(status)||transientPricingCodes.has(error?.code);
   if(transient&&attempt<3){await sleep(attempt===1?250:750);continue;}
   throw Error('NATIVE_HOST_DENIED: model price evidence read '+(transient?'unavailable':'failed')+' (attempts='+attempt+')');
  }
  if(!data)throw Error('NATIVE_HOST_DENIED: model price evidence record missing');
  if(data.pricing_status!=='verified')throw Error('NATIVE_HOST_DENIED: model price evidence not verified');
  return data;
 }
}

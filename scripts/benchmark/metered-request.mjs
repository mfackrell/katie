// Common per-request metering boundary for both benchmark execution engines.
// An engine must pass its own durable atomic reserve/finalize functions, not
// merely assert that it has enforced a cap. No inference is permitted without
// an accepted reservation. Unknown provider usage remains reserved.
export async function meteredRequest({reserve,finalize,invoke,requestId,model,maxInputTokens,maxOutputTokens}) {
 if(typeof reserve!=='function'||typeof finalize!=='function'||typeof invoke!=='function')
  throw Error('BENCHMARK_METERING_UNAVAILABLE');
 if(typeof requestId!=='string'||!requestId||typeof model!=='string'||!model)
  throw Error('BENCHMARK_INVALID_CALL');
 if(!Number.isSafeInteger(maxInputTokens)||maxInputTokens<1||
    !Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1)
  throw Error('BENCHMARK_INVALID_LIMITS');
 const upper=maxInputTokens+maxOutputTokens;
 if(!Number.isSafeInteger(upper))throw Error('BENCHMARK_INVALID_LIMITS');
 const reservation=await reserve({requestId,model,upperTokens:upper});
 if(!reservation || reservation.accepted!==true || !reservation.id)
  throw Error('BENCHMARK_BUDGET_EXHAUSTED');
 try {
  const response=await invoke({model,maxOutputTokens,reservationId:reservation.id});
  const u=response?.usage;
  const inputTokens=u?.inputTokens;
  const outputTokens=u?.outputTokens;
  if(!Number.isSafeInteger(inputTokens)||inputTokens<0||
     !Number.isSafeInteger(outputTokens)||outputTokens<0||
     inputTokens+outputTokens>upper)
   throw Error('BENCHMARK_PROVIDER_USAGE_UNVERIFIED');
  const result=await finalize({reservationId:reservation.id,requestId,usage:{inputTokens,outputTokens},status:'completed'});
  if(result?.committed!==true)throw Error('BENCHMARK_ACCOUNTING_COMMIT_FAILED');
  return response;
 } catch(error) {
  // A network failure is NOT proof no tokens were consumed. Keep the
  // reservation until provider usage can be reconciled by request ID.
  await finalize({reservationId:reservation.id,requestId,usage:null,status:'unresolved'})
   .catch(()=>{});
  throw error;
 }
}

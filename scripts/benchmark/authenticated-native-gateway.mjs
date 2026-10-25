import {createHash,randomUUID} from 'node:crypto';

// Trusted gateway process only. Never supply its service-role DB client,
// provider credentials, or bearer grant to the native agent's shell environment.
export const tokenDigest=token=>{
 if(typeof token!=='string'||token.length<32)throw Error('GATEWAY_TOKEN_INVALID');
 return createHash('sha256').update(token).digest('hex');
};
export async function forwardAuthorizedModelRequest({
 db,grantToken,trialId,executionEpoch,model,requestBody,
 upperTokens,upstream,providerNamespace,recordReceipt,fullMission=false
}){
 if(!db||typeof db.rpc!=='function'||typeof upstream!=='function'||
    typeof recordReceipt!=='function'||!trialId||!providerNamespace||
    !Number.isSafeInteger(upperTokens)||upperTokens<=0||
    !Number.isSafeInteger(executionEpoch)||executionEpoch<=0)
  throw Error('GATEWAY_CONFIGURATION_INVALID');
 // Every actual attempt has its own operation identity. No SDK turn-level
 // accounting and no "attested=true" substitute for DB reservation.
 const live=await db.rpc('benchmark_gateway_execution_live',{
  p_digest:tokenDigest(grantToken),p_trial:trialId,p_epoch:executionEpoch
 });
 if(live.error||live.data!==true)throw Error('GATEWAY_EXECUTION_STOPPED');
 const key=randomUUID();
 const {data:id,error}=await db.rpc(fullMission?'benchmark_full_native_reserve':'benchmark_grant_reserve',{
  p_digest:tokenDigest(grantToken),p_trial:trialId,p_epoch:executionEpoch,
  p_request_key:key,p_model:model,p_tokens:upperTokens
 });
 if(error||typeof id!=='string'||!id)throw Error('GATEWAY_ADMISSION_DENIED');
 try {
  const response=await upstream(requestBody);
  if(typeof response?.providerRequestId!=='string'||
     !Number.isSafeInteger(response?.actualTokens)||response.actualTokens<0)
   throw Error('GATEWAY_PROVIDER_RECEIPT_UNKNOWN');
  await recordReceipt({requestKey:key,operationId:id,namespace:providerNamespace,
   providerRequestId:response.providerRequestId,actualTokens:response.actualTokens});
  return response;
 } catch(error){
  // A request may have reached its provider. Never release the hold as zero
  // without authoritative evidence of zero consumption.
  throw Object.assign(new Error('GATEWAY_UPSTREAM_UNCERTAIN'),{cause:error,operationId:id});
 }
}

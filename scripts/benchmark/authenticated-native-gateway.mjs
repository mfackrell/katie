import {admitNativeRequest,nativeAdmissionError} from './native-request-admission.mjs';
import {createHash,randomUUID} from 'node:crypto';

// Trusted gateway process only. Never supply its service-role DB client,
// provider credentials, or bearer grant to the native agent's shell environment.
export const tokenDigest=token=>{
 if(typeof token!=='string'||token.length<32)throw Error('GATEWAY_TOKEN_INVALID');
 return createHash('sha256').update(token).digest('hex');
};
export async function forwardAuthorizedModelRequest({
 db,grantToken,trialId,executionEpoch,model,requestBody,
 upperTokens,upstream,providerNamespace,recordReceipt,fullMission=false,reasoningProvenance,requireInputCount=false,developerProjectId=null
}){
 if(!db||typeof db.rpc!=='function'||typeof upstream!=='function'||
    typeof recordReceipt!=='function'||(!trialId&&!developerProjectId)||(trialId&&developerProjectId)||!providerNamespace||
    !Number.isSafeInteger(upperTokens)||upperTokens<=0||
    !Number.isSafeInteger(executionEpoch)||executionEpoch<=0)
  throw Error('GATEWAY_CONFIGURATION_INVALID');
 // Every actual attempt has its own operation identity. No SDK turn-level
 // accounting and no "attested=true" substitute for DB reservation.
 const live=await db.rpc(developerProjectId?'developer_gateway_execution_live':'benchmark_gateway_execution_live',{
  p_digest:tokenDigest(grantToken),...(developerProjectId?{p_project:developerProjectId}:{p_trial:trialId}),p_epoch:executionEpoch
 });
 if(live.error||live.data!==true)throw Error('GATEWAY_EXECUTION_STOPPED');
 // Admission must cover the actual request, not an unrelated fixed allowance.
 // Conservatively bound text input by its UTF-8 byte count (a token cannot
 // span fewer than one byte), plus output and a protocol safety margin.
 // Nontext inputs require a separate verified tokenizer/cost bound.
 const containsNontext=value=>{
  if(!value||typeof value!=='object')return false;
  if(Array.isArray(value))return value.some(containsNontext);
  if(['input_image','input_audio','input_video','image_url','file_id'].includes(value.type))return true;
  return Object.entries(value).some(([key,child])=>
   ['image_url','input_audio','input_image','audio','file_id'].includes(key)||containsNontext(child));
 };
 const syntheticFixture=upstream.nonbillableFixture===true;
 if(!requestBody||typeof requestBody!=='object'||Array.isArray(requestBody)||(!syntheticFixture&&containsNontext(requestBody.input)))
  throw nativeAdmissionError(!requestBody||typeof requestBody!=='object'||Array.isArray(requestBody)?'request-object':'nontext-input',requestBody);
 const outputCap=requestBody.max_output_tokens==null?4096:requestBody.max_output_tokens;
 if(!syntheticFixture&&(!Number.isSafeInteger(outputCap)||outputCap<1||outputCap>upperTokens))
  throw Error('GATEWAY_OUTPUT_LIMIT_DENIED');
 const candidate={...requestBody,max_output_tokens:outputCap};
 const admission=syntheticFixture?{body:candidate}:admitNativeRequest(candidate,reasoningProvenance);
 // Freeze a detached payload: count and inference use exactly this context,
 // even if the caller mutates its input while the count is pending.
 const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
 const boundedBody=freeze(JSON.parse(JSON.stringify(admission.body)));
 if(Buffer.byteLength(JSON.stringify(boundedBody),'utf8')>2_000_000)throw Error('GATEWAY_REQUEST_EXCEEDS_GRANT');
 let admissionTokens=syntheticFixture?upperTokens:admission.plaintextBytes+admission.opaqueTokens+outputCap+1024;
 if(requireInputCount&&typeof upstream.countInputTokens!=='function')throw Error('GATEWAY_INPUT_COUNT_UNAVAILABLE');
 if(!syntheticFixture&&typeof upstream.countInputTokens==='function'){
  const counted=await upstream.countInputTokens(boundedBody);
  const requestHash=createHash('sha256').update(JSON.stringify(boundedBody)).digest('hex');
  if(counted?.requestHash!==requestHash)throw Error('GATEWAY_INPUT_COUNT_INVALID');
  const inputTokens=counted.inputTokens;
  if(!Number.isSafeInteger(inputTokens)||inputTokens<0||inputTokens>120000)throw Error('GATEWAY_INPUT_COUNT_INVALID');
  // Retain opaque provenance as conservative extra headroom even though the
  // provider count includes request formatting and reasoning context.
  admissionTokens=inputTokens+admission.opaqueTokens+outputCap+1024;
  if(process.env.KATIE_BENCHMARK_GATEWAY_DIAGNOSTICS==='enabled')console.log('NATIVE_GATEWAY_INPUT_COUNT',JSON.stringify({inputTokens,opaqueHeadroom:admission.opaqueTokens,outputCap,protocolHeadroom:1024,reservationTokens:admissionTokens,requestHash}));
 }
 if(!Number.isSafeInteger(admissionTokens)||admissionTokens>upperTokens)
  throw Error('GATEWAY_REQUEST_EXCEEDS_GRANT');
 const key=randomUUID();
 const {data:id,error}=await db.rpc(developerProjectId?'developer_native_reserve':fullMission?'benchmark_full_native_reserve':'benchmark_grant_reserve',{
  p_digest:tokenDigest(grantToken),...(developerProjectId?{p_project:developerProjectId}:{p_trial:trialId}),p_epoch:executionEpoch,
  p_request_key:key,p_model:model,p_tokens:admissionTokens
 });
 if(error||typeof id!=='string'||!id)throw Error('GATEWAY_ADMISSION_DENIED');
 try {
  const response=await upstream(boundedBody);
  if(typeof response?.providerRequestId!=='string'||
     !Number.isSafeInteger(response?.actualTokens)||response.actualTokens<0)
   throw Error('GATEWAY_PROVIDER_RECEIPT_UNKNOWN');
  await recordReceipt({requestKey:key,operationId:id,namespace:providerNamespace,
   providerRequestId:response.providerRequestId,actualTokens:response.actualTokens,usage:response.usage});
  if(!syntheticFixture)reasoningProvenance?.remember(response,model,outputCap);
  return response;
 } catch(error){
  // A request may have reached its provider. Never release the hold as zero
  // without authoritative evidence of zero consumption.
  throw Object.assign(new Error('GATEWAY_UPSTREAM_UNCERTAIN'),{cause:error,operationId:id});
 }
}



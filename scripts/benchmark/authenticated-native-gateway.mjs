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
 // Provider-side references can expand to unbounded billable context. Allow only
 // explicitly bounded, inline text request shapes on the paid boundary.
 const assertPaidRequestShape=body=>{
  const keys=new Set(['model','input','instructions','max_output_tokens','stream','tools','tool_choice','parallel_tool_calls','reasoning','text','temperature','top_p','store','include','metadata','truncation']);
  for(const key of Object.keys(body))if(!keys.has(key))throw Error('GATEWAY_UNBOUNDED_INPUT_DENIED');
  if(body.input!==undefined&&typeof body.input!=='string'&&!Array.isArray(body.input))throw Error('GATEWAY_UNBOUNDED_INPUT_DENIED');
  const parts=Array.isArray(body.input)?body.input:[];
  for(const item of parts){
   if(!item||typeof item!=='object'||!['user','assistant','developer','system','tool'].includes(item.role)||!Array.isArray(item.content))
    throw Error('GATEWAY_UNBOUNDED_INPUT_DENIED');
   for(const part of item.content){
    if(!part||!['input_text','output_text','text'].includes(part.type)||typeof part.text!=='string')
     throw Error('GATEWAY_UNBOUNDED_INPUT_DENIED');
   }
  }
  if(body.store===true||body.truncation==='auto'||body.include?.length)
   throw Error('GATEWAY_UNBOUNDED_INPUT_DENIED');
 };
 const syntheticFixture=upstream.nonbillableFixture===true;
 if(!requestBody||typeof requestBody!=='object'||Array.isArray(requestBody)||(!syntheticFixture&&containsNontext(requestBody)))
  throw Error('GATEWAY_UNBOUNDED_INPUT_DENIED');
 if(!syntheticFixture)assertPaidRequestShape(requestBody);
 const outputCap=requestBody.max_output_tokens==null?4096:requestBody.max_output_tokens;
 if(!syntheticFixture&&(!Number.isSafeInteger(outputCap)||outputCap<1||outputCap>upperTokens))
  throw Error('GATEWAY_OUTPUT_LIMIT_DENIED');
 const boundedBody={...requestBody,max_output_tokens:outputCap};
 const inputBytes=Buffer.byteLength(JSON.stringify(boundedBody),'utf8');
 const admissionTokens=syntheticFixture?upperTokens:inputBytes+outputCap+1024;
 if(!Number.isSafeInteger(admissionTokens)||admissionTokens>upperTokens)
  throw Error('GATEWAY_REQUEST_EXCEEDS_GRANT');
 const key=randomUUID();
 const {data:id,error}=await db.rpc(fullMission?'benchmark_full_native_reserve':'benchmark_grant_reserve',{
  p_digest:tokenDigest(grantToken),p_trial:trialId,p_epoch:executionEpoch,
  p_request_key:key,p_model:model,p_tokens:admissionTokens
 });
 if(error||typeof id!=='string'||!id)throw Error('GATEWAY_ADMISSION_DENIED');
 try {
  const response=await upstream(boundedBody);
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

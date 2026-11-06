// Trusted host only. The Codex child never receives this provider credential.
// Buffer one bounded Responses event stream until a terminal receipt exists;
// unknown/partial responses keep their reservation for later reconciliation.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
export const NATIVE_MONETARY_CONTROL_VERSION='atomic-exposure-v1';
export const NATIVE_INPUT_COUNT_VERSION='provider-input-count-v1';
export function createResponsesProvider({apiKey,fetchImpl=fetch,baseUrl='https://api.openai.com'}){
 if(typeof apiKey!=='string'||apiKey.length<20)throw Error('GATEWAY_PROVIDER_KEY_REQUIRED');
 const target=new URL('/v1/responses',baseUrl);
 if(target.origin!=='https://api.openai.com'||target.username||target.password)
   throw Error('GATEWAY_UNAPPROVED_PROVIDER_ORIGIN');
 const provider=async body=>{
  if(body.service_tier!==undefined&&body.service_tier!=='default')throw Error('GATEWAY_SERVICE_TIER_DENIED');
  body={...body,service_tier:'default'};
  const resp=await fetchImpl(target,{
   method:'POST',redirect:'error',
   headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},
   body:JSON.stringify(body),signal:AbortSignal.timeout(120000)
  });
  if(!resp.ok)throw Error('GATEWAY_PROVIDER_HTTP_'+resp.status);
  const raw=await resp.text();
  if(raw.length>16_000_000)throw Error('GATEWAY_RESPONSE_TOO_LARGE');
  const frames=raw.split(/\n\n/);
  let terminal=null;
  if((resp.headers.get('content-type')||'').includes('application/json')){
   let parsed;try{parsed=JSON.parse(raw)}catch{throw Error('GATEWAY_AUTHORITATIVE_RECEIPT_MISSING')}
   if(['completed','incomplete'].includes(parsed?.status))terminal=parsed;
  }
  for(const frame of frames){
   const event=frame.split(/\r?\n/).find(line=>line.startsWith('data: '));
   if(!event||event==='data: [DONE]')continue;
   let parsed;try{parsed=JSON.parse(event.slice(6));}catch{continue;}
   if(['response.completed','response.incomplete'].includes(parsed?.type))terminal=parsed.response;
  }
  // Never synthesize token counts or a provider request id.
  if(!terminal||typeof terminal.id!=='string'||
   !Number.isSafeInteger(terminal.usage?.total_tokens)||terminal.usage.total_tokens<0)
   throw Error('GATEWAY_AUTHORITATIVE_RECEIPT_MISSING');
  if(terminal.service_tier!=='default')throw Error('GATEWAY_PROVIDER_TIER_UNCERTAIN');
  return {providerRequestId:terminal.id,actualTokens:terminal.usage.total_tokens,
   usage:terminal.usage,body:raw,contentType:resp.headers.get('content-type')||'text/event-stream'};
 };
 provider.countInputTokens=async body=>{
  const requestHash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  // Context-bearing parameters from the provider's InputTokenCountParams.
  // Generation controls (stream/output cap/sampling/store/include/metadata)
  // are not count parameters and do not add input context.
  const fields=['model','input','instructions','tools','tool_choice','parallel_tool_calls','reasoning','text','truncation'];
  const payload=Object.fromEntries(fields.filter(key=>body[key]!==undefined).map(key=>[key,body[key]]));
  let response;
  try{response=await fetchImpl(new URL('/v1/responses/input_tokens',target),{
   method:'POST',redirect:'error',headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},
   body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)
  });}catch{throw Error('GATEWAY_INPUT_COUNT_UNAVAILABLE');}
  if(!response.ok)throw Error('GATEWAY_INPUT_COUNT_UNAVAILABLE');
  let result;
  try{
   const raw=await response.text();
   if(raw.length>4096)throw Error();
   result=JSON.parse(raw);
  }catch{throw Error('GATEWAY_INPUT_COUNT_INVALID');}
  if(result?.object!=='response.input_tokens'||!Number.isSafeInteger(result.input_tokens)||result.input_tokens<0||result.input_tokens>120000)
   throw Error('GATEWAY_INPUT_COUNT_INVALID');
  return {inputTokens:result.input_tokens,requestHash};
 };
 return provider;
}
export function createCanonicalReceiptWriter(db){
 if(!db||typeof db.rpc!=='function')throw Error('GATEWAY_RECEIPT_DB_REQUIRED');
 return async ({operationId,namespace,providerRequestId,actualTokens,usage})=>{
  const result=namespace==='openai-responses'
   ?await db.rpc('benchmark_reconcile_provider_usage',{p_call:operationId,p_provider_request:providerRequestId,p_usage:usage,p_linked:false})
   :await db.rpc('benchmark_reconcile_receipt',{
   p_call:operationId,p_namespace:namespace,
   p_provider_request:providerRequestId,p_actual:actualTokens
  });
  if(result.error||!['settled','overrun'].includes(result.data))
   throw Error('GATEWAY_LEDGER_RECEIPT_REJECTED');
  return result.data;
 };
}




// Trusted Task 4A native host ONLY. The Codex child does not receive the
// GitHub Actions OPENAI_API_KEY or this binding key. No model inference here.

export const TASK4A_MODEL='gpt-5.3-codex';
export const TASK4A_MODEL_LOOKUP_URL='https://api.openai.com/v1/models/gpt-5.3-codex';
export const TASK4A_MODEL_ELIGIBILITY_VERSION='task4a-native-model-lookup-v1';
export const TASK4A_ELIGIBILITY_MAX_AGE_MS=15*60*1000;
const sha=/^[a-f0-9]{40}$/;
const digest=/^[a-f0-9]{64}$/;
const deny=()=>{throw Error('TASK4A_MODEL_ELIGIBILITY_UNVERIFIED')};

export function nativeCredentialBinding({apiKey,signingKey}){
 if(typeof apiKey!=='string'||apiKey.length<20||typeof signingKey!=='string'||signingKey.length<32)deny();
 // The existing Responses client forwards only Authorization. Do not assert an
 // organization/project header identity it did not actually send.
 return createHmac('sha256',signingKey)
  .update('katie:task4a:native-openai-key-default:v1\0','utf8')
  .update(apiKey,'utf8').digest('hex');
}

export async function retrieveNativeModelNonbillable({
 apiKey,signingKey,fetchImpl=fetch,now=Date.now()
}){
 const credentialBinding=nativeCredentialBinding({apiKey,signingKey});
 if(!Number.isSafeInteger(now)||now<0)deny();
 let result;
 try{
  result=await fetchImpl(TASK4A_MODEL_LOOKUP_URL,{
   method:'GET',redirect:'error',
   headers:{Authorization:'Bearer '+apiKey,Accept:'application/json'},
   signal:AbortSignal.timeout(10000)
  });
 }catch{deny()}
 if(result.status!==200||!String(result.headers?.get('content-type')??'').toLowerCase().includes('application/json'))deny();
 let parsed;
 try{
  const raw=await result.text();
  if(raw.length>4096)deny();
  parsed=JSON.parse(raw);
 }catch{deny()}
 if(!parsed||parsed.object!=='model'||parsed.id!==TASK4A_MODEL||
    typeof parsed.owned_by!=='string'||!parsed.owned_by||
    (parsed.shutdown_date!==null&&parsed.shutdown_date!==undefined&&
      (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.shutdown_date)||
       Date.parse(parsed.shutdown_date+'T23:59:59Z')<=now)))deny();
 // A 200 proves model visibility to this exact credential on this endpoint,
 // NOT Responses-create authorization. Keep that limitation explicit.
 return Object.freeze({
  version:TASK4A_MODEL_ELIGIBILITY_VERSION,
  source:'openai.models.retrieve',
  method:'GET',endpoint:TASK4A_MODEL_LOOKUP_URL,
  model:TASK4A_MODEL,responseObject:'model',httpStatus:200,
  credentialSource:'github-actions:OPENAI_API_KEY',
  organizationContext:'key-default',projectContext:'key-default',
  credentialBinding,observedAt:new Date(now).toISOString(),
  expiresAt:new Date(now+TASK4A_ELIGIBILITY_MAX_AGE_MS).toISOString(),
  proofLevel:'credential_scoped_model_visibility_not_responses_create'
 });
}

export function assertNativeModelEligibility({
 evidence,registry,releaseSha,apiKey,signingKey,now=Date.now()
}){
 const expected=nativeCredentialBinding({apiKey,signingKey});
 const observed=Date.parse(evidence?.observedAt??''),expires=Date.parse(evidence?.expiresAt??'');
 const capabilityAt=Date.parse(registry?.capability_verified_at??'');
 const priceAt=Date.parse(registry?.pricing_verified_at??'');
 if(!sha.test(releaseSha??'')||!digest.test(evidence?.credentialBinding??'')||
    !Number.isSafeInteger(now)||!Number.isFinite(observed)||!Number.isFinite(expires)||
    observed>now||observed<now-TASK4A_ELIGIBILITY_MAX_AGE_MS||
    expires<=now||expires>observed+TASK4A_ELIGIBILITY_MAX_AGE_MS||
    evidence?.version!==TASK4A_MODEL_ELIGIBILITY_VERSION||
    evidence?.source!=='openai.models.retrieve'||evidence?.method!=='GET'||
    evidence?.endpoint!==TASK4A_MODEL_LOOKUP_URL||
    evidence?.model!==TASK4A_MODEL||evidence?.responseObject!=='model'||
    evidence?.httpStatus!==200||
    evidence?.credentialSource!=='github-actions:OPENAI_API_KEY'||
    evidence?.organizationContext!=='key-default'||evidence?.projectContext!=='key-default'||
    evidence?.proofLevel!=='credential_scoped_model_visibility_not_responses_create'||
    evidence?.releaseSha!==releaseSha||
    evidence?.githubRepository!=='mfackrell/katie'||
    evidence?.githubWorkflow!=='.github/workflows/autonomous-development.yml'||
    evidence?.trustedProducer!=='protected-main-read-only-model-lookup'||
    !registry?.source_metadata?.task4a_credential_lookup||
    JSON.stringify(registry.source_metadata.task4a_credential_lookup)!==JSON.stringify(evidence)||
    !timingSafeEqual(Buffer.from(evidence.credentialBinding,'hex'),Buffer.from(expected,'hex'))||
    registry?.provider_name!=='openai'||registry?.model_id!==TASK4A_MODEL||
    registry?.is_active!==true||registry?.capability_status!=='verified'||
    registry?.routing_eligibility!=='verified'||
    !Number.isFinite(capabilityAt)||capabilityAt>now||
    capabilityAt<now-TASK4A_ELIGIBILITY_MAX_AGE_MS||
    registry?.pricing_status!=='verified'||
    !Number.isFinite(priceAt)||priceAt>now||priceAt<now-24*60*60*1000||
    Number(registry?.pricing_input_per_1m)!==1.75||
    Number(registry?.pricing_output_per_1m)!==14||
    registry?.source_metadata?.pricing_verification_source!==
     'https://developers.openai.com/api/docs/models/gpt-5.3-codex')deny();
 return true;
}

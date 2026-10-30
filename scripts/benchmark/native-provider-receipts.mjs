// Trusted host only. The Codex child never receives this provider credential.
// Buffer one bounded Responses event stream until a terminal receipt exists;
// unknown/partial responses keep their reservation for later reconciliation.
export const NATIVE_INPUT_COUNT_VERSION='provider-input-count-v1';
export function createResponsesProvider({apiKey,fetchImpl=fetch,baseUrl='https://api.openai.com'}){
 if(typeof apiKey!=='string'||apiKey.length<20)throw Error('GATEWAY_PROVIDER_KEY_REQUIRED');
 const target=new URL('/v1/responses',baseUrl);
 if(target.origin!=='https://api.openai.com'||target.username||target.password)
   throw Error('GATEWAY_UNAPPROVED_PROVIDER_ORIGIN');
 const provider=async body=>{
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
  return {providerRequestId:terminal.id,actualTokens:terminal.usage.total_tokens,
   usage:terminal.usage,body:raw,contentType:resp.headers.get('content-type')||'text/event-stream'};
 };
 provider.countInputTokens=async body=>{
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
  return result.input_tokens;
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


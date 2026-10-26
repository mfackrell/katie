// Trusted host only. The Codex child never receives this provider credential.
// Buffer one bounded Responses event stream until a terminal receipt exists;
// unknown/partial responses keep their reservation for later reconciliation.
export function createResponsesProvider({apiKey,fetchImpl=fetch,baseUrl='https://api.openai.com'}){
 if(typeof apiKey!=='string'||apiKey.length<20)throw Error('GATEWAY_PROVIDER_KEY_REQUIRED');
 const target=new URL('/v1/responses',baseUrl);
 if(target.protocol!=='https:'||target.hostname!=='api.openai.com')
   throw Error('GATEWAY_UNAPPROVED_PROVIDER_ORIGIN');
 return async body=>{
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
   body:raw,contentType:resp.headers.get('content-type')||'text/event-stream'};
 };
}
export function createCanonicalReceiptWriter(db){
 if(!db||typeof db.rpc!=='function')throw Error('GATEWAY_RECEIPT_DB_REQUIRED');
 return async ({operationId,namespace,providerRequestId,actualTokens})=>{
  const result=await db.rpc('benchmark_reconcile_receipt',{
   p_call:operationId,p_namespace:namespace,
   p_provider_request:providerRequestId,p_actual:actualTokens
  });
  if(result.error||!['settled','overrun'].includes(result.data))
   throw Error('GATEWAY_LEDGER_RECEIPT_REJECTED');
  return result.data;
 };
}

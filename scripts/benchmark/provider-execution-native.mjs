import {createHash,randomUUID} from 'node:crypto';
import {admitNativeRequest} from './native-request-admission.mjs';

export const PROVIDER_EXECUTION_MODEL='gpt-5.3-codex';
const MAX_CONTEXT_TOKENS=120000;
const MAX_OUTPUT_TOKENS=16000;

// A per-request technical bound, independent of usage history or money.
// Authority and deadlines are checked again immediately before contacting the provider.
export function providerExecutionForwarder({assertLive,upstream,begin,resolve,stop,observe=()=>{}}){
 let terminal=false,inFlight=false;
 return async (request,provenance)=>{
  if(terminal||inFlight)throw Error('GATEWAY_EXECUTION_STOPPED');
  inFlight=true;
  let providerAttempt=false;
  try{
   await assertLive();
   if(request.model!==PROVIDER_EXECUTION_MODEL)throw Error('GATEWAY_PROVIDER_MODEL_DENIED');
   const outputCap=request.max_output_tokens??4096;
   if(!Number.isSafeInteger(outputCap)||outputCap<1||outputCap>MAX_OUTPUT_TOKENS)
    throw Error('GATEWAY_OUTPUT_LIMIT_DENIED');
   const {body,opaqueTokens}=admitNativeRequest({...request,max_output_tokens:outputCap},provenance);
   const bodyHash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
   const count={id:randomUUID(),operation:'input-count',hash:bodyHash};
   await begin(count);
   providerAttempt=true;
   const counted=await upstream.countInputTokens(body);
   if(counted?.requestHash!==bodyHash||!Number.isSafeInteger(counted.inputTokens)||counted.inputTokens<0)
    throw Error('GATEWAY_INPUT_COUNT_INVALID');
   await resolve(count,'input-token-count');
   providerAttempt=false;
   if(counted.inputTokens+opaqueTokens+outputCap+1024>MAX_CONTEXT_TOKENS)throw Error('GATEWAY_PROVIDER_CONTEXT_DENIED');
   await assertLive();
   const inference={id:randomUUID(),operation:'inference',hash:createHash('sha256').update(JSON.stringify({...body,service_tier:'default'})).digest('hex')};
   await begin(inference);
   providerAttempt=true;
   const result=await upstream(body);
   try{observe(result);}catch{/* Usage observations cannot block execution. */}
   if(result.refusal)throw Error('GATEWAY_PROVIDER_REFUSED');
   if(typeof result.providerRequestId!=='string'||!result.providerRequestId)throw Error('GATEWAY_AUTHORITATIVE_RECEIPT_MISSING');
   await resolve(inference,result.providerRequestId);
   providerAttempt=false;
   provenance.remember(result,body.model,outputCap);
   return result;
  }catch(error){
   terminal=true;
   if(providerAttempt)await stop(error);
   throw error;
  }finally{inFlight=false;}
 };
}

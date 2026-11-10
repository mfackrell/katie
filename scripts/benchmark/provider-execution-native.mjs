import {createHash} from 'node:crypto';
import {admitNativeRequest} from './native-request-admission.mjs';

export const PROVIDER_EXECUTION_MODEL='gpt-5.3-codex';
const MAX_CONTEXT_TOKENS=120000;
const MAX_OUTPUT_TOKENS=16000;

// A per-request technical bound, independent of usage history or money.
// Authority and deadlines are checked again immediately before contacting the provider.
export function providerExecutionForwarder({assertLive,upstream,stop,observe=()=>{}}){
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
   providerAttempt=true;
   const counted=await upstream.countInputTokens(body);
   providerAttempt=false;
   if(counted?.requestHash!==createHash('sha256').update(JSON.stringify(body)).digest('hex')||
      !Number.isSafeInteger(counted.inputTokens)||counted.inputTokens<0||counted.inputTokens+opaqueTokens+outputCap+1024>MAX_CONTEXT_TOKENS)
    throw Error('GATEWAY_PROVIDER_CONTEXT_DENIED');
   await assertLive();
   providerAttempt=true;
   const result=await upstream(body);
   try{observe(result);}catch{/* Usage observations cannot block execution. */}
   if(result.refusal)throw Error('GATEWAY_PROVIDER_REFUSED');
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

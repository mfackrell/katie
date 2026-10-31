import {createNativeReasoningProvenance,nativeAdmissionDiagnostic} from './native-request-admission.mjs';
import {createServer} from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {forwardAuthorizedModelRequest} from './authenticated-native-gateway.mjs';
import {assertNativeRequestTools} from './shared-native-policy.mjs';

// Fixed classifications only: never pass database messages, request content or
// credentials to the child or a recovery decision. Every bridge failure is fatal
// to automatic phase recovery; an HTTP denial is not a child interruption.
export function nativeGatewayFailureClass(error){
 const code=error?.message;
 if(['GATEWAY_EXECUTION_STOPPED','GATEWAY_TOKEN_INVALID'].includes(code))return 'authorization';
 if(['GATEWAY_ADMISSION_DENIED','GATEWAY_REQUEST_EXCEEDS_GRANT','GATEWAY_OUTPUT_LIMIT_DENIED'].includes(code))return 'admission';
 if(code==='GATEWAY_UNBOUNDED_INPUT_DENIED'||code==='BODY_TOO_LARGE'||error instanceof SyntaxError)return 'request-schema';
 if(code==='GATEWAY_UPSTREAM_UNCERTAIN')return 'upstream-uncertain';
 return 'gateway-failure';
}
export function nativeChildInterruptionRetryable(outcome,gatewayFailure){
 return !gatewayFailure&&outcome?.code===null&&['SIGKILL','SIGHUP'].includes(outcome?.signal);
}

// Runs in the trusted execution host, outside the agent's mount namespace.
// The caller must supply a server-owned grant and DB client. This bridge
// deliberately does not forward model requests unless all dependencies exist.
export function createNativeHttpBridge({db,grantToken,trialId,executionEpoch,
 providerNamespace,upperTokens,upstream,recordReceipt,clientToken,fullMission=false,onFailure=()=>{},requireInputCount=false,beforeRequest=()=>{}}){
 if(!db||!grantToken||!trialId||!upstream||!recordReceipt||
    typeof clientToken!=='string'||clientToken.length<12)
  throw Error('NATIVE_GATEWAY_NOT_CONFIGURED');
 const reasoningProvenance=createNativeReasoningProvenance();
 return createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/v1/responses'){
   res.writeHead(404);res.end();return;
  }
  const provided=req.headers.authorization;
  const expected=Buffer.from(createHash('sha256').update(clientToken).digest());
  const received=typeof provided==='string'&&provided.startsWith('Bearer ')
   ?Buffer.from(createHash('sha256').update(provided.slice(7)).digest()):Buffer.alloc(32);
  if(!timingSafeEqual(expected,received)){
   onFailure('authorization');
   res.writeHead(401,{'cache-control':'no-store'});res.end();return;
  }
  try{
   let raw='';
   for await(const chunk of req){
    raw+=chunk;
    if(raw.length>2_000_000)throw Error('BODY_TOO_LARGE');
   }
   const body=JSON.parse(raw);
   assertNativeRequestTools(body);
   // Preserve completed tool writes BEFORE admission can reject the next call.
   // This callback has no authority to reserve tokens or issue execution grants.
   await beforeRequest();
   const result=await forwardAuthorizedModelRequest({
    db,grantToken,trialId,executionEpoch,model:body.model,
    requestBody:body,upperTokens,upstream,providerNamespace,recordReceipt,reasoningProvenance,
    fullMission:typeof fullMission==='function'?fullMission():fullMission,requireInputCount
   });
   if(!result||typeof result.body!=='string')throw Error('UPSTREAM_RESPONSE_INVALID');
   res.writeHead(200,{'content-type':result.contentType||'application/json',
    'cache-control':'no-store'});
   res.end(result.body);
  }catch(error){
   onFailure(nativeGatewayFailureClass(error));
   if(process.env.KATIE_BENCHMARK_GATEWAY_DIAGNOSTICS==='enabled'){
    const code=String(error?.message||'UNKNOWN');
    if(/^NATIVE_|^GATEWAY_/.test(code))console.error('NATIVE_GATEWAY_DENIAL_CODE',code.slice(0,120));
    const diagnostic=nativeAdmissionDiagnostic(error);
    if(diagnostic)console.error('NATIVE_GATEWAY_ADMISSION_DIAGNOSTIC',JSON.stringify(diagnostic));
   }
   res.writeHead(403,{'content-type':'application/json','cache-control':'no-store'});
   res.end(JSON.stringify({error:{message:'GATEWAY_REQUEST_DENIED'}}));
  }
 });
}

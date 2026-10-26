import {createServer} from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {forwardAuthorizedModelRequest} from './authenticated-native-gateway.mjs';
import {assertNativeRequestTools} from './shared-native-policy.mjs';

// Runs in the trusted execution host, outside the agent's mount namespace.
// The caller must supply a server-owned grant and DB client. This bridge
// deliberately does not forward model requests unless all dependencies exist.
export function createNativeHttpBridge({db,grantToken,trialId,executionEpoch,
 providerNamespace,upperTokens,upstream,recordReceipt,clientToken,fullMission=false}){
 if(!db||!grantToken||!trialId||!upstream||!recordReceipt||
    typeof clientToken!=='string'||clientToken.length<12)
  throw Error('NATIVE_GATEWAY_NOT_CONFIGURED');
 return createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/v1/responses'){
   res.writeHead(404);res.end();return;
  }
  const provided=req.headers.authorization;
  const expected=Buffer.from(createHash('sha256').update(clientToken).digest());
  const received=typeof provided==='string'&&provided.startsWith('Bearer ')
   ?Buffer.from(createHash('sha256').update(provided.slice(7)).digest()):Buffer.alloc(32);
  if(!timingSafeEqual(expected,received)){
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
   const result=await forwardAuthorizedModelRequest({
    db,grantToken,trialId,executionEpoch,model:body.model,
    requestBody:body,upperTokens,upstream,providerNamespace,recordReceipt,
    fullMission:typeof fullMission==='function'?fullMission():fullMission
   });
   if(!result||typeof result.body!=='string')throw Error('UPSTREAM_RESPONSE_INVALID');
   res.writeHead(200,{'content-type':result.contentType||'application/json',
    'cache-control':'no-store'});
   res.end(result.body);
  }catch(error){
   if(process.env.KATIE_BENCHMARK_GATEWAY_DIAGNOSTICS==='enabled'){
    const code=String(error?.message||'UNKNOWN');
    if(/^NATIVE_|^GATEWAY_/.test(code))console.error('NATIVE_GATEWAY_DENIAL_CODE',code.slice(0,120));
   }
   res.writeHead(403,{'content-type':'application/json','cache-control':'no-store'});
   res.end(JSON.stringify({error:{message:'GATEWAY_REQUEST_DENIED'}}));
  }
 });
}

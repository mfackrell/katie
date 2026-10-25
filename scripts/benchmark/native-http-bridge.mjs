import {createServer} from 'node:http';
import {forwardAuthorizedModelRequest} from './authenticated-native-gateway.mjs';

// Runs in the trusted execution host, outside the agent's mount namespace.
// The caller must supply a server-owned grant and DB client. This bridge
// deliberately does not forward model requests unless all dependencies exist.
export function createNativeHttpBridge({db,grantToken,trialId,executionEpoch,
 providerNamespace,upperTokens,upstream,recordReceipt}){
 if(!db||!grantToken||!trialId||!upstream||!recordReceipt)
  throw Error('NATIVE_GATEWAY_NOT_CONFIGURED');
 return createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/v1/responses'){
   res.writeHead(404);res.end();return;
  }
  try{
   let raw='';
   for await(const chunk of req){
    raw+=chunk;
    if(raw.length>2_000_000)throw Error('BODY_TOO_LARGE');
   }
   const body=JSON.parse(raw);
   if(!body||typeof body.model!=='string')throw Error('MODEL_REQUIRED');
   const result=await forwardAuthorizedModelRequest({
    db,grantToken,trialId,executionEpoch,model:body.model,
    requestBody:body,upperTokens,upstream,providerNamespace,recordReceipt
   });
   if(!result||typeof result.body!=='string')throw Error('UPSTREAM_RESPONSE_INVALID');
   res.writeHead(200,{'content-type':result.contentType||'application/json',
    'cache-control':'no-store'});
   res.end(result.body);
  }catch{
   res.writeHead(403,{'content-type':'application/json','cache-control':'no-store'});
   res.end(JSON.stringify({error:{message:'GATEWAY_REQUEST_DENIED'}}));
  }
 });
}

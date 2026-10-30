// Incident-scoped retrieval only: two existing response IDs, never inference POST.
import {pathToFileURL} from 'node:url';
import {nativeSchemaShape} from './native-request-admission.mjs';
const responseIds=Object.freeze(['resp_0276093c7336f150016ae3dabb12cc87d280afefd7a33ff75c','resp_0ed169e3ab288ccb016ae3dac8175487d2a25c1acc41ac9c02']);
export async function retrieveNativeResponseShapes({apiKey,fetchImpl=fetch}){
 if(typeof apiKey!=='string'||apiKey.length<20)return [{outcome:'credential-unavailable'}];
 const results=[];
 for(const [index,id] of responseIds.entries()){
  try{
   const response=await fetchImpl('https://api.openai.com/v1/responses/'+id,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+apiKey},signal:AbortSignal.timeout(10000)});
   if(!response.ok){results.push({sample:index+1,httpStatus:response.status,outcome:response.status===404?'not-retained':'read-failed'});continue;}
   const raw=await response.text();
   if(raw.length>2_000_000){results.push({sample:index+1,outcome:'response-too-large'});continue;}
   const body=JSON.parse(raw);
   results.push({sample:index+1,httpStatus:response.status,outcome:'retrieved',responseState:['completed','incomplete','failed'].includes(body.status)?body.status:'unknown',shape:nativeSchemaShape(body)});
  }catch{results.push({sample:index+1,outcome:'read-unavailable'});}
 }
 return results;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 console.log('NATIVE_EXISTING_RESPONSE_SHAPES='+JSON.stringify(await retrieveNativeResponseShapes({apiKey:process.env.OPENAI_API_KEY})));
}

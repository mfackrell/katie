import {pathToFileURL} from 'node:url';

// Negative access probe only: no IDs, cookies, secrets, private records, or valid chat submission.
// A denied probe is not proof of principal-to-actor authorization or authenticated usability.
export async function checkAnonymousChatAccess(origin, transport=fetch) {
 const url=new URL(origin);
 if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || (url.pathname!=='/' && url.pathname!==''))throw Error('Supply a bare HTTPS origin without credentials.');
 try {
  const result=await transport(new URL('/api/chat',url),{method:'POST',headers:{'content-type':'application/json'},body:'{}',redirect:'manual',signal:AbortSignal.timeout(15000)});
  const location=result.headers.get('location');
  let loginRedirect=false;
  if(location && [302,303,307,308].includes(result.status)){
   const target=new URL(location,url);
   loginRedirect=target.protocol==='https:' && target.hostname==='vercel.com' && target.pathname==='/sso-api';
  }
  return {origin:url.origin,status:result.status,anonymousDenied:[401,403].includes(result.status)||loginRedirect};
 } catch {return {origin:url.origin,status:null,anonymousDenied:false,error:'Access probe unavailable'};}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const origins=process.argv.slice(2);
 if(!origins.length || origins.length>8)throw Error('Supply one to eight known project origins.');
 const results=[];for(const origin of origins)results.push(await checkAnonymousChatAccess(origin));
 console.log(JSON.stringify({checks:results,scope:'Negative unauthenticated probes only; owner access and authorization still require verification'},null,2));
 if(results.some(result=>!result.anonymousDenied))process.exitCode=1;
}

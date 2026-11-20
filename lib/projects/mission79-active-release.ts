// Independently compare the invoking runtime to Katie's current canonical
// production alias. A superseded Vercel deployment may retain VERCEL_ENV and
// its own VERCEL_GIT_COMMIT_SHA; those env vars alone do NOT prove alias control.
// Never query a caller-supplied host. An unreachable alias fails closed.
const ALIAS_VERSION_URL='https://katie-mu.vercel.app/api/version';
function recordCanonicalProbe(reason:string,status?:number){
 // Never log URL query secrets, cookies, authorization or bypass credentials.
 console.info('[Mission79] Canonical release probe',JSON.stringify({
  reason,...(status===undefined?{}:{httpStatus:status})
 }));
}
export async function verifyMission79ActiveProductionSha(
 expectedSha:string,
 fetchVersion:typeof fetch=fetch,
 authenticatedOwnerCookie?:string|null
):Promise<boolean>{
 // The alias must serve this exact Vercel deployment, not merely another
 // deployment with the same commit SHA. Missing deployment identity fails closed.
 const deploymentId=process.env.VERCEL_DEPLOYMENT_ID;
 if(process.env.VERCEL_ENV!=='production'
  ||!/^[a-f0-9]{40}$/.test(expectedSha)
  ||process.env.VERCEL_GIT_COMMIT_SHA!==expectedSha
  ||!deploymentId||!/^dpl_[A-Za-z0-9]+$/.test(deploymentId))return false;
 try{
  // Production can enforce Vercel Authentication on *all* URLs. Server-side
  // calls do not inherit the invoking owner's SSO cookie automatically.
  // Vercel documents forwarding the owner's cookie for same-origin fetches,
  // or a preconfigured, server-only automation bypass for unattended workers.
  // No authentication setting is disabled and neither credential is returned.
  const cronSecret=process.env.CRON_SECRET;
  if(!cronSecret||cronSecret.length<16){
   recordCanonicalProbe('machine_credential_missing');return false;
  }
  const headers:Record<string,string>={
   'Cache-Control':'no-store','Accept':'application/json',
   Authorization:'Bearer '+cronSecret
  };
  const bypass=process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if(bypass)headers['x-vercel-protection-bypass']=bypass;
  else if(authenticatedOwnerCookie)headers.Cookie=authenticatedOwnerCookie;
  const response=await fetchVersion(ALIAS_VERSION_URL+'?mission79_verify='+encodeURIComponent(expectedSha),{
   method:'GET',cache:'no-store',redirect:'error',
   headers,signal:AbortSignal.timeout(5000),
  });
  if(!response.ok){
   recordCanonicalProbe('http_rejected',response.status);return false;
  }
  if(response.url&&new URL(response.url).origin!=='https://katie-mu.vercel.app'){
   recordCanonicalProbe('origin_changed');return false;
  }
  let body:unknown;
  try{body=await response.json();}
  catch{recordCanonicalProbe('invalid_json');return false;}
  if(typeof body!=='object'||body===null||
   !('version' in body)||!('deploymentId' in body)){
   recordCanonicalProbe('invalid_payload');return false;
  }
  if((body as {version:unknown}).version!==expectedSha){
   recordCanonicalProbe('sha_mismatch');return false;
  }
  if((body as {deploymentId:unknown}).deploymentId!==deploymentId){
   recordCanonicalProbe('deployment_mismatch');return false;
  }
  recordCanonicalProbe('verified',response.status);
  return true;
 }catch(error){
  recordCanonicalProbe(error instanceof Error&&
    (error.name==='TimeoutError'||error.name==='AbortError')
      ?'timeout':'network_failure');
  return false;
 }
}

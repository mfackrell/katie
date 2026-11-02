// Owner-bound project spending actions are never authorized by an actor/chat
// identifier, an unauthenticated cookie, or an unverified browser hint.
export async function verifiedProjectOwnerSession(request:Request):Promise<boolean>{
 if(process.env.VERCEL_ENV!=='production'||
    request.headers.get('origin')!==new URL(request.url).origin)return false;
 const bearer=request.headers.get('authorization');
 const endpoint=process.env.NEXT_PUBLIC_SUPABASE_URL;
 const key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
 const ownerId=process.env.KATIE_OWNER_AUTH_USER_ID;
 if(!bearer||!/^Bearer [A-Za-z0-9._~-]+$/.test(bearer)||bearer.length>8192||
    !endpoint||!key||!ownerId)return false;
 try{
  const response=await fetch((endpoint.endsWith('/')?endpoint.slice(0,-1):endpoint)+'/auth/v1/user',{
   headers:{Authorization:bearer,apikey:key},cache:'no-store',redirect:'error',
   signal:AbortSignal.timeout(5000)
  });
  if(!response.ok)return false;
  const identity=await response.json() as {id?:string};
  return identity.id===ownerId;
 }catch{return false;}
}

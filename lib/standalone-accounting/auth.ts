import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';

export const SESSION_ACCESS_COOKIE = 'katie_session_access';
export const SESSION_REFRESH_COOKIE = 'katie_session_refresh';

export class StandaloneAuthorizationError extends Error {
  readonly code = 'standalone_authorization_denied';
  readonly status = 403;
}
export interface VerifiedStandalonePrincipal { id: string; isAnonymous: boolean }

function cookieValue(headers: Pick<Request,'headers'>, name:string):string|null {
  const raw=headers.headers.get('cookie')??'';
  for (const item of raw.split(';')) {
    const pair=item.trim();
    if (pair.startsWith(name+'=')) return pair.slice(name.length+1);
  }
  return null;
}
export function cookieSessionToken(request:Pick<Request,'headers'>):string|null {
  return cookieValue(request,SESSION_ACCESS_COOKIE);
}
export function cookieRefreshToken(request:Pick<Request,'headers'>):string|null {
  return cookieValue(request,SESSION_REFRESH_COOKIE);
}
/** A browser can supply a saved owner Bearer token, or use its automatic
 * HttpOnly session cookie. Both are verified with Supabase Auth, not trusted IDs. */
export async function authenticateStandalonePrincipal(request:Pick<Request,'headers'>):Promise<VerifiedStandalonePrincipal>{
  const denied=()=>new StandaloneAuthorizationError('A valid Katie session is required.');
  const explicit=request.headers.get('authorization');
  const authorization=explicit ?? (cookieSessionToken(request)?'Bearer '+cookieSessionToken(request):null);
  if(!authorization||!/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)||authorization.length>8192) throw denied();
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if(!url||!key)throw denied();
  let response:Response;
  try {
    response=await fetch(url.replace(/\/$/,'')+'/auth/v1/user',{
      headers:{Authorization:authorization,apikey:key},
      signal:AbortSignal.timeout(5000),cache:'no-store',redirect:'error'
    });
  } catch {throw denied();}
  if(!response.ok){await response.body?.cancel();throw denied();}
  const user=await response.json() as {id?:unknown;is_anonymous?:unknown};
  if(typeof user.id!=='string'||!/^[0-9a-f-]{36}$/i.test(user.id))throw denied();
  return {id:user.id,isAnonymous:user.is_anonymous===true};
}
export async function authenticateStandaloneOwner(request:Pick<Request,'headers'>):Promise<string>{
  return (await authenticateStandalonePrincipal(request)).id;
}
export async function authorizeStandaloneCaller(request:Pick<Request,'headers'>,actorId:string,chatId:string):Promise<string>{
  const ownerId=await authenticateStandaloneOwner(request);
  const denied=()=>new StandaloneAuthorizationError('Standalone spending authorization denied. This conversation is not authorized for this session.');
  const binding=await getSupabaseAdminClient().rpc<boolean>('standalone_authorize_scope',{
    p_owner:ownerId,p_actor:actorId,p_chat:chatId
  });
  if(binding.error)throw denied();
  if(binding.data!==true){
    // Recover only a legacy chat with independently verified pre-existing
    // owner+actor+chat authority. An unverified chat is never claimed.
    const principal=await authenticateStandalonePrincipal(request);
    if(principal.isAnonymous || principal.id!==process.env.KATIE_OWNER_AUTH_USER_ID)throw denied();
    const recovered=await getSupabaseAdminClient().rpc<boolean>('standalone_claim_verified_legacy_scope',{
      p_owner:ownerId,p_actor:actorId,p_chat:chatId
    });
    if(recovered.error||recovered.data!==true)throw denied();
  }
  return ownerId;
}


export async function authorizeStandaloneActor(request:Pick<Request,'headers'>,actorId:string):Promise<void>{
  const principal=await authenticateStandalonePrincipal(request);
  if(!principal.isAnonymous && principal.id===process.env.KATIE_OWNER_AUTH_USER_ID)return;
  if(!principal.isAnonymous)throw new StandaloneAuthorizationError('Actor access denied.');
  const {data,error}=await getSupabaseAdminClient().rpc<string>('standalone_guest_workspace',{p_owner:principal.id});
  if(error||data!==actorId)throw new StandaloneAuthorizationError('Actor access denied.');
}

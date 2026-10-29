import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';

export class StandaloneAuthorizationError extends Error {
  readonly code = 'standalone_authorization_denied';
  readonly status = 403;
}

/** Auth server verification is independent of browser-supplied scope IDs. */
export async function authenticateStandaloneOwner(request:Pick<Request,'headers'>):Promise<string>{
  const denied=()=>new StandaloneAuthorizationError('Owner sign-in required for standalone conversations.');
  const authorization = request.headers.get('authorization');
  if (!authorization || !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization) || authorization.length > 8192) throw denied();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw denied();
  const response = await fetch(`${url.replace(/\/$/, '')}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: key },
    signal: AbortSignal.timeout(5000), cache: 'no-store', redirect: 'error',
  });
  if (!response.ok) { await response.body?.cancel(); throw denied(); }
  const user = await response.json() as { id?: unknown };
  if (typeof user.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(user.id)) throw denied();
  return user.id;
}
export async function authorizeStandaloneCaller(request:Pick<Request,'headers'>,actorId:string,chatId:string):Promise<string>{
  const ownerId=await authenticateStandaloneOwner(request);
  const denied=()=>new StandaloneAuthorizationError('This conversation is not authorized for this owner.');
  const binding = await getSupabaseAdminClient().rpc<boolean>('standalone_authorize_scope', {
    p_owner: ownerId, p_actor: actorId, p_chat: chatId,
  });
  if (binding.error || binding.data !== true) throw denied();
  return ownerId;
}

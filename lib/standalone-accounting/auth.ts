import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';

export class StandaloneAuthorizationError extends Error {
  readonly code = 'standalone_authorization_denied';
  readonly status = 403;
}

/** Authenticate the principal independently of the actor/chat supplied by the browser.
 * Bindings are provisioned administratively; ordinary requests cannot enroll themselves. */
export async function authorizeStandaloneCaller(
  request: Pick<Request, 'headers'>, actorId: string, chatId: string,
): Promise<string> {
  const denied = () => new StandaloneAuthorizationError('Standalone spending authorization denied. Sign in with the owner account and provision a saved conversation binding.');
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
  const binding = await getSupabaseAdminClient().rpc<boolean>('standalone_authorize_scope', {
    p_owner: user.id, p_actor: actorId, p_chat: chatId,
  });
  if (binding.error || binding.data !== true) throw denied();
  return user.id;
}

import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';

/** Authenticate against the connected Auth server, never trust decoded JWT claims.
 * Grants are provisioned by an administrator, not by chat or model arguments.
 */
export async function authorizeSelfToolCaller(
  request: Pick<Request, 'headers'>, actorId: string, chatId: string,
): Promise<string> {
  const denied = () => new Error('Self-tool caller authorization denied');
  if (!process.env.KATIE_SELF_ACTOR_ID || actorId !== process.env.KATIE_SELF_ACTOR_ID) throw denied();
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
  const user = await response.json();
  if (typeof user.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(user.id)) throw denied();
  const grant = await getSupabaseAdminClient().from('self_tool_owner_grants')
    .select('owner_id').eq('owner_id', user.id).eq('actor_id', actorId).eq('chat_id', chatId)
    .maybeSingle<{owner_id: string}>();
  if (grant.error || grant.data?.owner_id !== user.id) throw denied();
  return user.id;
}

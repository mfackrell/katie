import { z } from 'zod';
import { authenticateStandalonePrincipal, authorizeStandaloneCaller, StandaloneAuthorizationError } from '@/lib/standalone-accounting/auth';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import { effectiveRoutingMode, type RoutingMode, type RoutingPreferences } from './types';

export const preferenceScopeSchema = z.object({ actorId: z.string().uuid(), chatId: z.string().uuid() }).strict();
export const preferenceWriteSchema = preferenceScopeSchema.extend({
  target: z.enum(['global', 'conversation']),
  mode: z.enum(['best_answer', 'best_value']).nullable(),
}).refine(value => value.target === 'conversation' || value.mode !== null);
export type PreferenceScope = z.infer<typeof preferenceScopeSchema>;

async function authorizedOwner(request: Pick<Request, 'headers'>, scope?: PreferenceScope) {
  const principal = await authenticateStandalonePrincipal(request);
  if (principal.isAnonymous) throw new StandaloneAuthorizationError('Sign in to save routing preferences.');
  if (scope) await authorizeStandaloneCaller(request, scope.actorId, scope.chatId);
  return principal.id;
}
async function read(ownerId: string, scope?: PreferenceScope): Promise<RoutingPreferences> {
  const db = getSupabaseAdminClient();
  const global = await db.from('user_routing_preferences').select('mode').eq('owner_id', ownerId).maybeSingle<{mode: RoutingMode}>();
  if (global.error) throw Error('Preferences unavailable');
  const chat = scope ? await db.from('conversation_routing_preferences').select('mode').eq('owner_id', ownerId).eq('actor_id', scope.actorId).eq('chat_id', scope.chatId).maybeSingle<{mode: RoutingMode | null}>() : null;
  if (chat?.error) throw Error('Preferences unavailable');
  const globalMode = global.data?.mode ?? 'best_value';
  const conversation = chat?.data?.mode ?? null;
  return {global: globalMode, conversation, effective: effectiveRoutingMode(globalMode, conversation)};
}
/** Authenticates and checks actor/chat ownership on every call. Does not authorize spending.
 * Call after normal chat authorization; explicit manual model selection takes precedence.
 * Request routing_mode is a UI hint only: this resolver uses durable server preferences.
 */
export async function resolveRoutingPreferences(request: Pick<Request, 'headers'>, scope?: PreferenceScope): Promise<RoutingPreferences> {
  if (scope) preferenceScopeSchema.parse(scope);
  return read(await authorizedOwner(request, scope), scope);
}
export async function writeRoutingPreference(request: Pick<Request, 'headers'>, input: unknown): Promise<RoutingPreferences> {
  const payload = preferenceWriteSchema.parse(input);
  const scope = {actorId: payload.actorId, chatId: payload.chatId};
  const ownerId = await authorizedOwner(request, scope);
  const conversation = payload.target === 'conversation';
  const result = await getSupabaseAdminClient().from(conversation ? 'conversation_routing_preferences' : 'user_routing_preferences').upsert({
    owner_id: ownerId, ...(conversation ? {actor_id: scope.actorId, chat_id: scope.chatId} : {}), mode: payload.mode,
  }, {onConflict: conversation ? 'owner_id,actor_id,chat_id' : 'owner_id'});
  if (result.error) throw Error('Preference save failed');
  return read(ownerId, scope);
}

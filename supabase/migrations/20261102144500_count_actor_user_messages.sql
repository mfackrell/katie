-- Actor-scoped review cadence counts HUMAN user messages only; assistant
-- responses (including retries) do not accelerate expensive LTM consolidation.
-- Service-role-only RPC; no client-visible data is returned beyond a count.
create or replace function public.count_actor_user_messages(p_actor_id uuid)
returns bigint language sql stable security definer set search_path = public
as $$
  select count(*)::bigint from public.messages
  where actor_id = p_actor_id and role = 'user';
$$;
revoke all on function public.count_actor_user_messages(uuid) from public, anon, authenticated;
grant execute on function public.count_actor_user_messages(uuid) to service_role;

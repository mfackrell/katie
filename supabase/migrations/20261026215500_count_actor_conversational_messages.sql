create or replace function public.count_actor_conversational_messages(p_actor_id uuid)
returns bigint language sql stable security definer set search_path = public
as $$
select count(*)::bigint from public.messages
where actor_id = p_actor_id and role in ('user', 'assistant');
$$;
revoke all on function public.count_actor_conversational_messages(uuid) from public, anon, authenticated;
grant execute on function public.count_actor_conversational_messages(uuid) to service_role;

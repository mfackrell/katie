-- Server-only authorization for durable reaction replies. No browser credentials are
-- stored or impersonated. The original reaction must be claimed under a valid
-- lease, and a single active owner binding must exist for its chat and actor.
create or replace function public.standalone_verified_reaction_reply_owner(
  p_job bigint, p_actor uuid, p_chat uuid, p_request uuid
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_owner uuid; v_count integer;
begin
  if p_job is null or p_actor is null or p_chat is null or p_request is null then
    raise exception 'Reaction reply identity is incomplete';
  end if;
  if not exists (
    select 1 from public.reaction_reply_jobs j
    join public.actor_reaction_events e on e.id=j.event_id
    join public.messages m on m.id=j.message_id
    join public.chats c on c.id=j.chat_id
    where j.id=p_job and j.actor_id=p_actor and j.chat_id=p_chat
      and j.request_id=p_request and j.status='processing'
      and j.lease_until > now() and j.attempts between 1 and 5
      and e.actor_id=j.actor_id and e.chat_id=j.chat_id
      and e.message_id=j.message_id and e.event_type in ('added','removed')
      and m.actor_id=j.actor_id and m.chat_id=j.chat_id and m.role='assistant'
      and c.actor_id=j.actor_id
  ) then
    raise exception 'No active verified reaction reply job';
  end if;
  select min(b.owner_id::text)::uuid, count(*) into v_owner,v_count
  from public.standalone_owner_bindings b
  where b.actor_id=p_actor and b.chat_id=p_chat and b.revoked_at is null;
  if v_count <> 1 or v_owner is null then
    raise exception 'Reaction reply does not have one active owner binding';
  end if;
  return v_owner;
end;
$$;
revoke all on function public.standalone_verified_reaction_reply_owner(bigint,uuid,uuid,uuid)
 from public, anon, authenticated;
grant execute on function public.standalone_verified_reaction_reply_owner(bigint,uuid,uuid,uuid)
 to service_role;

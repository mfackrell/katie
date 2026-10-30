-- Login-free guests receive isolated actors, owner-bound chats, and capped spending.
-- Apply through the existing migrate.yml writer only.
begin;

create table public.standalone_guest_workspaces (
  owner_id uuid primary key references auth.users(id) on delete restrict,
  actor_id uuid not null unique references public.actors(id) on delete restrict,
  created_at timestamptz not null default now()
);
alter table public.standalone_guest_workspaces enable row level security;
revoke all on public.standalone_guest_workspaces from public, anon, authenticated, service_role;

create function public.standalone_guest_workspace(p_owner uuid) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid;
begin
  if p_owner is null or not exists (select 1 from auth.users u where u.id=p_owner and u.is_anonymous is true) then
    raise exception 'STANDALONE_GUEST_IDENTITY_DENIED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('guest-workspace:'||p_owner::text,0));
  select actor_id into v_actor from standalone_guest_workspaces where owner_id=p_owner;
  if found then return v_actor; end if;
  v_actor:=gen_random_uuid();
  insert into actors(id,name,system_prompt,actor_kind,routing_profile,review_mode)
  values(v_actor,'Katie','You are Katie, a helpful, accurate AI assistant. Only use information from this guest workspace. Do not access another owner''s conversations, memories, or documents.','standard','{}'::jsonb,'adaptive');
  insert into standalone_guest_workspaces(owner_id,actor_id) values(p_owner,v_actor);
  insert into standalone_owner_configuration(owner_id,timezone,per_call_limit_microusd,request_limit_microusd)
  values(p_owner,'America/Chicago',500000,2000000)
  on conflict(owner_id) do nothing;
  return v_actor;
end $$;

create function public.standalone_guest_create_conversation(p_owner uuid,p_actor uuid,p_chat uuid,p_title text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c chats;
begin
  if p_chat is null or length(trim(coalesce(p_title,''))) not between 1 and 1000
    or p_actor is distinct from standalone_guest_workspace(p_owner)
  then raise exception 'STANDALONE_GUEST_SCOPE_DENIED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('guest-chat:'||p_chat::text,0));
  select * into c from chats where id=p_chat;
  if found then
    if c.actor_id is distinct from p_actor or not standalone_verify_scope(p_owner,p_actor,p_chat)
    then raise exception 'STANDALONE_GUEST_SCOPE_DENIED'; end if;
    return to_jsonb(c);
  end if;
  if exists(select 1 from standalone_owner_bindings where chat_id=p_chat)
  then raise exception 'STANDALONE_GUEST_SCOPE_DENIED'; end if;
  insert into chats(id,actor_id,title) values(p_chat,p_actor,trim(p_title)) returning * into c;
  perform standalone_bind_scope(p_owner,p_actor,p_chat);
  insert into short_term_memory(actor_id,chat_id,content)
  values(p_actor,p_chat,'{}'::jsonb) on conflict(actor_id,chat_id) do nothing;
  insert into intermediate_memory(actor_id,chat_id,content)
  values(p_actor,p_chat,'{}'::jsonb) on conflict(actor_id,chat_id) do nothing;
  return to_jsonb(c);
end $$;

create function public.standalone_owned_chat_ids(p_owner uuid) returns uuid[]
language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(array_agg(b.chat_id),'{}'::uuid[])
  from standalone_owner_bindings b join chats c on c.id=b.chat_id and c.actor_id=b.actor_id
  where b.owner_id=p_owner and b.revoked_at is null;
$$;

-- Guest limits are HARD caps, not approval thresholds. The usual owner can
-- continue approving over-threshold attempts without these guest restrictions.
create function public.standalone_guest_configuration_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if exists(select 1 from standalone_guest_workspaces where owner_id=new.owner_id)
    and (new.per_call_limit_microusd is distinct from 500000
      or new.request_limit_microusd is distinct from 2000000)
  then raise exception 'STANDALONE_GUEST_CONFIGURATION_LOCKED'; end if;
  return new;
end $$;
create trigger standalone_guest_configuration_guard
before insert or update on standalone_owner_configuration
for each row execute function standalone_guest_configuration_guard();

create function public.standalone_guest_dispatch_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_spent numeric(30,0);v_request numeric(30,0);
begin
  if new.state not in ('dispatched','estimated') or old.state in ('dispatched','estimated')
    or not exists(select 1 from standalone_guest_workspaces where owner_id=new.owner_id)
  then return new;end if;
  -- A globally serialized admission prevents rotating anonymous identities
  -- from evading the site-wide UTC-day cap or racing concurrent dispatches.
  perform pg_advisory_xact_lock(hashtextextended('standalone-guest-spend:'||(now() at time zone 'UTC')::date::text,0));
  if new.dispatched_at is null then new.dispatched_at:=now();end if;
  if new.reserved_microusd > 500000
  then raise exception 'STANDALONE_GUEST_CALL_CAP';end if;
  select coalesce(sum(case when a.state='settled' then a.actual_microusd
                              else a.reserved_microusd end),0)
  into v_request from standalone_provider_attempts a
  where a.owner_id=new.owner_id and a.request_id=new.request_id
    and a.id<>new.id and a.state in ('dispatched','estimated','uncertain','settled');
  if v_request+new.reserved_microusd>2000000
  then raise exception 'STANDALONE_GUEST_REQUEST_CAP';end if;
  select coalesce(sum(case when a.state='settled' then a.actual_microusd
                              else a.reserved_microusd end),0)
  into v_spent from standalone_provider_attempts a
    join standalone_guest_workspaces g on g.owner_id=a.owner_id
  where a.state in ('dispatched','estimated','uncertain','settled')
    and a.dispatched_at >= ((now() at time zone 'UTC')::date::timestamp at time zone 'UTC')
    and a.dispatched_at < (((now() at time zone 'UTC')::date+1)::timestamp at time zone 'UTC');
  if v_spent+new.reserved_microusd>2000000
  then raise exception 'STANDALONE_GUEST_DAILY_CAP';end if;
  return new;
end $$;
create trigger standalone_guest_dispatch_guard
before update of state on standalone_provider_attempts
for each row execute function standalone_guest_dispatch_guard();

revoke all on function standalone_guest_workspace(uuid),
  standalone_guest_create_conversation(uuid,uuid,uuid,text),
  standalone_owned_chat_ids(uuid) from public,anon,authenticated;
grant execute on function standalone_guest_workspace(uuid),
  standalone_guest_create_conversation(uuid,uuid,uuid,text),
  standalone_owned_chat_ids(uuid) to service_role;

-- Legacy migration requires a verified, historic exact-scope self-tool grant.
-- Never let a browser-supplied chat ID bootstrap historical ownership.
create function public.standalone_claim_verified_legacy_scope(p_owner uuid,p_actor uuid,p_chat uuid) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from self_tool_owner_grants g join chats c
    on c.id=g.chat_id and c.actor_id=g.actor_id
    where g.owner_id=p_owner and g.actor_id=p_actor and g.chat_id=p_chat
      and c.created_at < '2026-10-29 00:00:00+00'::timestamptz)
  then return false;end if;
  if exists(select 1 from standalone_owner_bindings where chat_id=p_chat
    and (owner_id<>p_owner or actor_id<>p_actor or revoked_at is not null))
  then return false;end if;
  perform standalone_bind_scope(p_owner,p_actor,p_chat);
  return standalone_verify_scope(p_owner,p_actor,p_chat);
end $$;
revoke all on function standalone_claim_verified_legacy_scope(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function standalone_claim_verified_legacy_scope(uuid,uuid,uuid) to service_role;


commit;

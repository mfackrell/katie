-- Applied to production as Supabase migration 20261030202847.
-- Verified single-tenant owner may open fresh chats with other unmanaged,
-- non-guest standard actors. Existing/revoked conversation binding protections
-- and guest enrollment remain unchanged.
CREATE OR REPLACE FUNCTION public.standalone_create_conversation(p_owner uuid, p_actor uuid, p_chat uuid, p_title text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare c chats;
begin
  if p_owner is null or p_chat is null or length(trim(p_title)) not between 1 and 1000
  then raise exception 'STANDALONE_SCOPE_INVALID'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_chat::text,0));
  perform 1 from actors a where a.id=p_actor
    and coalesce(a.actor_kind,'standard')='standard'
    and not exists(select 1 from managed_agents m where m.actor_id=a.id)
    for key share of a;
  if not found then raise exception 'STANDALONE_SCOPE_INVALID'; end if;

  -- Preserve the original independently verified same-actor grant path.
  perform 1 from self_tool_owner_grants g join chats access_chat
    on access_chat.id=g.chat_id and access_chat.actor_id=g.actor_id
    where g.owner_id=p_owner and g.actor_id=p_actor
    for key share of g,access_chat;
  if not found then
    -- The sole permanent owner may use other pre-existing standard actors
    -- only if a live historical scope independently establishes the owner.
    -- A guest-owned actor, managed actor, or revoked anchor is never eligible.
    perform 1
      from auth.users u
      join self_tool_owner_grants g on g.owner_id=u.id
      join chats anchor_chat on anchor_chat.id=g.chat_id and anchor_chat.actor_id=g.actor_id
      join actors anchor_actor on anchor_actor.id=g.actor_id
      join standalone_owner_bindings anchor_scope on
        anchor_scope.owner_id=g.owner_id and anchor_scope.actor_id=g.actor_id
        and anchor_scope.chat_id=g.chat_id and anchor_scope.revoked_at is null
      where u.id=p_owner
        and u.is_anonymous is false
        and (select count(*) from auth.users where is_anonymous is false)=1
        and coalesce(anchor_actor.actor_kind,'standard')='standard'
        and not exists(select 1 from managed_agents m where m.actor_id=anchor_actor.id)
        and not exists(select 1 from standalone_guest_workspaces w where w.actor_id=p_actor)
      for key share of u,g,anchor_chat,anchor_actor,anchor_scope;
    if not found then raise exception 'STANDALONE_ACTOR_ACCESS_DENIED'; end if;
  end if;

  select * into c from chats where id=p_chat;
  if found then
    if c.actor_id is distinct from p_actor or not standalone_verify_scope(p_owner,p_actor,p_chat)
    then raise exception 'STANDALONE_SCOPE_DENIED'; end if;
    return to_jsonb(c);
  end if;
  if exists(select 1 from standalone_owner_bindings where chat_id=p_chat)
  then raise exception 'STANDALONE_SCOPE_REVOKED'; end if;
  insert into chats(id,actor_id,title) values(p_chat,p_actor,trim(p_title)) returning * into c;
  perform standalone_bind_scope(p_owner,p_actor,p_chat);
  insert into short_term_memory(actor_id,chat_id,content) values(p_actor,p_chat,'{}'::jsonb)
    on conflict(actor_id,chat_id) do nothing;
  insert into intermediate_memory(actor_id,chat_id,content) values(p_actor,p_chat,'{}'::jsonb)
    on conflict(actor_id,chat_id) do nothing;
  return to_jsonb(c);
end $function$


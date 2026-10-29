-- Additive correction; apply only through scripts/run-migrations.mjs.
-- Preserve the accepted pricing, cost policy and accounting history.
begin;
create or replace function public.standalone_create_conversation(p_owner uuid,p_actor uuid,p_chat uuid,p_title text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c chats;
begin
 if p_owner is null or p_chat is null or length(trim(p_title)) not between 1 and 1000 then raise exception 'STANDALONE_SCOPE_INVALID';end if;
 -- Creation IDs are idempotent, but can never claim or overwrite an existing
 -- unbound/foreign conversation, even under concurrent requests.
 perform pg_advisory_xact_lock(hashtextextended(p_chat::text,0));
 perform 1 from actors a where a.id=p_actor and coalesce(a.actor_kind,'standard')='standard'
 and not exists(select 1 from managed_agents m where m.actor_id=a.id) for key share of a;
 if not found then raise exception 'STANDALONE_SCOPE_INVALID';end if;
 -- Only pre-existing, independently verified access grants confer actor
 -- authority. A conversation binding (including one created by an older
 -- enrollment path), actor name or caller-supplied UUID cannot confer it.
 -- Hold the grant and its live scope against deletion until creation commits.
 perform 1 from self_tool_owner_grants g join chats access_chat
 on access_chat.id=g.chat_id and access_chat.actor_id=g.actor_id
 where g.owner_id=p_owner and g.actor_id=p_actor
 for key share of g,access_chat;
 if not found then raise exception 'STANDALONE_ACTOR_ACCESS_DENIED';end if;
 select * into c from chats where id=p_chat;
 if found then
  if c.actor_id is distinct from p_actor or not standalone_verify_scope(p_owner,p_actor,p_chat) then raise exception 'STANDALONE_SCOPE_DENIED';end if;
  return to_jsonb(c);
 end if;
 if exists(select 1 from standalone_owner_bindings where chat_id=p_chat) then raise exception 'STANDALONE_SCOPE_REVOKED';end if;
 insert into chats(id,actor_id,title) values(p_chat,p_actor,trim(p_title)) returning * into c;
 perform standalone_bind_scope(p_owner,p_actor,p_chat);
 insert into short_term_memory(actor_id,chat_id,content) values(p_actor,p_chat,'{}'::jsonb) on conflict(actor_id,chat_id) do nothing;
 insert into intermediate_memory(actor_id,chat_id,content) values(p_actor,p_chat,'{}'::jsonb) on conflict(actor_id,chat_id) do nothing;
 return to_jsonb(c);
end $$;
revoke all on function standalone_create_conversation(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function standalone_create_conversation(uuid,uuid,uuid,text) to service_role;
commit;

-- Additive follow-up: run only through scripts/run-migrations.mjs.
-- Bindings are historical identities, not live application rows. Retain their
-- UUIDs (and all referencing attempts/workflows) when a chat or actor is deleted.
begin;
alter table public.standalone_owner_bindings
 add column revoked_at timestamptz,
 drop constraint standalone_owner_bindings_actor_id_fkey,
 drop constraint standalone_owner_bindings_chat_id_fkey;

create function public.standalone_revoke_deleted_scope() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if tg_table_name='actors' then
  update standalone_owner_bindings set revoked_at=coalesce(revoked_at,now()) where actor_id=old.id;
 else
  update standalone_owner_bindings set revoked_at=coalesce(revoked_at,now()) where chat_id=old.id;
 end if;
 return old;
end $$;
revoke all on function public.standalone_revoke_deleted_scope() from public,anon,authenticated,service_role;
create trigger standalone_revoke_actor_before_delete before delete on public.actors
 for each row execute function public.standalone_revoke_deleted_scope();
create trigger standalone_revoke_chat_before_delete before delete on public.chats
 for each row execute function public.standalone_revoke_deleted_scope();

create or replace function public.standalone_verify_scope(p_owner uuid,p_actor uuid,p_chat uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from standalone_owner_bindings b join actors a on a.id=b.actor_id
 join chats c on c.id=b.chat_id and c.actor_id=a.id
 where b.owner_id=p_owner and b.actor_id=p_actor and b.chat_id=p_chat and b.revoked_at is null
 and coalesce(a.actor_kind,'standard')='standard'
 and not exists(select 1 from managed_agents m where m.actor_id=a.id))
$$;
create or replace function public.standalone_bind_scope(p_owner uuid,p_actor uuid,p_chat uuid) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 -- Serialize new bindings against deletion, including an initially unbound chat.
 perform 1 from actors a join chats c on c.actor_id=a.id
 where a.id=p_actor and c.id=p_chat and coalesce(a.actor_kind,'standard')='standard'
 and not exists(select 1 from managed_agents m where m.actor_id=a.id)
 for key share of a,c;
 if not found then raise exception 'STANDALONE_SCOPE_INVALID';end if;
 if exists(select 1 from standalone_owner_bindings where actor_id=p_actor and chat_id=p_chat and revoked_at is not null) then
  raise exception 'STANDALONE_SCOPE_REVOKED';end if;
 insert into standalone_owner_bindings(owner_id,actor_id,chat_id) values(p_owner,p_actor,p_chat)
 on conflict(owner_id,actor_id,chat_id) do nothing;return true;
end $$;
commit;

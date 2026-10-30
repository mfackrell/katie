-- Owner-only enrollment of pre-authentication conversations, never guest claim.
begin;
create table if not exists public.standalone_legacy_recovery_audit (
 chat_id uuid primary key references public.chats(id) on delete restrict,
 owner_id uuid not null references auth.users(id) on delete restrict,
 actor_id uuid not null references public.actors(id) on delete restrict,
 recovered_at timestamptz not null default now(),
 recovery_basis text not null check (recovery_basis = 'pre_auth_single_owner')
);
alter table public.standalone_legacy_recovery_audit enable row level security;
revoke all on public.standalone_legacy_recovery_audit from public,anon,authenticated;
create or replace function public.standalone_claim_pre_auth_owner_scope(
 p_owner uuid,p_actor uuid,p_chat uuid
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner_created timestamptz;
begin
 if p_owner is null or p_actor is null or p_chat is null then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended('legacy-owner-chat:'||p_chat::text,0));
 select created_at into v_owner_created from auth.users
 where id=p_owner and is_anonymous is false;
 if v_owner_created is null then return false; end if;
 -- A single pre-authentication tenant only. If other verified accounts exist,
 -- require an independent exact-scope historic grant instead.
 if (select count(*) from auth.users where is_anonymous is false) <> 1 then return false; end if;
 if not exists(select 1 from chats c join actors a on a.id=c.actor_id
   where c.id=p_chat and c.actor_id=p_actor
   and c.created_at < v_owner_created and a.created_at < v_owner_created)
 then return false; end if;
 if exists(select 1 from standalone_guest_workspaces g where g.actor_id=p_actor) then return false; end if;
 if exists(select 1 from standalone_owner_bindings b where b.chat_id=p_chat
   and (b.owner_id<>p_owner or b.actor_id<>p_actor or b.revoked_at is not null))
 then return false; end if;
 perform standalone_bind_scope(p_owner,p_actor,p_chat);
 if not standalone_verify_scope(p_owner,p_actor,p_chat) then return false; end if;
 insert into standalone_legacy_recovery_audit(chat_id,owner_id,actor_id,recovery_basis)
 values(p_chat,p_owner,p_actor,'pre_auth_single_owner') on conflict(chat_id) do nothing;
 return true;
end $$;
revoke all on function public.standalone_claim_pre_auth_owner_scope(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.standalone_claim_pre_auth_owner_scope(uuid,uuid,uuid) to service_role;
commit;
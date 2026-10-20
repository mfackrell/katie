-- UI metadata never modifies actors, memory, approved scope, or execution state.
create table if not exists public.workspace_presentation_state (
 key text primary key check(key ~ '^(chat|actor|work:(project|mission|task)):[0-9a-f-]{36}$'),
 actor_id uuid not null references public.actors(id) on delete cascade,
 chat_id uuid references public.chats(id) on delete cascade,
 value jsonb not null default '{}'::jsonb check(jsonb_typeof(value)='object' and octet_length(value::text)<=150000),
 version integer not null default 1 check(version>0),
 updated_at timestamptz not null default now()
);
create index if not exists workspace_state_actor on public.workspace_presentation_state(actor_id);
alter table public.workspace_presentation_state enable row level security;
revoke all on public.workspace_presentation_state from public,anon,authenticated,service_role;
grant select,insert,update on public.workspace_presentation_state to service_role;
create or replace function public.save_workspace_presentation(p_key text,p_actor uuid,p_chat uuid,p_value jsonb,p_version integer)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare current_row workspace_presentation_state;
begin
 perform pg_advisory_xact_lock(hashtextextended('workspace-ui:'||p_key,0));
 if p_chat is not null and not exists(select 1 from chats where id=p_chat and actor_id=p_actor) then raise exception 'Conversation scope unavailable';end if;
 select * into current_row from workspace_presentation_state where key=p_key for update;
 if found then
  if current_row.actor_id<>p_actor or current_row.chat_id is distinct from p_chat then raise exception 'Scope mismatch';end if;
  if current_row.version<>p_version then raise exception 'Presentation state changed; reload before saving';end if;
  update workspace_presentation_state set value=value||p_value,version=version+1,updated_at=now() where key=p_key returning * into current_row;
 else
  if p_version<>0 then raise exception 'Presentation state changed; reload before saving';end if;
  insert into workspace_presentation_state(key,actor_id,chat_id,value) values(p_key,p_actor,p_chat,p_value) returning * into current_row;
 end if;
 return to_jsonb(current_row);
end $$;
revoke all on function public.save_workspace_presentation(text,uuid,uuid,jsonb,integer) from public,anon,authenticated;
grant execute on function public.save_workspace_presentation(text,uuid,uuid,jsonb,integer) to service_role;

-- Explicit server-managed ownership admission. No implicit grant from actor names
-- or caller-supplied IDs. Provision only after verifying chat ownership out of band.
create table public.self_tool_owner_grants (
  owner_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid not null references public.actors(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, actor_id, chat_id),
  foreign key (chat_id, actor_id) references public.chats(id, actor_id) on delete cascade
);
alter table public.self_tool_owner_grants enable row level security;
revoke all on public.self_tool_owner_grants from public, anon, authenticated;
grant select, insert, delete on public.self_tool_owner_grants to service_role;

-- Preserve historical receipts. Every new receipt must name an admitted owner.
alter table public.self_tool_receipts add column owner_id uuid references auth.users(id);
create function public.validate_self_tool_owner() returns trigger
language plpgsql set search_path=public as $$
begin
 if new.owner_id is null or not exists (
   select 1 from self_tool_owner_grants g where g.owner_id=new.owner_id
     and g.actor_id::text=new.actor_id and g.chat_id::text=new.chat_id
 ) then
   raise exception 'Tool owner grant invalid';
 end if;
 return new;
end $$;
create trigger self_tool_owner_binding before insert on public.self_tool_receipts
for each row execute function public.validate_self_tool_owner();

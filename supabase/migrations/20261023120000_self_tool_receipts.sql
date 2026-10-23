-- Server-only append-only evidence. Never store tokens, upstream headers or raw logs.
create table public.self_tool_receipts (
  id bigint generated always as identity primary key,
  request_id text not null references public.chat_requests(request_id),
  actor_id text not null,
  chat_id text not null,
  sequence integer not null check (sequence between 1 and 16),
  phase text not null check (phase in ('started','completed','blocked')),
  tool text not null,
  provider text not null,
  model text not null,
  arguments jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  unique(request_id,sequence,phase)
);
alter table public.self_tool_receipts enable row level security;
revoke all on public.self_tool_receipts from public,anon,authenticated,service_role;
grant select,insert on public.self_tool_receipts to service_role;
grant usage,select on sequence public.self_tool_receipts_id_seq to service_role;
create function public.validate_self_tool_receipt() returns trigger
language plpgsql set search_path=public as $$
begin
 if not exists(select 1 from chat_requests r join chats c on c.id::text=r.chat_id
   join actors a on a.id=c.actor_id
   where r.request_id=new.request_id and r.actor_id=new.actor_id and r.chat_id=new.chat_id
   and c.actor_id::text=new.actor_id and lower(trim(a.name))='katie'
   and a.actor_kind='standard' and r.status='processing') then
   raise exception 'Tool receipt association invalid';
 end if;
 return new;
end $$;
create trigger self_tool_receipt_binding before insert on public.self_tool_receipts
for each row execute function public.validate_self_tool_receipt();

-- No dynamic identifiers or executable model-authored SQL.
create function public.self_tool_schema() returns jsonb
language sql security invoker set search_path=public as $$
 select coalesce(jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'type',data_type)
   order by table_name,ordinal_position),'[]'::jsonb)
 from information_schema.columns
 where table_schema='public' and table_name in ('chat_requests','self_tool_receipts');
$$;
revoke all on function public.self_tool_schema() from public,anon,authenticated;
grant execute on function public.self_tool_schema() to service_role;

-- Durable executive intake, including unsupported assignments; no ordinary-chat fallback.
create table if not exists public.executive_management_requests (
 id uuid primary key default gen_random_uuid(),
 actor_id uuid not null references public.actors(id),
 chat_id uuid not null references public.chats(id),
 request_id text not null check(length(request_id) between 1 and 128),
 objective text not null check(length(objective) between 1 and 30000),
 status text not null check(status in ('received','delegated','blocked')),
 detail text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(actor_id,chat_id,request_id)
);
create index if not exists executive_management_requests_chat on public.executive_management_requests(chat_id,created_at desc);
alter table public.executive_management_requests enable row level security;
revoke all on public.executive_management_requests from public,anon,authenticated;
grant select,insert,update on public.executive_management_requests to service_role;

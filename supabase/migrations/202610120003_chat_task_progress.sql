-- Actor/chat-scoped, durable task continuity ledger.
-- Only the server-side service role can read/write it; not exposed to browsers.
create table if not exists public.chat_task_progress (
  actor_id uuid not null references public.actors(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (actor_id, chat_id)
);

alter table public.chat_task_progress enable row level security;
revoke all on public.chat_task_progress from anon, authenticated;
grant select, insert, update, delete on public.chat_task_progress to service_role;

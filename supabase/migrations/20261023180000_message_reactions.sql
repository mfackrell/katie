-- Reactions are feedback about specific saved assistant responses, not synthetic chat turns.
create table if not exists public.message_reactions (
  message_id uuid primary key references public.messages(id) on delete cascade,
  actor_id uuid not null references public.actors(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  reaction text not null check (reaction in ('laugh','love','like','dislike','surprised','sad','frustrated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists message_reactions_actor_recent on public.message_reactions(actor_id,updated_at desc);
create index if not exists message_reactions_chat_recent on public.message_reactions(chat_id,updated_at desc);
alter table public.message_reactions enable row level security;
-- Service role only. No direct public/client access.
revoke all on public.message_reactions from anon, authenticated;

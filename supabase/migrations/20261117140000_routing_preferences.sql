-- Isolated, service-only storage. API verifies Auth and standalone actor/chat scope.
create table public.user_routing_preferences (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  mode text not null check (mode in ('best_answer','best_value'))
);
create table public.conversation_routing_preferences (
  owner_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid not null references public.actors(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  mode text check (mode in ('best_answer','best_value')),
  primary key (owner_id,actor_id,chat_id)
);
alter table public.user_routing_preferences enable row level security;
alter table public.conversation_routing_preferences enable row level security;
revoke all on public.user_routing_preferences, public.conversation_routing_preferences from public, anon, authenticated;
grant select, insert, update, delete on public.user_routing_preferences, public.conversation_routing_preferences to service_role;

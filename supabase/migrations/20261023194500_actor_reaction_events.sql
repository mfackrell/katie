-- Durable actor-addressed reaction notifications, created atomically by database triggers.
create table if not exists public.actor_reaction_events (
  id bigint generated always as identity primary key,
  actor_id uuid not null references public.actors(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  reaction text,
  event_type text not null check (event_type in ('added','changed','removed')),
  occurred_at timestamptz not null default now(),
  check (reaction is null or reaction in ('laugh','love','like','dislike','surprised','sad','frustrated'))
);
create index if not exists actor_reaction_events_latest on public.actor_reaction_events(actor_id,occurred_at desc,id desc);
alter table public.actor_reaction_events enable row level security;
revoke all on public.actor_reaction_events from anon, authenticated;

create or replace function public.record_actor_reaction_event() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if TG_OP = 'DELETE' then
    insert into public.actor_reaction_events(actor_id,chat_id,message_id,reaction,event_type)
      values (OLD.actor_id,OLD.chat_id,OLD.message_id,null,'removed');
    return OLD;
  elsif TG_OP = 'INSERT' then
    insert into public.actor_reaction_events(actor_id,chat_id,message_id,reaction,event_type)
      values (NEW.actor_id,NEW.chat_id,NEW.message_id,NEW.reaction,'added');
    return NEW;
  elsif OLD.reaction is distinct from NEW.reaction then
    insert into public.actor_reaction_events(actor_id,chat_id,message_id,reaction,event_type)
      values (NEW.actor_id,NEW.chat_id,NEW.message_id,NEW.reaction,'changed');
  end if;
  return NEW;
end;
$$;
drop trigger if exists actor_reaction_notification on public.message_reactions;
create trigger actor_reaction_notification
after insert or update or delete on public.message_reactions
for each row execute function public.record_actor_reaction_event();

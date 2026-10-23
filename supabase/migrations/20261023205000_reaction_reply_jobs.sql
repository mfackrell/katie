create table if not exists public.reaction_reply_jobs (
 id bigint generated always as identity primary key,
 event_id bigint not null unique references public.actor_reaction_events(id) on delete cascade,
 actor_id uuid not null references public.actors(id),
 chat_id uuid not null references public.chats(id),
 message_id uuid not null references public.messages(id),
 request_id uuid not null default gen_random_uuid() unique,
 status text not null default 'queued' check(status in ('queued','processing','completed','failed')),
 attempts integer not null default 0,
 lease_until timestamptz,
 error text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists reaction_reply_jobs_pending on public.reaction_reply_jobs(status,lease_until,created_at);
alter table public.reaction_reply_jobs enable row level security;
revoke all on public.reaction_reply_jobs from anon,authenticated;
create or replace function public.enqueue_reaction_reply() returns trigger language plpgsql security invoker set search_path=public as $$
begin
 insert into reaction_reply_jobs(event_id,actor_id,chat_id,message_id) values(NEW.id,NEW.actor_id,NEW.chat_id,NEW.message_id);
 return NEW;
end $$;
drop trigger if exists reaction_reply_enqueue on public.actor_reaction_events;
create trigger reaction_reply_enqueue after insert on public.actor_reaction_events for each row execute function public.enqueue_reaction_reply();
create or replace function public.claim_reaction_reply(p_id bigint default null)
returns setof public.reaction_reply_jobs language plpgsql security invoker set search_path=public as $$
begin
 return query
 with candidate as (
 select j.id from reaction_reply_jobs j
 where (p_id is null or j.id=p_id)
 and (j.status='queued' or (j.status='processing' and j.lease_until<now()))
 and j.attempts<5
 order by j.created_at asc for update skip locked limit 1
 )
 update reaction_reply_jobs j set status='processing',attempts=j.attempts+1,
 lease_until=now()+interval '8 minutes',updated_at=now()
 from candidate where j.id=candidate.id returning j.*;
end $$;
revoke all on function public.claim_reaction_reply(bigint) from public,anon,authenticated;
grant execute on function public.claim_reaction_reply(bigint) to service_role;
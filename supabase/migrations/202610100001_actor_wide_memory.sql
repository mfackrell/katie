-- Actor-wide memory. Never delete legacy chat-scoped long_term_memory during migration.
create table if not exists public.actor_long_term_memory (
 actor_id uuid primary key references public.actors(id) on delete cascade,
 content jsonb not null default '{"version":3,"purpose":"Actor-wide durable memory","entries":[]}'::jsonb,
 revision bigint not null default 0,
 updated_at timestamptz not null default now()
);
create table if not exists public.actor_memory_documents (
 id uuid primary key default gen_random_uuid(),
 actor_id uuid not null references public.actors(id) on delete cascade,
 source_message_id uuid unique,
 title text not null default 'Explicitly remembered information',
 content text not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists actor_memory_documents_actor_created_idx on public.actor_memory_documents(actor_id,created_at desc);
alter table public.actor_long_term_memory enable row level security;
alter table public.actor_memory_documents enable row level security;
-- Server-only service role is the sole reader/writer.
with ranked as (
 select m.actor_id,e.entry,
 row_number() over (partition by m.actor_id,coalesce(e.entry->>'key',e.entry::text)
 order by m.updated_at desc,m.chat_id desc) as rn
 from public.long_term_memory m
 cross join lateral jsonb_array_elements(
 case when jsonb_typeof(m.content->'entries')='array' then m.content->'entries' else '[]'::jsonb end) e(entry)
), grouped as (
 select actor_id,jsonb_agg(entry order by entry->>'key') entries
 from ranked where rn=1 group by actor_id
)
insert into public.actor_long_term_memory(actor_id,content)
select actor_id,jsonb_build_object('version',3,'purpose','Actor-wide durable memory','entries',entries)
from grouped on conflict (actor_id) do nothing;
insert into public.actor_memory_documents(actor_id,title,content)
select m.actor_id,'Legacy long-term memory from chat '||m.chat_id::text,m.content::text
from public.long_term_memory m
where m.content<>'{}'::jsonb
and not exists(select 1 from public.actor_memory_documents d
where d.actor_id=m.actor_id and d.title='Legacy long-term memory from chat '||m.chat_id::text);

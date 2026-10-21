create table if not exists public.actor_review_contracts (
 actor_id uuid not null references public.actors(id) on delete cascade,
 project_source_id text not null,
 objective_source_id text not null,
 source_hash text not null,
 assessment jsonb not null,
 validation jsonb not null,
 created_at timestamptz not null default now(),
 primary key(actor_id,project_source_id,objective_source_id,source_hash),
 constraint review_source_hash_len check (length(source_hash)=64)
);
create index if not exists actor_review_contracts_actor_recent on public.actor_review_contracts(actor_id,created_at desc);
alter table public.actor_review_contracts enable row level security;
revoke all on public.actor_review_contracts from anon, authenticated;
grant select,insert on public.actor_review_contracts to service_role;

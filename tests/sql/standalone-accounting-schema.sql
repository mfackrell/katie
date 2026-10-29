-- Minimal existing application schema fixture. Only the additive ledger migration is installed.
create role service_role bypassrls;
create role anon;
create role authenticated;
create table public.actors(id uuid primary key,name text not null,actor_kind text default 'standard');
create table public.chats(id uuid primary key,actor_id uuid references actors(id) on delete cascade,title text,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table public.managed_agents(id uuid primary key,actor_id uuid references actors(id));
-- A neighboring subsystem sentinel: standalone operations must leave it untouched.
create table public.benchmark_budget_accounts(id uuid primary key,spent_tokens bigint not null);
insert into public.benchmark_budget_accounts values('00000000-0000-4000-8000-000000000099',731);
grant usage on schema public to service_role,anon,authenticated;

create table short_term_memory(actor_id uuid,chat_id uuid,content jsonb,primary key(actor_id,chat_id));
create table intermediate_memory(actor_id uuid,chat_id uuid,content jsonb,primary key(actor_id,chat_id));

-- Existing independently provisioned access records (20261023130000).
create unique index chats_id_actor_id_fixture on chats(id,actor_id);
create table public.self_tool_owner_grants(
 owner_id uuid not null,actor_id uuid not null references actors(id) on delete cascade,
 chat_id uuid not null references chats(id) on delete cascade,created_at timestamptz not null default now(),
 primary key(owner_id,actor_id,chat_id),foreign key(chat_id,actor_id) references chats(id,actor_id) on delete cascade
);
alter table self_tool_owner_grants enable row level security;
revoke all on self_tool_owner_grants from public,anon,authenticated;
grant select,insert,delete on self_tool_owner_grants to service_role;

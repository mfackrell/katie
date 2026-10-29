-- Minimal existing application schema fixture. Only the additive ledger migration is installed.
create role service_role bypassrls;
create role anon;
create role authenticated;
create table public.actors(id uuid primary key,name text not null,actor_kind text default 'standard');
create table public.chats(id uuid primary key,actor_id uuid references actors(id) on delete cascade,title text);
create table public.managed_agents(id uuid primary key,actor_id uuid references actors(id));
-- A neighboring subsystem sentinel: standalone operations must leave it untouched.
create table public.benchmark_budget_accounts(id uuid primary key,spent_tokens bigint not null);
insert into public.benchmark_budget_accounts values('00000000-0000-4000-8000-000000000099',731);
grant usage on schema public to service_role,anon,authenticated;

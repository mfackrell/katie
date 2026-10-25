-- Trusted server-side association. Never authorize from model-generated project evidence.
create table if not exists public.benchmark_mission_bindings (
 mission_id uuid primary key references public.agent_missions(id),
 account_id uuid not null references public.benchmark_budget_accounts(id),
 experiment_id uuid not null,
 baseline_sha text not null check (baseline_sha ~ '^[a-f0-9]{40}$'),
 created_at timestamptz not null default now()
);
alter table public.benchmark_mission_bindings enable row level security;
revoke all on public.benchmark_mission_bindings from public,anon,authenticated;
-- This table intentionally provides no client-side admission path.

-- Trusted development-dispatch association. This is not spending approval.
-- The actual engineering grant/epoch and gateway must be verified separately.
create table if not exists public.benchmark_development_dispatches (
 task_id uuid primary key references public.agent_tasks(id),
 trial_id uuid not null references public.benchmark_three_arm_trials(id),
 contract_hash text not null check(contract_hash ~ '^[0-9a-f]{64}$'),
 baseline_sha text not null check(baseline_sha ~ '^[0-9a-f]{40}$'),
 status text not null default 'pending' check(status in ('pending','qualified','blocked')),
 created_at timestamptz not null default now(),
 unique(trial_id,task_id)
);
alter table public.benchmark_development_dispatches enable row level security;
revoke all on public.benchmark_development_dispatches from public,anon,authenticated;

-- Additive, non-billable experiment registry. Does not change legacy accounts,
-- admission functions, existing projects, approvals, or spending authority.
create table if not exists public.benchmark_three_arm_trials (
 id uuid primary key default gen_random_uuid(),
 experiment_id uuid not null,
 replicate integer not null check(replicate between 1 and 1000),
 arm text not null check(arm in ('native','thin','full')),
 owner_actor_id uuid not null,
 contract_sha256 text not null check(contract_sha256 ~ '^[a-f0-9]{64}$'),
 baseline_sha text not null check(baseline_sha ~ '^[a-f0-9]{40}$'),
 model_policy_sha256 text not null check(model_policy_sha256 ~ '^[a-f0-9]{64}$'),
 tool_profile_sha256 text not null check(tool_profile_sha256 ~ '^[a-f0-9]{64}$'),
 acceptance_sha256 text not null check(acceptance_sha256 ~ '^[a-f0-9]{64}$'),
 runtime_sha256 text not null check(runtime_sha256 ~ '^[a-f0-9]{64}$'),
 state text not null default 'planned'
   check(state in ('planned','qualified','running','submitted','reviewed','blocked')),
 created_at timestamptz not null default now(),
 unique(experiment_id,replicate,arm)
);
create index if not exists benchmark_three_arm_trials_experiment
 on public.benchmark_three_arm_trials(experiment_id,replicate);
alter table public.benchmark_three_arm_trials enable row level security;
revoke all on public.benchmark_three_arm_trials from public,anon,authenticated;
-- Never turn registration into executable owner approval. No client policies.

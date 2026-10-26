create role service_role;
create schema if not exists public;
create table public.benchmark_three_arm_trials(
 id uuid primary key, arm text,state text,owner_actor_id uuid);
create table public.benchmark_budget_accounts(
 id uuid primary key,trial_id uuid,arm text,owner_actor_id uuid,
 frozen_at timestamptz,cap_tokens bigint);
create table public.benchmark_native_spending_approvals(
 id uuid primary key,owner_id uuid,actor_id uuid,chat_id uuid,
 trial_id uuid,account_id uuid,repository text,model text,
 deadline timestamptz,revoked_at timestamptz,consumed_at timestamptz,
 task_id uuid,project_id uuid,mission_assignment_id uuid,
 max_tokens bigint,protocol_digest text);
create table public.benchmark_budget_calls(
 id uuid primary key,account_id uuid,state text);
create table public.benchmark_execution_grants(
 id uuid primary key default gen_random_uuid(),
 token_digest text,trial_id uuid,account_id uuid,owner_actor_id uuid,
 protocol_digest text,repository text,model text,execution_epoch bigint,
 deadline timestamptz,unique(trial_id,execution_epoch));

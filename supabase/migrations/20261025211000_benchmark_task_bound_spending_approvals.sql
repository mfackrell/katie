-- Owner authorization must be for this particular Developer task. No wildcard.
alter table public.benchmark_native_spending_approvals
 add column if not exists task_id uuid references public.agent_tasks(id);
create unique index if not exists benchmark_active_native_task_approval
 on public.benchmark_native_spending_approvals(trial_id,task_id)
 where task_id is not null and consumed_at is null and revoked_at is null;
-- Neither owner authentication nor chat content can create this approval row.
revoke all on public.benchmark_native_spending_approvals from public,anon,authenticated;

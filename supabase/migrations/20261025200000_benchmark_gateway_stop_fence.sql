alter table public.benchmark_execution_grants add column if not exists stopped_at timestamptz;
create or replace function public.benchmark_gateway_execution_live(p_digest text,p_trial uuid,p_epoch bigint)
returns boolean language sql security invoker set search_path=public as $$
select exists(select 1 from public.benchmark_execution_grants g
join public.benchmark_three_arm_trials t on t.id=g.trial_id
where g.token_digest=p_digest and g.trial_id=p_trial
and g.execution_epoch=p_epoch and g.revoked_at is null
and g.stopped_at is null and g.deadline>now() and t.state='running');
$$;
revoke all on function public.benchmark_gateway_execution_live(text,uuid,bigint) from public,anon,authenticated;
grant execute on function public.benchmark_gateway_execution_live(text,uuid,bigint) to service_role;

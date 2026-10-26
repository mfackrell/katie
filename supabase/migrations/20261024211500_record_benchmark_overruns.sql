-- Preserve known provider overruns instead of losing actual usage.
-- Forward-only migration; existing ledger/charges remain intact.
alter table public.benchmark_budget_calls
  drop constraint if exists benchmark_budget_calls_state_check;
alter table public.benchmark_budget_calls
  add constraint benchmark_budget_calls_state_check
  check (state in ('reserved','settled','unresolved','overrun'));

create or replace function public.benchmark_record_overrun(p_call uuid,p_actual bigint)
returns boolean language plpgsql security invoker set search_path=public as $$
declare c public.benchmark_budget_calls;
begin
  select * into c from public.benchmark_budget_calls where id=p_call for update;
  if not found or c.state <> 'reserved' or p_actual is null
     or p_actual <= c.reserved_tokens then
    raise exception 'invalid benchmark overrun';
  end if;
  update public.benchmark_budget_accounts
    set spent_tokens=spent_tokens+p_actual where id=c.account_id;
  update public.benchmark_budget_calls
    set actual_tokens=p_actual,state='overrun' where id=c.id;
  return true;
end $$;
revoke all on function public.benchmark_record_overrun(uuid,bigint)
  from public,anon,authenticated;
grant execute on function public.benchmark_record_overrun(uuid,bigint)
  to service_role;

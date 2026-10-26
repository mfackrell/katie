-- Block generic mutation of a linked mission projection. The mission bridge is
-- the only authority for those calls; all operations are transaction-local.
create or replace function public.benchmark_reconcile_receipt(
 p_call uuid,p_namespace text,p_provider_request text,p_actual bigint)
returns text language plpgsql security invoker set search_path=public as $$
declare c public.benchmark_budget_calls; next_state text;
begin
 if nullif(btrim(p_namespace),'') is null or nullif(btrim(p_provider_request),'') is null
    or p_actual is null or p_actual<0 then raise exception 'provider receipt incomplete';end if;
 select * into c from public.benchmark_budget_calls where id=p_call for update;
 if not found then raise exception 'unknown call';end if;
 if c.legacy_mission_call_id is not null then
  raise exception 'linked operation requires atomic mission receipt reconciliation';end if;
 if c.provider_request_id is not null and
   (c.provider_request_id<>p_provider_request or c.provider_namespace is distinct from p_namespace)
 then raise exception 'receipt identity conflict';end if;
 if c.state in ('settled','overrun') then
  if c.actual_tokens<>p_actual then raise exception 'receipt usage conflict';end if;
  update public.benchmark_budget_calls set provider_namespace=p_namespace,
   provider_request_id=p_provider_request where id=c.id;
  return c.state;
 end if;
 next_state:=case when p_actual>c.reserved_tokens then 'overrun' else 'settled' end;
 update public.benchmark_budget_accounts set spent_tokens=spent_tokens+p_actual,
  frozen_at=case when next_state='overrun' then coalesce(frozen_at,now()) else frozen_at end
  where id=c.account_id;
 update public.benchmark_budget_calls set actual_tokens=p_actual,state=next_state,
  provider_namespace=p_namespace,provider_request_id=p_provider_request where id=c.id;
 return next_state;
end $$;
revoke all on function public.benchmark_reconcile_receipt(uuid,text,text,bigint)
 from public,anon,authenticated;
grant execute on function public.benchmark_reconcile_receipt(uuid,text,text,bigint) to service_role;

create or replace function public.benchmark_record_overrun(p_call uuid,p_actual bigint)
returns boolean language plpgsql security invoker set search_path=public as $$
declare c public.benchmark_budget_calls;
begin
 select * into c from public.benchmark_budget_calls where id=p_call for update;
 if not found then raise exception 'unknown call';end if;
 if c.legacy_mission_call_id is not null then
  raise exception 'linked operation requires atomic mission overrun settlement';end if;
 if c.state<>'reserved' or p_actual is null or p_actual<=c.reserved_tokens
 then raise exception 'invalid overrun';end if;
 update public.benchmark_budget_accounts set spent_tokens=spent_tokens+p_actual,
  frozen_at=coalesce(frozen_at,now()) where id=c.account_id;
 update public.benchmark_budget_calls set actual_tokens=p_actual,state='overrun'
  where id=c.id;
 return true;
end $$;
revoke all on function public.benchmark_record_overrun(uuid,bigint)
 from public,anon,authenticated;
grant execute on function public.benchmark_record_overrun(uuid,bigint) to service_role;

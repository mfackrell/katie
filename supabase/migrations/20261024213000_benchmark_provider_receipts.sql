-- Idempotent provider receipt reconciliation. Never clear uncertain charges
-- without an immutable external request identifier and actual usage.
alter table public.benchmark_budget_calls
 add column if not exists provider_request_id text;
create unique index if not exists benchmark_provider_receipt_uniq
 on public.benchmark_budget_calls(provider_request_id)
 where provider_request_id is not null;

create or replace function public.benchmark_reconcile_receipt(
 p_call uuid,p_provider_request text,p_actual bigint)
returns text language plpgsql security invoker set search_path=public as $$
declare c public.benchmark_budget_calls; next_state text;
begin
 if nullif(btrim(p_provider_request),'') is null or p_actual is null or p_actual<0 then
   raise exception 'provider receipt incomplete';
 end if;
 select * into c from public.benchmark_budget_calls where id=p_call for update;
 if not found then raise exception 'unknown call'; end if;
 if c.state in ('settled','overrun') then
   if c.provider_request_id=p_provider_request and c.actual_tokens=p_actual then
     return c.state;
   end if;
   raise exception 'receipt reconciliation conflict';
 end if;
 if c.provider_request_id is not null and c.provider_request_id<>p_provider_request then
   raise exception 'provider receipt identity changed';
 end if;
 next_state:=case when p_actual>c.reserved_tokens then 'overrun' else 'settled' end;
 update public.benchmark_budget_accounts
   set spent_tokens=spent_tokens+p_actual where id=c.account_id;
 update public.benchmark_budget_calls
   set actual_tokens=p_actual,state=next_state,provider_request_id=p_provider_request
   where id=c.id;
 return next_state;
end $$;
revoke all on function public.benchmark_reconcile_receipt(uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.benchmark_reconcile_receipt(uuid,text,bigint) to service_role;

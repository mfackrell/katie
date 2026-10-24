-- Reconcile receipts without double charging; quarantine every observed overrun.
alter table public.benchmark_budget_accounts add column if not exists frozen_at timestamptz;
alter table public.benchmark_budget_calls add column if not exists provider_namespace text;
drop index if exists public.benchmark_provider_receipt_uniq;
create unique index if not exists benchmark_provider_receipt_namespace_uniq
 on public.benchmark_budget_calls(provider_namespace,provider_request_id)
 where provider_namespace is not null and provider_request_id is not null;

-- Keep the legacy admission RPC's original predicates and lock ordering.
create or replace function public.benchmark_reserve_call(p_account uuid,p_key text,p_model text,p_tokens bigint)
returns uuid language plpgsql security invoker set search_path=public as $$
declare a public.benchmark_budget_accounts; hold bigint; receipt uuid;
begin
 if p_tokens is null or p_tokens<=0 or nullif(p_key,'') is null then raise exception 'invalid admission'; end if;
 select * into a from public.benchmark_budget_accounts where id=p_account for update;
 if not found then raise exception 'unknown account'; end if;
 if a.frozen_at is not null or exists(select 1 from public.benchmark_budget_calls where account_id=p_account and state='overrun') then
   raise exception 'benchmark account quarantined';
 end if;
 if exists(select 1 from public.benchmark_budget_calls where account_id=p_account and request_key=p_key) then raise exception 'duplicate request'; end if;
 select coalesce(sum(reserved_tokens),0) into hold from public.benchmark_budget_calls where account_id=p_account and state in ('reserved','unresolved');
 if a.spent_tokens+hold+p_tokens>a.cap_tokens then raise exception 'benchmark budget exhausted'; end if;
 insert into public.benchmark_budget_calls(account_id,request_key,model,reserved_tokens) values(p_account,p_key,p_model,p_tokens) returning id into receipt;
 return receipt;
end $$;

create or replace function public.benchmark_record_overrun(p_call uuid,p_actual bigint)
returns boolean language plpgsql security invoker set search_path=public as $$
declare c public.benchmark_budget_calls;
begin
 select * into c from public.benchmark_budget_calls where id=p_call for update;
 if not found or c.state<>'reserved' or p_actual is null or p_actual<=c.reserved_tokens then raise exception 'invalid benchmark overrun'; end if;
 update public.benchmark_budget_accounts set spent_tokens=spent_tokens+p_actual,frozen_at=coalesce(frozen_at,now()) where id=c.account_id;
 update public.benchmark_budget_calls set actual_tokens=p_actual,state='overrun' where id=c.id;
 return true;
end $$;

create or replace function public.benchmark_reconcile_receipt(p_call uuid,p_namespace text,p_provider_request text,p_actual bigint)
returns text language plpgsql security invoker set search_path=public as $$
declare c public.benchmark_budget_calls; new_state text;
begin
 if nullif(btrim(p_namespace),'') is null or nullif(btrim(p_provider_request),'') is null or p_actual is null or p_actual<0 then raise exception 'provider receipt incomplete'; end if;
 select * into c from public.benchmark_budget_calls where id=p_call for update;
 if not found then raise exception 'unknown call'; end if;
 if c.provider_request_id is not null and (c.provider_request_id<>p_provider_request or c.provider_namespace is distinct from p_namespace) then raise exception 'receipt identity conflict'; end if;
 if c.state in ('settled','overrun') then
  if c.actual_tokens<>p_actual then raise exception 'receipt usage conflict'; end if;
  -- First trusted receipt may be attached after an earlier settlement. No new charge.
  update public.benchmark_budget_calls set provider_namespace=p_namespace,provider_request_id=p_provider_request where id=c.id;
  return c.state;
 end if;
 new_state:=case when p_actual>c.reserved_tokens then 'overrun' else 'settled' end;
 update public.benchmark_budget_accounts set spent_tokens=spent_tokens+p_actual,
   frozen_at=case when new_state='overrun' then coalesce(frozen_at,now()) else frozen_at end where id=c.account_id;
 update public.benchmark_budget_calls set actual_tokens=p_actual,state=new_state,
   provider_namespace=p_namespace,provider_request_id=p_provider_request where id=c.id;
 return new_state;
end $$;
-- Remove the obsolete three-argument overload: it cannot bind provider namespace.
drop function if exists public.benchmark_reconcile_receipt(uuid,text,bigint);
revoke all on function public.benchmark_reconcile_receipt(uuid,text,text,bigint) from public,anon,authenticated;
grant execute on function public.benchmark_reconcile_receipt(uuid,text,text,bigint) to service_role;

-- Reconcile an uncertain benchmark-bound provider call into BOTH accounting
-- projections in one transaction, without clearing its hold on a guess.
-- Requires the provider namespace/receipt columns introduced by #739.
create or replace function public.benchmark_reconcile_uncertain_mission_call(
 p_call uuid,p_namespace text,p_provider_request text,p_actual integer)
returns boolean language plpgsql security invoker set search_path=public as $$
declare c public.mission_calls; b public.benchmark_budget_calls;
 a public.benchmark_budget_accounts; bound_mission_id uuid;
begin
 if nullif(btrim(p_namespace),'') is null
 or nullif(btrim(p_provider_request),'') is null
 or p_actual is null or p_actual<0 then raise exception 'verified usage receipt required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into c from public.mission_calls where id=p_call for update;
 if not found then raise exception 'mission call missing'; end if;
 select ma.mission_id into bound_mission_id from public.mission_assignments ma where ma.id=c.job_id;
 select bc.* into b from public.benchmark_budget_calls bc
 join public.benchmark_mission_bindings mb on mb.account_id=bc.account_id
 where mb.mission_id=bound_mission_id and bc.request_key=p_call::text for update of bc;
 if not found then raise exception 'benchmark projection missing'; end if;
 select * into a from public.benchmark_budget_accounts where id=b.account_id for update;
 if c.status='completed' and b.state in ('settled','overrun') then
  if c.actual_tokens=p_actual and b.actual_tokens=p_actual
     and b.provider_namespace=p_namespace and b.provider_request_id=p_provider_request
  then return true; end if;
  raise exception 'conflicting provider receipt';
 end if;
 if c.status<>'uncertain' or b.state<>'unresolved' then raise exception 'call not reconcilable'; end if;
 if b.provider_request_id is not null and
    (b.provider_request_id<>p_provider_request or b.provider_namespace is distinct from p_namespace)
 then raise exception 'provider receipt changed'; end if;
 update public.mission_calls set actual_tokens=p_actual,status='completed' where id=p_call;
 update public.agent_missions set actual_tokens=actual_tokens+p_actual,
   reserved_tokens=reserved_tokens-c.reserved_tokens+p_actual where id=bound_mission_id;
 update public.benchmark_budget_accounts set spent_tokens=spent_tokens+p_actual,
   frozen_at=case when p_actual>b.reserved_tokens then coalesce(frozen_at,now()) else frozen_at end
   where id=a.id;
 update public.benchmark_budget_calls set actual_tokens=p_actual,
   state=case when p_actual>b.reserved_tokens then 'overrun' else 'settled' end,
   provider_namespace=p_namespace,provider_request_id=p_provider_request where id=b.id;
 return true;
end $$;
revoke all on function public.benchmark_reconcile_uncertain_mission_call(uuid,text,text,integer)
 from public,anon,authenticated;
grant execute on function public.benchmark_reconcile_uncertain_mission_call(uuid,text,text,integer)
 to service_role;

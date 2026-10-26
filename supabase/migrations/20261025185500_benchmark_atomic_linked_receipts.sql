-- Only this bridge attaches a provider receipt to a legacy-projected operation.
-- The existing #737 uncertain reconciliation function is reused in one transaction.
create or replace function public.benchmark_reconcile_linked_receipt(
 p_mission_call uuid,p_namespace text,p_provider_request text,p_actual integer)
returns boolean language plpgsql security invoker set search_path=public as $$
declare c public.mission_calls; b public.benchmark_budget_calls;
begin
 if nullif(btrim(p_namespace),'') is null or nullif(btrim(p_provider_request),'') is null
 or p_actual is null or p_actual<0 then raise exception 'verified receipt required';end if;
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into c from public.mission_calls where id=p_mission_call for update;
 if not found then raise exception 'unknown mission call';end if;
 select * into b from public.benchmark_budget_calls
  where legacy_mission_call_id=p_mission_call for update;
 if not found then raise exception 'missing canonical operation';end if;
 if c.status='uncertain' and b.state='unresolved' then
  return public.benchmark_reconcile_uncertain_mission_call(
   p_mission_call,p_namespace,p_provider_request,p_actual);
 end if;
 if c.status='reserved' and b.state='reserved' then
  perform public.benchmark_finish_mission_call(p_mission_call,p_actual);
  select * into b from public.benchmark_budget_calls where id=b.id for update;
 elsif c.status<>'completed' or b.state not in ('settled','overrun') then
  raise exception 'linked receipt state mismatch';
 end if;
 if c.status='completed' and c.actual_tokens is distinct from p_actual
 then raise exception 'legacy receipt amount conflict';end if;
 if b.actual_tokens is distinct from p_actual then raise exception 'canonical receipt amount conflict';end if;
 if b.provider_request_id is not null and
   (b.provider_request_id<>p_provider_request or b.provider_namespace is distinct from p_namespace)
 then raise exception 'provider receipt identity conflict';end if;
 update public.benchmark_budget_calls
 set provider_namespace=p_namespace,provider_request_id=p_provider_request
 where id=b.id;
 return true;
end $$;
revoke all on function public.benchmark_reconcile_linked_receipt(uuid,text,text,integer)
 from public,anon,authenticated;
grant execute on function public.benchmark_reconcile_linked_receipt(uuid,text,text,integer)
 to service_role;

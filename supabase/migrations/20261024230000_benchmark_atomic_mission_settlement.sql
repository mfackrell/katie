-- One transaction settles the legacy mission projection and benchmark account.
-- Legacy function is authoritative for mission accounting; no separate provider call.
create or replace function public.benchmark_finish_mission_call(
 p_call uuid,p_tokens integer)
returns boolean language plpgsql security invoker set search_path=public as $$
declare c public.mission_calls; b public.benchmark_budget_calls;
 a public.benchmark_budget_accounts;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into c from public.mission_calls where id=p_call for update;
 if not found then raise exception 'missing legacy call'; end if;
 select * into b from public.benchmark_budget_calls
  where request_key=p_call::text for update;
 if not found then raise exception 'missing benchmark projection'; end if;
 select * into a from public.benchmark_budget_accounts where id=b.account_id for update;
 if c.status='completed' and b.state in ('settled','overrun') then
  if c.actual_tokens is distinct from p_tokens or b.actual_tokens is distinct from p_tokens
  then raise exception 'settlement replay conflict'; end if;
  return true;
 end if;
 if c.status<>'reserved' or b.state<>'reserved' then raise exception 'settlement state mismatch'; end if;
 if p_tokens is not null and p_tokens<0 then raise exception 'invalid provider usage'; end if;
 perform public.finish_mission_call(p_call,p_tokens);
 if p_tokens is null then
  update public.benchmark_budget_calls set state='unresolved' where id=b.id;
 else
  update public.benchmark_budget_accounts set spent_tokens=spent_tokens+p_tokens
   where id=a.id;
  update public.benchmark_budget_calls set actual_tokens=p_tokens,
   state=case when p_tokens>b.reserved_tokens then 'overrun' else 'settled' end where id=b.id;
  if p_tokens>b.reserved_tokens then
   -- No further admission after a known provider overrun, even below account cap.
   -- Admission checks any recorded overrun state before allowing another call.
  end if;
 end if;
 return true;
end $$;
revoke all on function public.benchmark_finish_mission_call(uuid,integer) from public,anon,authenticated;
grant execute on function public.benchmark_finish_mission_call(uuid,integer) to service_role;

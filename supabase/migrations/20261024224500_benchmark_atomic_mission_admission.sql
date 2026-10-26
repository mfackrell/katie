-- Atomically preserve legacy mission admission AND reserve the benchmark projection.
-- A rejected benchmark reservation rolls back the legacy mission call/counters.
create or replace function public.benchmark_reserve_mission_call(
 p_job uuid,p_lease uuid,p_call uuid,p_model text,p_tokens integer,p_routing boolean)
returns uuid language plpgsql security invoker set search_path=public as $$
declare j public.mission_assignments; m public.agent_missions;
 b public.benchmark_mission_bindings; a public.benchmark_budget_accounts;
 hold bigint; receipt uuid; accepted boolean;
begin
 -- Same global lock used by the existing legacy admission path. Consistent order:
 -- legacy mission lock -> mission/assignment rows -> benchmark account.
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from public.mission_assignments where id=p_job;
 if not found then return null; end if;
 select * into m from public.agent_missions where id=j.mission_id;
 select * into b from public.benchmark_mission_bindings where mission_id=m.id;
 if not found then return null; end if;
 select * into a from public.benchmark_budget_accounts where id=b.account_id for update;
 if not found or b.experiment_id<>a.experiment_id or a.arm<>'orchestrated'
    then return null; end if;
 if exists(select 1 from public.benchmark_budget_calls
           where account_id=a.id and state='overrun') then return null; end if;
 select coalesce(sum(reserved_tokens),0) into hold
 from public.benchmark_budget_calls where account_id=a.id
   and state in ('reserved','unresolved');
 if a.spent_tokens+hold+p_tokens>a.cap_tokens then return null; end if;
 if exists(select 1 from public.benchmark_budget_calls
           where account_id=a.id and request_key=p_call::text) then return null; end if;
 -- Original function owns deadline, lease, parent, call count and legacy budget checks.
 accepted:=public.try_reserve_mission_capacity(p_job,p_lease,p_call,p_model,p_tokens,p_routing);
 if not accepted then return null; end if;
 insert into public.benchmark_budget_calls(account_id,request_key,model,reserved_tokens)
 values(a.id,p_call::text,p_model,p_tokens) returning id into receipt;
 return receipt;
end $$;
revoke all on function public.benchmark_reserve_mission_call(uuid,uuid,uuid,text,integer,boolean)
 from public,anon,authenticated;
grant execute on function public.benchmark_reserve_mission_call(uuid,uuid,uuid,text,integer,boolean)
 to service_role;

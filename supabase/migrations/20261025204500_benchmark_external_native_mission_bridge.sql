-- Full-native admission: an external execution epoch is NOT the controller lease.
-- Each native HTTP operation takes one mission call and one canonical trial charge.
-- Deployment depends on #737/#739 mission-binding and receipt migrations.
alter table public.benchmark_execution_grants
 add column if not exists mission_assignment_id uuid references public.mission_assignments(id);
create or replace function public.benchmark_full_native_reserve(
 p_digest text,p_trial uuid,p_epoch bigint,p_request_key text,p_model text,p_tokens bigint)
returns uuid language plpgsql security invoker set search_path=public as $$
declare g public.benchmark_execution_grants; a public.benchmark_budget_accounts;
 t public.benchmark_three_arm_trials; p public.work_projects;
 m public.agent_missions; j public.mission_assignments;
 linked public.benchmark_mission_bindings; used bigint; held bigint;
 operation uuid; mission_call uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if p_request_key !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 or p_tokens is null or p_tokens not between 1 and 120000 or
 coalesce(length(p_model),0) not between 1 and 300 then raise exception 'invalid native operation';end if;
 mission_call:=p_request_key::uuid;
 select * into g from public.benchmark_execution_grants where token_digest=p_digest
 and trial_id=p_trial and execution_epoch=p_epoch for update;
 if not found or g.revoked_at is not null or g.stopped_at is not null or
 g.deadline<=now() or g.model<>p_model or g.project_id is null or
 g.mission_assignment_id is null then raise exception 'external session unauthorized';end if;
 select * into t from public.benchmark_three_arm_trials where id=g.trial_id for update;
 if not found or t.arm<>'full' or t.state<>'running' or
 t.owner_actor_id<>g.owner_actor_id then raise exception 'Full trial not running';end if;
 select * into j from public.mission_assignments where id=g.mission_assignment_id for update;
 if not found or j.role<>'development' or j.status<>'waiting_external' then
 raise exception 'external Developer assignment inactive';end if;
 select * into m from public.agent_missions where id=j.mission_id for update;
 if not found or m.status<>'running' or m.deadline<=now() or
 m.project_id is distinct from g.project_id then raise exception 'mission inactive';end if;
 select * into p from public.work_projects where id=g.project_id for update;
 if not found or p.status<>'running' or p.phase<>'development' or p.deadline<=now()
 or p.actor_id<>g.owner_actor_id or p.active_mission_id is distinct from m.id
 or p.approved_hash is null or p.approved_hash is distinct from p.approval_hash
 then raise exception 'parent project denied';end if;
 select * into linked from public.benchmark_mission_bindings where mission_id=m.id;
 if not found or linked.account_id<>g.account_id or linked.experiment_id<>t.experiment_id
 then raise exception 'mission trial accounting association mismatch';end if;
 if m.calls>=m.max_calls or greatest(m.reserved_tokens,m.actual_tokens)+p_tokens>m.token_allowance
 then raise exception 'mission capacity exhausted';end if;
 select coalesce(sum(greatest(reserved_tokens,actual_tokens)),0) into used
 from public.agent_missions where project_id=p.id;
 if used+p_tokens>p.token_allowance then raise exception 'parent project capacity exhausted';end if;
 select * into a from public.benchmark_budget_accounts where id=g.account_id for update;
 if not found or a.trial_id<>t.id or a.owner_actor_id<>t.owner_actor_id or
 a.frozen_at is not null or exists(select 1 from public.benchmark_budget_calls
 where account_id=a.id and state='overrun') then raise exception 'account denied';end if;
 select coalesce(sum(reserved_tokens),0) into held from public.benchmark_budget_calls
 where account_id=a.id and state in ('reserved','unresolved');
 if a.spent_tokens+held+p_tokens>a.cap_tokens or
 exists(select 1 from public.mission_calls where id=mission_call) or
 exists(select 1 from public.benchmark_budget_calls where account_id=a.id
 and request_key=p_request_key) then raise exception 'duplicate or unaffordable operation';end if;
 insert into public.mission_calls(id,job_id,lease,model,reserved_tokens)
 values(mission_call,j.id,g.id,p_model,p_tokens::integer);
 update public.agent_missions set calls=calls+1,
 reserved_tokens=reserved_tokens+p_tokens::integer,updated_at=now()
 where id=m.id;
 insert into public.benchmark_budget_calls(account_id,request_key,model,reserved_tokens,legacy_mission_call_id)
 values(a.id,p_request_key,p_model,p_tokens,mission_call) returning id into operation;
 return operation;
end $$;
revoke all on function public.benchmark_full_native_reserve(text,uuid,bigint,text,text,bigint)
 from public,anon,authenticated;
grant execute on function public.benchmark_full_native_reserve(text,uuid,bigint,text,text,bigint)
 to service_role;

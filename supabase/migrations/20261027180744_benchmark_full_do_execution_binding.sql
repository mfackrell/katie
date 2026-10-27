-- Bind the existing Full Take Eleven trial to an ordinary, server-created DO
-- game project. The binding grants no project approval or execution grant.
create table if not exists public.benchmark_full_project_bindings (
 project_id uuid primary key references public.work_projects(id),
 trial_id uuid not null unique references public.benchmark_three_arm_trials(id),
 account_id uuid not null unique references public.benchmark_budget_accounts(id),
 benchmark_contract_hash text not null check(benchmark_contract_hash ~ '^[a-f0-9]{64}$'),
 baseline_sha text not null check(baseline_sha ~ '^[a-f0-9]{40}$'),
 model text not null check(model='gpt-5.3-codex'),
 created_at timestamptz not null default now()
);
alter table public.benchmark_full_project_bindings enable row level security;
revoke all on public.benchmark_full_project_bindings from public,anon,authenticated;

-- This wrapper preserves the regular game-project lifecycle and commits the
-- benchmark binding atomically before any project worker can claim it.
create or replace function public.benchmark_create_full_game_project(
 p_id uuid,p_request text,p_actor uuid,p_chat uuid,p_objective text,
 p_repository uuid,p_trial uuid,p_baseline text,p_model text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare t public.benchmark_three_arm_trials; a public.benchmark_budget_accounts;
 r public.repo_sync_runs; created jsonb; pid uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if p_objective !~* '(take eleven|issue[[:space:]]*#?715|#715)' or
    p_model<>'gpt-5.3-codex' or
    p_baseline<>'0015bcdb8ac9ad94b7c74d1a4cd76737903b1319' then
  raise exception 'Full benchmark task identity mismatch';
 end if;
 select * into t from public.benchmark_three_arm_trials where id=p_trial for update;
 if not found or t.arm<>'full' or t.owner_actor_id<>p_actor or
    t.baseline_sha<>p_baseline or t.state not in ('planned','qualified') then
  raise exception 'Full benchmark trial unavailable';
 end if;
 select * into a from public.benchmark_budget_accounts where trial_id=t.id for update;
 if not found or a.arm<>'full' or a.owner_actor_id<>p_actor or a.cap_tokens<>350000 or
    a.frozen_at is not null or exists(select 1 from public.benchmark_budget_calls
       where account_id=a.id and state in ('overrun','unresolved')) then
  raise exception 'Full benchmark account unavailable';
 end if;
 select * into r from public.repo_sync_runs where id=p_repository;
 if not found or r.repository_full_name<>'mfackrell/katie' then
  raise exception 'Full benchmark repository binding mismatch';
 end if;
 created:=public.create_game_work_project(p_id,p_request,p_actor,p_chat,p_objective,p_repository);
 pid:=(created->>'id')::uuid;
 if pid<>p_id then raise exception 'Full benchmark project identity conflict';end if;
 update public.work_projects set token_allowance=least(token_allowance,350000)
 where id=pid;
 insert into public.benchmark_full_project_bindings(project_id,trial_id,account_id,
   benchmark_contract_hash,baseline_sha,model)
 values(pid,t.id,a.id,t.contract_sha256,t.baseline_sha,p_model)
 on conflict(project_id) do update set project_id=excluded.project_id
 where benchmark_full_project_bindings.trial_id=excluded.trial_id
   and benchmark_full_project_bindings.account_id=excluded.account_id
   and benchmark_full_project_bindings.benchmark_contract_hash=excluded.benchmark_contract_hash
   and benchmark_full_project_bindings.baseline_sha=excluded.baseline_sha
   and benchmark_full_project_bindings.model=excluded.model;
 if not found then raise exception 'Full benchmark project binding conflict';end if;
 return (select to_jsonb(p) from public.work_projects p where p.id=pid);
end $$;
revoke all on function public.benchmark_create_full_game_project(uuid,text,uuid,uuid,text,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.benchmark_create_full_game_project(uuid,text,uuid,uuid,text,uuid,uuid,text,text) to service_role;

-- Each actual project mission inherits the project account before it can be
-- admitted. No model-generated evidence can create this association.
create or replace function public.benchmark_bind_full_project_mission()
returns trigger language plpgsql security invoker set search_path=public as $$
declare b public.benchmark_full_project_bindings; a public.benchmark_budget_accounts;
begin
 if new.project_id is null then return new;end if;
 select * into b from public.benchmark_full_project_bindings where project_id=new.project_id;
 if not found then return new;end if;
 insert into public.benchmark_mission_bindings(mission_id,account_id,experiment_id,baseline_sha)
 values(new.id,b.account_id,(select experiment_id from public.benchmark_budget_accounts where id=b.account_id),b.baseline_sha)
 on conflict(mission_id) do nothing;
 select * into a from public.benchmark_budget_accounts where id=b.account_id;
 if not exists(select 1 from public.benchmark_mission_bindings where mission_id=new.id
   and account_id=b.account_id and experiment_id=a.experiment_id and baseline_sha=b.baseline_sha) then
  raise exception 'Full project mission accounting binding conflict';
 end if;
 return new;
end $$;
drop trigger if exists benchmark_bind_full_project_mission on public.agent_missions;
create trigger benchmark_bind_full_project_mission after insert or update of project_id on public.agent_missions
for each row execute function public.benchmark_bind_full_project_mission();
revoke all on function public.benchmark_bind_full_project_mission() from public,anon,authenticated;

-- Extend the existing atomic mission admission path. Native external host calls
-- and every ordinary DO inference attempt now share the same Full account.
create or replace function public.benchmark_reserve_mission_call(
 p_job uuid,p_lease uuid,p_call uuid,p_model text,p_tokens integer,p_routing boolean)
returns uuid language plpgsql security invoker set search_path=public as $$
declare j public.mission_assignments; m public.agent_missions;
 b public.benchmark_mission_bindings; a public.benchmark_budget_accounts;
 t public.benchmark_three_arm_trials; p public.work_projects;
 hold bigint; receipt uuid; accepted boolean; full_binding public.benchmark_full_project_bindings;
 price public.model_registry;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from public.mission_assignments where id=p_job;
 if not found then return null;end if;
 select * into m from public.agent_missions where id=j.mission_id;
 select * into b from public.benchmark_mission_bindings where mission_id=m.id;
 if not found then return null;end if;
 select * into a from public.benchmark_budget_accounts where id=b.account_id for update;
 if not found or b.experiment_id<>a.experiment_id then return null;end if;
 if a.arm='full' then
  select * into full_binding from public.benchmark_full_project_bindings
   where project_id=m.project_id and account_id=a.id;
  select * into t from public.benchmark_three_arm_trials where id=a.trial_id for update;
  select * into p from public.work_projects where id=m.project_id for update;
  select * into price from public.model_registry where provider_name='openai'
   and model_id='gpt-5.3-codex';
  if p.id is null or full_binding.project_id is null or t.id is null or
     t.arm<>'full' or t.owner_actor_id<>a.owner_actor_id or
     t.contract_sha256<>full_binding.benchmark_contract_hash or
     t.baseline_sha<>b.baseline_sha or t.state not in ('qualified','running') or
     a.trial_id<>t.id or a.cap_tokens<>350000 or a.frozen_at is not null or
     p.actor_id<>t.owner_actor_id or p.status<>'running' or
     p.active_mission_id<>m.id or m.project_id<>p.id or
     p.token_allowance>350000 or p.deadline<=now() or
     p_model<>'openai:gpt-5.3-codex' or price.model_id is null or
     price.pricing_status<>'verified' or price.pricing_input_per_1m>28 or
     price.pricing_output_per_1m>28 then return null;end if;
 elsif a.arm<>'orchestrated' then return null;
 end if;
 if exists(select 1 from public.benchmark_budget_calls where account_id=a.id and state='overrun') then return null;end if;
 select coalesce(sum(reserved_tokens),0) into hold from public.benchmark_budget_calls
  where account_id=a.id and state in ('reserved','unresolved');
 if a.spent_tokens+hold+p_tokens>a.cap_tokens then return null;end if;
 if exists(select 1 from public.benchmark_budget_calls where account_id=a.id and request_key=p_call::text) then return null;end if;
 accepted:=public.try_reserve_mission_capacity(p_job,p_lease,p_call,p_model,p_tokens,p_routing);
 if not accepted then return null;end if;
 insert into public.benchmark_budget_calls(account_id,request_key,model,reserved_tokens)
 values(a.id,p_call::text,p_model,p_tokens) returning id into receipt;
 return receipt;
end $$;
revoke all on function public.benchmark_reserve_mission_call(uuid,uuid,uuid,text,integer,boolean) from public,anon,authenticated;
grant execute on function public.benchmark_reserve_mission_call(uuid,uuid,uuid,text,integer,boolean) to service_role;

-- Keep the DO project's approved-scope contract and frozen benchmark task
-- contract as separate signed values. Neither value substitutes for owner
-- spending approval; dispatch binding requires the existing live grant row.
alter table public.benchmark_development_dispatches
 add column if not exists benchmark_contract_hash text
 check(benchmark_contract_hash is null or benchmark_contract_hash ~ '^[a-f0-9]{64}$');

create or replace function public.benchmark_bind_full_development_dispatch(
 p_task uuid,p_project uuid,p_scope_hash text,p_project_contract_hash text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare task public.agent_tasks; j public.mission_assignments; m public.agent_missions;
 p public.work_projects; r public.project_runs; b public.benchmark_full_project_bindings;
 t public.benchmark_three_arm_trials; a public.benchmark_budget_accounts;
 approval public.benchmark_native_spending_approvals; result jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into task from public.agent_tasks where id=p_task for update;
 select * into j from public.mission_assignments where id=p_task for update;
 select * into m from public.agent_missions where id=j.mission_id for update;
 select * into p from public.work_projects where id=p_project for update;
 select * into r from public.project_runs where mission_id=m.id;
 select * into b from public.benchmark_full_project_bindings where project_id=p.id;
 if task.id is null or j.id is null or m.id is null or p.id is null or r.id is null or b.project_id is null or
    task.kind<>'development' or task.status<>'dispatching' or task.actor_id<>p.actor_id or
    task.chat_id<>p.chat_id or task.repository_id<>p.repository_id or
    j.role<>'development' or j.status<>'running' or
    m.project_id<>p.id or p.active_mission_id<>m.id or p.status<>'running' or p.phase<>'development' or
    p.approved_hash is null or p.approved_hash is distinct from p.approval_hash or p.approved_hash<>p_scope_hash or
    r.binding->>'scopeHash'<>p_scope_hash or r.binding->>'contractHash'<>p_project_contract_hash then
  raise exception 'approved Full Developer assignment unavailable';
 end if;
 select * into t from public.benchmark_three_arm_trials where id=b.trial_id for update;
 select * into a from public.benchmark_budget_accounts where id=b.account_id for update;
 select * into approval from public.benchmark_native_spending_approvals
  where task_id=p_task and trial_id=t.id and account_id=a.id and project_id=p.id
   and mission_assignment_id=j.id and actor_id=p.actor_id and chat_id=p.chat_id
   and repository='mfackrell/katie' and model=b.model and consumed_at is null and revoked_at is null
   and deadline>now() for update;
 if not found or approval.owner_id is null or t.arm<>'full' or t.owner_actor_id<>p.actor_id or
    t.contract_sha256<>b.benchmark_contract_hash or t.baseline_sha<>b.baseline_sha or
    a.trial_id<>t.id or a.arm<>'full' or a.cap_tokens<>350000 or a.frozen_at is not null then
  raise exception 'live task-specific Full approval unavailable';
 end if;
 insert into public.benchmark_development_dispatches(task_id,trial_id,contract_hash,
   benchmark_contract_hash,baseline_sha,status)
 values(p_task,t.id,p_project_contract_hash,b.benchmark_contract_hash,b.baseline_sha,'qualified')
 on conflict(task_id) do update set status='qualified'
 where benchmark_development_dispatches.trial_id=excluded.trial_id
  and benchmark_development_dispatches.contract_hash=excluded.contract_hash
  and benchmark_development_dispatches.benchmark_contract_hash=excluded.benchmark_contract_hash
  and benchmark_development_dispatches.baseline_sha=excluded.baseline_sha;
 if not found then raise exception 'Full dispatch binding identity conflict';end if;
 result:=jsonb_build_object('trial_id',t.id,'account_id',a.id,'benchmark_contract_hash',b.benchmark_contract_hash,
   'approval_id',approval.id,'model',approval.model,'repository',approval.repository,'deadline',approval.deadline);
 return result;
end $$;
revoke all on function public.benchmark_bind_full_development_dispatch(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.benchmark_bind_full_development_dispatch(uuid,uuid,text,text) to service_role;

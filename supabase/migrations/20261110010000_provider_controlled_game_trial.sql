begin;

-- One explicitly owner-started trial. Historical authority and ledgers are untouched.
create table public.project_provider_execution (
 project_id uuid primary key references public.work_projects(id),
 owner_id uuid not null,
 objective_hash text not null check(objective_hash ~ '^[0-9a-f]{64}$'),
 deadline timestamptz not null,
 approved_scope text check(approved_scope ~ '^[0-9a-f]{64}$'),
 singleton boolean not null unique default true check(singleton)
);
create table public.project_provider_dispatches (
 task_id uuid primary key references public.agent_tasks(id),
 run_id text not null check(run_id ~ '^[1-9][0-9]{0,19}$')
);
alter table public.project_provider_execution enable row level security;
alter table public.project_provider_dispatches enable row level security;
revoke all on public.project_provider_execution,public.project_provider_dispatches from public,anon,authenticated,service_role;
grant select on public.project_provider_execution to service_role;

create function public.project_provider_mode(p_project uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from project_provider_execution where project_id=p_project)
$$;

create function public.project_provider_enable(p_owner uuid,p_project uuid,p_objective_hash text) returns boolean
language plpgsql security definer set search_path=public as $$
declare p work_projects; stop_at timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 if p.id is null or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 or p_objective_hash is distinct from encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')
 then raise exception 'Exact authenticated owner and trial objective required';end if;
 if exists(select 1 from project_provider_execution where project_id=p.id and owner_id=p_owner and objective_hash=p_objective_hash) then return true;end if;
 if p.organization_version<>1 or p.profile<>'game' or p.phase<>'research' or p.status<>'running'
 or p.repository_id is null or not exists(select 1 from repo_sync_runs where id=p.repository_id and repository_full_name='mfackrell/katie')
 or p.objective !~* 'tic[- ]tac[- ]toe' or p.deadline<=now() or p.active_mission_id is not null or p.spec is not null
 or p.approved_hash is not null or p.approval_hash is not null
 or exists(select 1 from agent_missions where project_id=p.id)
 or exists(select 1 from project_organization_authority where project_id=p.id)
 or exists(select 1 from work_projects other where other.chat_id=p.chat_id and other.id<>p.id)
 then raise exception 'A fresh isolated tic-tac-toe game project is required';end if;
 stop_at:=least(p.deadline,clock_timestamp()+interval '2 hours');
 insert into project_provider_execution(project_id,owner_id,objective_hash,deadline) values(p.id,p_owner,p_objective_hash,stop_at);
 update work_projects set deadline=stop_at,max_cycles=least(max_cycles,3) where id=p.id;
 insert into project_events(project_id,event,data) values(p.id,'provider_execution_enabled',jsonb_build_object('objectiveHash',p_objective_hash,'deadline',stop_at));
 return true;
end $$;

-- This is the existing game intake, with an explicit owner action in place of
-- the ordinary chat classifier. Create the project and enable it atomically.
create function public.project_provider_launch(p_owner uuid,p_actor uuid,p_chat uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare pid uuid; repo uuid; objective text;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if not standalone_verify_scope(p_owner,p_actor,p_chat) then raise exception 'Authenticated owner-bound chat required';end if;
 select p.id into pid from work_projects p join project_provider_execution a on a.project_id=p.id
 where p.chat_id=p_chat and p.actor_id=p_actor and a.owner_id=p_owner;
 if pid is not null then return (select to_jsonb(p) from work_projects p where p.id=pid);end if;
 if exists(select 1 from work_projects where chat_id=p_chat) then raise exception 'Use a fresh chat for the isolated trial';end if;
 select id into repo from repo_sync_runs where repository_full_name='mfackrell/katie' order by created_at desc,id limit 1;
 if repo is null then raise exception 'Connected trial repository unavailable';end if;
 pid:=gen_random_uuid();
 objective:='Build a responsive, same-device two-player browser tic-tac-toe game. Start with an empty 3×3 board, X first, and alternate legal moves. Ignore occupied squares without changing the turn. Detect all row, column and diagonal wins and a full-board draw. Display the current turn or result and reject moves after game end. New Game and reload each clear the board and restore X first. No accounts, network play, computer opponent, persistence, new dependencies or extra features. Use a protected Preview and independent same-commit acceptance.';
 perform create_game_work_project(pid,'provider-trial:'||p_chat,p_actor,p_chat,objective,repo);
 perform project_provider_enable(p_owner,pid,encode(sha256(convert_to(objective,'UTF8')),'hex'));
 perform project_publish(pid,'Tic-tac-toe trial started. Katie will prepare the exact game scope for owner review.');
 return (select to_jsonb(p) from work_projects p where p.id=pid);
end $$;

create function public.project_provider_owner_stop(p_owner uuid,p_actor uuid,p_chat uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare pid uuid;
begin
 if not standalone_verify_scope(p_owner,p_actor,p_chat) then raise exception 'Authenticated owner-bound chat required';end if;
 select p.id into pid from work_projects p join project_provider_execution a on a.project_id=p.id
 where p.chat_id=p_chat and p.actor_id=p_actor and a.owner_id=p_owner;
 if pid is null then raise exception 'Trial not found in this chat';end if;
 return control_work_project(pid,p_actor,p_chat,'stop');
end $$;

-- The trial can only publish its dedicated route and write in its three reserved namespaces.
create function public.project_provider_scope_guard() returns trigger
language plpgsql security definer set search_path=public as $$
declare a project_provider_execution; c jsonb;
begin
 select * into a from project_provider_execution where project_id=new.id;
 if not found then return new;end if;
 if new.deadline is distinct from a.deadline or new.repository_id is distinct from old.repository_id
 or encode(sha256(convert_to(new.objective||new.clarifications,'UTF8')),'hex') is distinct from a.objective_hash
 or (new.approved_hash is not null and new.approved_hash is distinct from a.approved_scope)
 then raise exception 'Trial objective, repository, deadline and owner-approved scope are immutable';end if;
 if new.spec is not null and new.spec is distinct from old.spec then
  if exists(select 1 from jsonb_array_elements_text(new.spec->'allowedPaths') path
    where path !~ '^(app|lib|tests)/milestone-3-tic-tac-toe/([a-zA-Z0-9_./-]+)?$'
      or path ~ '(^|/)\.\.?(/|$)')
  or jsonb_array_length(new.spec->'milestones')<>1 then
   raise exception 'Trial requires one coding milestone in the isolated tic-tac-toe paths';
  end if;
  for c in select value->'contract' from jsonb_array_elements(new.spec->'milestones') union all select new.spec->'finalContract' loop
   if c->>'path' is distinct from '/milestone-3-tic-tac-toe'
   or exists(select 1 from jsonb_array_elements(c->'scenarios') s cross join lateral jsonb_array_elements(s->'steps') step
     where step->>'action'='goto' and step->>'path' is distinct from '/milestone-3-tic-tac-toe')
   then raise exception 'Trial browser checks must target the isolated tic-tac-toe route';end if;
  end loop;
 end if;
 return new;
end $$;
create trigger project_provider_scope before update on public.work_projects
for each row execute function public.project_provider_scope_guard();

create function public.project_provider_approve_scope(p_owner uuid,p_project uuid,p_hash text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare p work_projects; a project_provider_execution;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 select * into a from project_provider_execution where project_id=p_project for update;
 if a.owner_id is distinct from p_owner or p_owner is null or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 or p.status is distinct from 'awaiting_approval' or a.deadline<=now()
 or p_hash is distinct from p.approval_hash or p_hash is null
 or (a.approved_scope is not null and a.approved_scope<>p_hash)
 then raise exception 'Exact authenticated owner scope approval required';end if;
 update project_provider_execution set approved_scope=p_hash where project_id=p_project;
 return control_work_project(p.id,p.actor_id,p.chat_id,'approve',p_hash=>p_hash);
end $$;

-- Revalidate operational authority at the provider boundary without reserving spend.
create function public.project_provider_mission_live(p_job uuid,p_lease uuid,p_take_call boolean default false) returns boolean
language plpgsql security definer set search_path=public as $$
declare j mission_assignments; m agent_missions; p work_projects;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_job;
 select * into m from agent_missions where id=j.mission_id;
 select * into p from work_projects where id=m.project_id;
 if not project_provider_mode(p.id) or p.status<>'running' or p.active_mission_id is distinct from m.id
 or m.status<>'running' or j.status<>'running' or p.deadline<=now() or m.deadline<=now()
 or p_lease is null or j.lease is distinct from p_lease or j.lease_until<=now()
 or (p_take_call and m.calls>=m.max_calls) then return false;end if;
 if m.project_kind='management' then
  perform project_org_principal(p_job,p_lease);
 else
  perform project_smart_admit(p_job);
 end if;
 if p_take_call then update agent_missions set calls=calls+1 where id=m.id;end if;
 return true;
end $$;

create function public.project_provider_mission_stop(p_job uuid,p_lease uuid) returns boolean
language plpgsql security definer set search_path=public as $$
declare pid uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select p.id into pid from mission_assignments j join agent_missions m on m.id=j.mission_id
 join work_projects p on p.active_mission_id=m.id and p.id=m.project_id
 where j.id=p_job and p_lease is not null and j.lease=p_lease and j.status='running' and p.status='running' and project_provider_mode(p.id);
 if pid is null then return false;end if;
 update work_projects set status='stopped',lease=null,lease_until=null,
  detail='Provider refused the request or its result is uncertain. Existing evidence is retained.' where id=pid;
 insert into project_events(project_id,event,data) values(pid,'provider_execution_stopped',jsonb_build_object('assignment',p_job));
 return true;
end $$;

create function public.project_provider_dispatch_live(p_task uuid,p_scope text) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(
 select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
 join work_projects p on p.id=m.project_id and p.active_mission_id=m.id
 join project_provider_execution a on a.project_id=p.id
 join agent_tasks t on t.id=j.id and t.agent_id=j.agent_id and t.repository_id=p.repository_id
 join project_runs r on r.mission_id=m.id and r.project_id=p.id
 join project_work_package_attempts attempt on attempt.mission_id=m.id
 join project_work_packages w on w.id=attempt.package_id and w.project_id=p.id and w.scope_hash=p_scope
 join project_organization_nodes n on n.id=w.worker_id and n.agent_id=j.agent_id and n.parent_id=w.manager_id
 join project_worker_admissions admission on admission.assignment_id=j.id
 join project_worker_contracts contract on contract.id=admission.contract_id and contract.package_id=w.id
 join managed_agents agent on agent.id=j.agent_id
 where j.id=p_task and p_scope is not null and p.status='running' and m.status='running' and p.phase='development'
 and p_scope=p.approved_hash and p_scope=p.approval_hash and a.approved_scope=p_scope and r.binding->>'scopeHash'=p_scope
 and p.deadline>now() and m.deadline>now() and a.deadline>now() and w.deadline>now() and n.deadline>now() and contract.deadline>now()
 and j.role='development' and j.status in ('running','waiting_external') and t.kind='development' and t.status in ('dispatching','submitted')
 and t.repository_full_name='mfackrell/katie' and n.kind='worker' and n.status in ('active','accepted')
 and 'development'=any(n.tools) and w.status='running' and contract.scope_hash=p_scope
 and contract.worker_id=n.id and contract.manager_id=w.manager_id and contract.role='development'
 and agent.version=contract.agent_version and not agent.archived and (agent.config->>'development')::boolean
 and admission.fingerprint=project_smart_fingerprint(j) and r.binding->'allowedPaths'=contract.contract->'paths'
 and not exists(select 1 from project_work_package_dependencies d join project_work_packages predecessor on predecessor.id=d.depends_on
  where d.package_id=w.id and predecessor.status<>'accepted')
 )
$$;

create function public.project_provider_dispatch_start(p_task uuid,p_scope text,p_run text) returns boolean
language plpgsql security definer set search_path=public as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if not project_provider_dispatch_live(p_task,p_scope)
 or not exists(select 1 from agent_tasks where id=p_task and external->>'attempted'='true') then return false;end if;
 insert into project_provider_dispatches(task_id,run_id) values(p_task,p_run) on conflict do nothing;
 return found;
end $$;

create function public.project_provider_dispatch_stop(p_task uuid,p_scope text,p_run text) returns boolean
language plpgsql security definer set search_path=public as $$
declare pid uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select p.id into pid from project_provider_dispatches d join mission_assignments j on j.id=d.task_id
 join agent_missions m on m.id=j.mission_id join work_projects p on p.active_mission_id=m.id and p.id=m.project_id
 join project_provider_execution a on a.project_id=p.id and a.approved_scope=p_scope
 where d.task_id=p_task and d.run_id=p_run and p.status='running' and p.approved_hash=p_scope;
 if pid is null then return false;end if;
 update work_projects set status='stopped',lease=null,lease_until=null,
  detail='Coding provider refused the request or its result is uncertain. Existing evidence is retained.' where id=pid;
 insert into project_events(project_id,event,data) values(pid,'provider_execution_stopped',jsonb_build_object('assignment',p_task,'run',p_run));
 return true;
end $$;

revoke all on function public.project_provider_mode(uuid),public.project_provider_enable(uuid,uuid,text),
 public.project_provider_launch(uuid,uuid,uuid),public.project_provider_owner_stop(uuid,uuid,uuid),
 public.project_provider_scope_guard(),public.project_provider_approve_scope(uuid,uuid,text),
 public.project_provider_mission_live(uuid,uuid,boolean),public.project_provider_mission_stop(uuid,uuid),
 public.project_provider_dispatch_live(uuid,text),public.project_provider_dispatch_start(uuid,text,text),
 public.project_provider_dispatch_stop(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.project_provider_mode(uuid),public.project_provider_launch(uuid,uuid,uuid),
 public.project_provider_owner_stop(uuid,uuid,uuid),public.project_provider_approve_scope(uuid,uuid,text),public.project_provider_mission_live(uuid,uuid,boolean),
 public.project_provider_mission_stop(uuid,uuid),public.project_provider_dispatch_live(uuid,text),
 public.project_provider_dispatch_start(uuid,text,text),public.project_provider_dispatch_stop(uuid,text,text) to service_role;

-- Financial fields are absent for provider-controlled packages. Existing rows retain
-- their values and all legacy commands retain their original checks.
alter table public.project_work_packages alter column token_limit drop not null,
 alter column ceiling_microusd drop not null;

-- Patch the installed functions in place so existing authorization, evidence and
-- legacy execution behavior remain intact. Any source drift aborts installation.
do $migration$
declare step record; definition text;
begin
 for step in select * from (values
  ('public.project_org_schedule_hierarchy(uuid,uuid)',$old$if not exists(select 1 from project_organization_authority$old$,$new$if not project_provider_mode(p.id) and not exists(select 1 from project_organization_authority$new$),
  ('public.project_org_schedule_hierarchy(uuid,uuid)',$old$if n.token_limit<10000 then$old$,$new$if not project_provider_mode(p.id) and n.token_limit<10000 then$new$),
  ('public.project_org_schedule_hierarchy(uuid,uuid)',$old$'approvedScopeHash',p.approved_hash),token_allowance=least(60000,n.token_limit)::int,deadline=least(p.deadline,n.deadline)$old$,$new$'approvedScopeHash',p.approved_hash),token_allowance=case when project_provider_mode(p.id) then token_allowance else least(60000,n.token_limit)::int end,deadline=least(p.deadline,n.deadline)$new$),
  ('public.project_org_schedule_hierarchy(uuid,uuid)',$old$update agent_missions set project_id=p.id,project_kind='management',project_evidence=jsonb_build_object('organizationNodeId',n.id,'previousMissionId',previous_mid),team=jsonb_build_array((select to_jsonb(a) from managed_agents a where a.id=n.agent_id)),token_allowance=least(60000,n.token_limit)::int,deadline=least(p.deadline,n.deadline),status='running' where id=mid;$old$,$new$update agent_missions set project_id=p.id,project_kind='management',project_evidence=jsonb_build_object('organizationNodeId',n.id,'previousMissionId',previous_mid),team=jsonb_build_array((select to_jsonb(a) from managed_agents a where a.id=n.agent_id)),token_allowance=case when project_provider_mode(p.id) then token_allowance else least(60000,n.token_limit)::int end,deadline=least(p.deadline,n.deadline),status='running' where id=mid;$new$),
  ('public.project_smart_contract(uuid,uuid,uuid,text,jsonb,uuid,uuid,uuid)',$old$budget+coalesce((select sum(token_limit) from project_worker_contracts where worker_id=w.id),0)>w.token_limit
 or budget+coalesce((select sum(token_limit) from project_worker_contracts where worker_id=w.id),0)>project_org_remaining_tokens(w.id)$old$,$new$(not project_provider_mode(p.id) and (budget+coalesce((select sum(token_limit) from project_worker_contracts where worker_id=w.id),0)>w.token_limit
 or budget+coalesce((select sum(token_limit) from project_worker_contracts where worker_id=w.id),0)>project_org_remaining_tokens(w.id)))$new$),
  ('public.project_smart_contract(uuid,uuid,uuid,text,jsonb,uuid,uuid,uuid)',$old$budget+coalesce((select sum(token_limit) from project_worker_contracts where package_id=pkg.id),0)>pkg.token_limit$old$,$new$(not project_provider_mode(p.id) and (budget+coalesce((select sum(token_limit) from project_worker_contracts where package_id=pkg.id),0)>pkg.token_limit))$new$),
  ('public.project_smart_admit(uuid,bigint)',$old$ select coalesce(sum(tokens),0) into used from ($old$,$new$ if project_provider_mode(p.id) then return;end if;
 select coalesce(sum(tokens),0) into used from ($new$),
  ('public.project_org_decide_hierarchy(uuid,uuid,jsonb)',$old$if allocated+(c->>'tokens')$old$,$new$if not project_provider_mode(p.id) and allocated+(c->>'tokens')$new$),
  ('public.project_org_decide_hierarchy(uuid,uuid,jsonb)',$old$ if exists(select 1 from mission_calls call join mission_assignments j on j.id=call.job_id join agent_missions m on m.id=j.mission_id where m.project_id=p.id and (call.status<>'completed' or call.actual_tokens is null or call.organization_exposure_microusd is null)) then raise exception 'Unresolved project financial exposure';end if;
 if exists(select 1 from benchmark_budget_calls c join benchmark_budget_accounts a on a.id=c.account_id where a.developer_project_id=p.id and c.state<>'settled') then raise exception 'Unresolved native financial exposure';end if;
 if exists(select 1 from benchmark_budget_calls c join benchmark_budget_accounts a on a.id=c.account_id left join benchmark_dollar_exposures e on e.call_id=c.id where a.developer_project_id=p.id and e.call_id is null) then raise exception 'Missing financial exposure evidence';end if;$old$,$new$ if not project_provider_mode(p.id) then
 if exists(select 1 from mission_calls call join mission_assignments j on j.id=call.job_id join agent_missions m on m.id=j.mission_id where m.project_id=p.id and (call.status<>'completed' or call.actual_tokens is null or call.organization_exposure_microusd is null)) then raise exception 'Unresolved project financial exposure';end if;
 if exists(select 1 from benchmark_budget_calls c join benchmark_budget_accounts a on a.id=c.account_id where a.developer_project_id=p.id and c.state<>'settled') then raise exception 'Unresolved native financial exposure';end if;
 if exists(select 1 from benchmark_budget_calls c join benchmark_budget_accounts a on a.id=c.account_id left join benchmark_dollar_exposures e on e.call_id=c.id where a.developer_project_id=p.id and e.call_id is null) then raise exception 'Missing financial exposure evidence';end if;
 end if;$new$),
  ('public.project_org_decide_hierarchy(uuid,uuid,jsonb)',$old$,'missionTokens',(select coalesce(sum(c.actual_tokens),0) from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=p.id),'settledMissionCostUpperBoundMicrousd',(select coalesce(sum(c.organization_exposure_microusd),0) from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=p.id),'nativeRecordedExposureMicrousd',(select coalesce(sum(e.exposure_microusd),0) from benchmark_dollar_exposures e join benchmark_budget_calls c on c.id=e.call_id join benchmark_budget_accounts a on a.id=e.account_id where a.developer_project_id=p.id and c.legacy_mission_call_id is null),'unsettledCalls',0,'costBasis','Mission amounts are conservative verified-price bounds, not supplier invoice amounts'))$old$,$new$)||case when project_provider_mode(p.id) then jsonb_build_object('usageBasis','Provider observations; no internal cost reconciliation required') else jsonb_build_object('missionTokens',(select coalesce(sum(c.actual_tokens),0) from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=p.id),'settledMissionCostUpperBoundMicrousd',(select coalesce(sum(c.organization_exposure_microusd),0) from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=p.id),'nativeRecordedExposureMicrousd',(select coalesce(sum(e.exposure_microusd),0) from benchmark_dollar_exposures e join benchmark_budget_calls c on c.id=e.call_id join benchmark_budget_accounts a on a.id=e.account_id where a.developer_project_id=p.id and c.legacy_mission_call_id is null),'unsettledCalls',0,'costBasis','Mission amounts are conservative verified-price bounds, not supplier invoice amounts') end)$new$),
  ('public.project_package_command(uuid,uuid,jsonb)',$old$or not exists(select 1 from project_organization_authority where project_id=p.id and autonomous_execution)$old$,$new$or (not project_provider_mode(p.id) and not exists(select 1 from project_organization_authority where project_id=p.id and autonomous_execution))$new$),
  ('public.project_package_command(uuid,uuid,jsonb)',$old$(c->>'tokens')::bigint<=60000 or (c->>'tokens')::bigint+coalesce((select sum(token_limit) from project_work_packages where manager_id=n.id),0)>n.token_limit
 or (c->>'ceilingMicrousd')::numeric<=0 or (c->>'ceilingMicrousd')::numeric>(select ceiling_microusd from project_organization_authority where project_id=p.id)$old$,$new$(not project_provider_mode(p.id) and (c->>'tokens' is null or c->>'ceilingMicrousd' is null or (c->>'tokens')::bigint<=60000 or (c->>'tokens')::bigint+coalesce((select sum(token_limit) from project_work_packages where manager_id=n.id),0)>n.token_limit
 or (c->>'ceilingMicrousd')::numeric<=0 or (c->>'ceilingMicrousd')::numeric>(select ceiling_microusd from project_organization_authority where project_id=p.id)))$new$),
  ('public.project_package_command(uuid,uuid,jsonb)',$old$(c->>'tokens')::bigint,(c->>'ceilingMicrousd')::numeric,(c->>'deadline')::timestamptz$old$,$new$case when not project_provider_mode(p.id) then (c->>'tokens')::bigint end,case when not project_provider_mode(p.id) then (c->>'ceilingMicrousd')::numeric end,(c->>'deadline')::timestamptz$new$),
  ('public.project_package_command(uuid,uuid,jsonb)',$old$(project_package_usage(w.id)->>'tokens')::bigint>w.token_limit or (project_package_usage(w.id)->>'cost')::numeric>w.ceiling_microusd$old$,$new$(not project_provider_mode(p.id) and ((project_package_usage(w.id)->>'tokens')::bigint>w.token_limit or (project_package_usage(w.id)->>'cost')::numeric>w.ceiling_microusd))$new$),
  ('public.project_package_command(uuid,uuid,jsonb)',$old$(project_package_usage(w.id)->>'tokens')::bigint>=w.token_limit or (project_package_usage(w.id)->>'cost')::numeric>=w.ceiling_microusd$old$,$new$(not project_provider_mode(p.id) and ((project_package_usage(w.id)->>'tokens')::bigint>=w.token_limit or (project_package_usage(w.id)->>'cost')::numeric>=w.ceiling_microusd))$new$),
  ('public.project_package_command(uuid,uuid,jsonb)',$old$exists(select 1 from mission_calls call join mission_assignments job on job.id=call.job_id where job.mission_id=mid and (call.status<>'completed' or call.actual_tokens is null))
 or exists(select 1 from benchmark_budget_calls call join benchmark_budget_accounts acct on acct.id=call.account_id join mission_assignments job on job.id=acct.developer_task_id where job.mission_id=mid and call.state<>'settled')$old$,$new$(not project_provider_mode(p.id) and (exists(select 1 from mission_calls call join mission_assignments job on job.id=call.job_id where job.mission_id=mid and (call.status<>'completed' or call.actual_tokens is null))
 or exists(select 1 from benchmark_budget_calls call join benchmark_budget_accounts acct on acct.id=call.account_id join mission_assignments job on job.id=acct.developer_task_id where job.mission_id=mid and call.state<>'settled')))$new$),
  ('public.project_package_command(uuid,uuid,jsonb)',$old$if exists(select 1 from benchmark_budget_calls call join benchmark_budget_accounts a on a.id=call.account_id join mission_assignments job on job.id=a.developer_task_id where job.mission_id=mid and call.state<>'settled')$old$,$new$if not project_provider_mode(p.id) and exists(select 1 from benchmark_budget_calls call join benchmark_budget_accounts a on a.id=call.account_id join mission_assignments job on job.id=a.developer_task_id where job.mission_id=mid and call.state<>'settled')$new$),
  ('public.finish_work_project_lifecycle(uuid,uuid,text,jsonb)',$old$token_allowance=least(120000,p.token_allowance,coalesce(wp.token_limit-(project_package_usage(wp.id)->>'tokens')::bigint,120000))::int$old$,$new$token_allowance=case when project_provider_mode(p.id) then token_allowance else least(120000,p.token_allowance,coalesce(wp.token_limit-(project_package_usage(wp.id)->>'tokens')::bigint,120000))::int end$new$),
  ('public.finish_work_project_lifecycle(uuid,uuid,text,jsonb)',$old$  update work_projects set spec=p_data->'spec',repository_full_name=$old$,$new$  if project_provider_mode(p.id) then scope_data:=scope_data-'token_allowance';end if;
  update work_projects set spec=p_data->'spec',repository_full_name=$new$),
  ('public.claim_project_dispatch(uuid,uuid,text)',$old$if p_lease is null or j.lease is null or j.lease_until is null or m.deadline is null or p.deadline is null or m.calls>=m.max_calls$old$,$new$if project_provider_mode(p.id) then
 if p_lease is null or j.lease is distinct from p_lease or j.lease_until is null or j.lease_until<=now() or not project_provider_dispatch_live(p_id,p_hash) then return false;end if;
 elsif p_lease is null or j.lease is null or j.lease_until is null or m.deadline is null or p.deadline is null or m.calls>=m.max_calls$new$),
  ('public.recover_project_development_dispatch(uuid)',$old$ IF NOT FOUND OR p.phase<>'development'$old$,$new$ IF NOT FOUND OR project_provider_mode(p.id) OR p.phase<>'development'$new$),
  ('public.project_org_authorize(uuid,uuid,text,numeric,numeric,boolean)',$old$if exists(select 1 from project_organization_authority where project_id=p.id) then$old$,$new$if project_provider_mode(p.id) then raise exception 'Trial uses provider account controls';end if;
 if exists(select 1 from project_organization_authority where project_id=p.id) then$new$),
  ('public.project_scope_proposal(uuid)',$old$||p.token_allowance||' aggregate project-model tokens; deadline '||p.deadline$old$,$new$||case when project_provider_mode(p.id) then 'provider account controls; deadline ' else p.token_allowance||' aggregate project-model tokens; deadline ' end||p.deadline$new$),
  ('public.project_scope_proposal(uuid)',$old$Reply **approve project '||left(p.approval_hash,12)||'** to authorize this saved scope once.$old$,$new$'||case when project_provider_mode(p.id) then 'Authenticate as owner and approve this exact scope.' else 'Reply **approve project '||left(p.approval_hash,12)||'** to authorize this saved scope once.' end||'$new$)
 ) as patch(signature, before_text, after_text) loop
  select pg_get_functiondef(step.signature::regprocedure) into strict definition;
  if strpos(definition,step.before_text)=0
    or strpos(substr(definition,strpos(definition,step.before_text)+length(step.before_text)),step.before_text)>0
  then raise exception 'Trial migration expected one source match in %',step.signature;end if;
  execute replace(definition,step.before_text,step.after_text);
 end loop;
end
$migration$;

commit;

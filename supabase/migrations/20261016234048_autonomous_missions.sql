-- Mission execution is additive to existing actors and approved agent tasks.
create table public.agent_missions (
 id uuid primary key, objective text not null check(length(trim(objective)) between 1 and 12000),
 team jsonb not null check(jsonb_typeof(team)='array' and jsonb_array_length(team) between 1 and 3),
 status text not null default 'draft' check(status in ('draft','running','awaiting_approval','completed','blocked','stopped')),
 max_calls integer not null default 12 check(max_calls between 2 and 20),
 token_allowance integer not null default 60000 check(token_allowance between 10000 and 120000),
 reserved_tokens integer not null default 0, calls integer not null default 0,
 actual_tokens integer not null default 0, max_minutes integer not null default 20 check(max_minutes between 5 and 120),
 deadline timestamptz, result text, detail text, repository_id uuid references public.repo_sync_runs(id) on delete restrict,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.mission_assignments (
 id uuid primary key default gen_random_uuid(), mission_id uuid not null references public.agent_missions(id) on delete restrict,
 job_key text not null check(length(job_key) between 1 and 50),
 role text not null check(role in ('plan','work','compose','review','revise','development')),
 agent_id uuid not null references public.managed_agents(id) on delete restrict,
 instruction text not null check(length(instruction) between 1 and 5000),
 dependencies text[] not null default '{}', payload jsonb not null default '{}',
 status text not null default 'queued' check(status in ('queued','running','waiting_external','awaiting_approval','completed','failed','stopped')),
 attempts integer not null default 0,lease uuid,lease_until timestamptz,heartbeat_at timestamptz,
 available_at timestamptz not null default now(),result jsonb,detail text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(mission_id,job_key)
);
create index mission_assignment_claim on public.mission_assignments(status,available_at);
create index mission_assignment_mission on public.mission_assignments(mission_id);
create index agent_missions_repo on public.agent_missions(repository_id);
create table public.mission_calls (
 id uuid primary key,job_id uuid not null references public.mission_assignments(id) on delete restrict,
 lease uuid not null, model text not null, reserved_tokens integer not null, actual_tokens integer,
 status text not null default 'reserved' check(status in ('reserved','completed','uncertain')),
 created_at timestamptz not null default now()
);
create index mission_calls_job on public.mission_calls(job_id);
alter table public.agent_missions enable row level security;
alter table public.mission_assignments enable row level security;
alter table public.mission_calls enable row level security;
revoke all on public.agent_missions,public.mission_assignments,public.mission_calls from public,anon,authenticated,service_role;
grant select,insert,update on public.agent_missions,public.mission_assignments,public.mission_calls to service_role;


-- Count a mission's external coding task once, and serialize admission with the
-- pre-existing managed-task RPC on the same managed-agent row lock.
create function public.active_managed_work(p_agent uuid,p_exclude uuid default null) returns bigint
language sql stable security invoker set search_path=public as $$
 select (select count(*) from agent_tasks t where t.agent_id=p_agent and t.id is distinct from p_exclude and t.status in ('running','pending','dispatching','submitted'))
 + (select count(*) from mission_assignments j join agent_missions m on m.id=j.mission_id where j.agent_id=p_agent and j.id is distinct from p_exclude and j.status='running' and j.lease_until>now() and m.status in ('running','awaiting_approval')
 and not exists(select 1 from agent_tasks t where t.id=j.id and t.status in ('running','pending','dispatching','submitted')));
$$;
revoke all on function public.active_managed_work(uuid,uuid) from public,anon,authenticated;
grant execute on function public.active_managed_work(uuid,uuid) to service_role;

create function public.create_mission(p_id uuid,p_objective text,p_agents uuid[],p_minutes integer default 20,p_repository uuid default null) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare m agent_missions; team_data jsonb; n integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 -- Serialize creation retries, including a retry racing the initial insert.
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into m from agent_missions where id=p_id;
 if found then
  if m.objective is distinct from p_objective or m.max_minutes is distinct from p_minutes or m.repository_id is distinct from p_repository
   or (select array_agg((v->>'id')::uuid order by v->>'id') from jsonb_array_elements(m.team) v) is distinct from (select array_agg(x order by x) from unnest(p_agents) x)
  then raise exception 'Mission identity conflict'; end if;
  return to_jsonb(m);
 end if;
 if cardinality(p_agents) not between 1 and 3 or cardinality(p_agents)<>(select count(distinct x) from unnest(p_agents) x) then raise exception 'Choose one to three distinct saved agents'; end if;
 select jsonb_agg(to_jsonb(a) order by array_position(p_agents,a.id)),count(*) into team_data,n from managed_agents a where id=any(p_agents) and not archived;
 if n<>cardinality(p_agents) then raise exception 'Agent unavailable'; end if;
 if exists(select 1 from jsonb_array_elements(team_data) a where length(p_objective)>(a->'config'->>'maxInputChars')::integer) then raise exception 'Objective exceeds saved agent input limit'; end if;
 if p_repository is not null and not exists(select 1 from repo_sync_runs where id=p_repository) then raise exception 'Repository unavailable'; end if;
 insert into agent_missions(id,objective,team,max_minutes,repository_id) values(p_id,p_objective,team_data,p_minutes,p_repository) returning * into m;
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction) values(m.id,'plan','plan',p_agents[1],'Decompose the objective into bounded assignments and verifiable deliverables.');
 return to_jsonb(m);
end $$;

create function public.control_mission(p_id uuid,p_action text,p_job uuid default null) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare m agent_missions;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into m from agent_missions where id=p_id for update;
 if not found then raise exception 'Mission missing'; end if;
 if p_action='start' and m.status='draft' then
  update agent_missions set status='running',deadline=now()+make_interval(mins=>max_minutes),updated_at=now() where id=p_id returning * into m;
 elsif p_action='stop' and m.status in ('draft','running','awaiting_approval') then
  update agent_missions set status='stopped',detail='Stopped. No new work will be dispatched. An in-flight provider or accepted GitHub job may still finish.',updated_at=now() where id=p_id returning * into m;
  update mission_assignments set status='stopped',lease=null,lease_until=null,updated_at=now() where mission_id=p_id and status<>'completed';
 elsif p_action='approve' and m.status='awaiting_approval' and m.deadline>now() then
  update mission_assignments set status='queued',payload=payload||'{"approved":true}'::jsonb,available_at=now(),attempts=0,updated_at=now() where id=p_job and mission_id=p_id and role='development' and status='awaiting_approval';
  if not found then raise exception 'Approval target unavailable'; end if;
  update agent_missions set status='running',detail='Saved development assignment approved for draft PR only.',updated_at=now() where id=p_id returning * into m;
 elsif not ((p_action='start' and m.status<>'draft') or (p_action='stop' and m.status='stopped')) then raise exception 'Transition unavailable';
 end if;
 return to_jsonb(m);
end $$;

create function public.claim_mission_work() returns jsonb
language plpgsql security invoker set search_path=public as $$
declare j mission_assignments;m agent_missions;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 -- One bounded global claim lock; no overlapping cron can exceed three workers.
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 update agent_missions set status='blocked',detail='Mission deadline reached. Inspect partial results; no new work will start.',updated_at=now() where status in ('running','awaiting_approval') and deadline<=now();
 update mission_assignments j0 set status=case when attempts<2 then 'queued' else 'failed' end,lease=null,lease_until=null,detail='Worker lease expired; prior model-call reservation remains charged.',updated_at=now()
 where j0.status='running' and lease_until<=now();
 update agent_missions m0 set status='blocked',detail='An assignment exhausted recovery attempts.',updated_at=now() where m0.status='running' and exists(select 1 from mission_assignments a where a.mission_id=m0.id and a.status='failed');
 if (select count(*) from mission_assignments a join agent_missions b on b.id=a.mission_id where a.status='running' and a.lease_until>now() and b.status in ('running','awaiting_approval'))>=3 then return null; end if;
 select a.* into j from mission_assignments a join agent_missions b on b.id=a.mission_id
 where b.status='running' and a.status in ('queued','waiting_external') and a.available_at<=now()
 and active_managed_work(a.agent_id,a.id) < least((select (v->'config'->>'maxActiveTasks')::integer from jsonb_array_elements(b.team) v where v->>'id'=a.agent_id::text),(select (config->>'maxActiveTasks')::integer from managed_agents where id=a.agent_id))
 and not exists(select 1 from unnest(a.dependencies) dep where not exists(select 1 from mission_assignments d where d.mission_id=a.mission_id and d.job_key=dep and d.status='completed'))
 order by a.created_at,a.job_key limit 1 for update of a skip locked;
 if not found then return null; end if;
 select * into m from agent_missions where id=j.mission_id for update;
 if m.status<>'running' or m.deadline<=now() then return null; end if;
 perform 1 from managed_agents where id=j.agent_id for update;
 if active_managed_work(j.agent_id,j.id)>=least((select (v->'config'->>'maxActiveTasks')::integer from jsonb_array_elements(m.team) v where v->>'id'=j.agent_id::text),(select (config->>'maxActiveTasks')::integer from managed_agents where id=j.agent_id)) then return null; end if;
 update mission_assignments set status='running',attempts=case when status='waiting_external' then attempts else attempts+1 end,lease=gen_random_uuid(),lease_until=now()+interval '6 minutes',heartbeat_at=now(),updated_at=now() where id=j.id returning * into j;
 return jsonb_build_object('job',to_jsonb(j),'mission',to_jsonb(m));
end $$;

create function public.reserve_mission_call(p_id uuid,p_lease uuid,p_call uuid,p_model text,p_tokens integer) returns boolean
language plpgsql security invoker set search_path=public as $$
declare j mission_assignments;m agent_missions;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_id;
 if not found then return false; end if;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into j from mission_assignments where id=p_id for update;
 if m.status not in ('running','awaiting_approval') or m.deadline<=now() or j.status<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then return false; end if;
 if p_tokens not between 1 and 120000 or exists(select 1 from mission_calls where id=p_call) then return false; end if;
 if m.calls>=m.max_calls or greatest(m.reserved_tokens,m.actual_tokens)+p_tokens>m.token_allowance then
  update agent_missions set status='blocked',detail='Model-call or reserved token allowance exhausted. Inspect partial results.',updated_at=now() where id=m.id;
  return false;
 end if;
 insert into mission_calls(id,job_id,lease,model,reserved_tokens) values(p_call,j.id,p_lease,p_model,p_tokens);
 update agent_missions set calls=calls+1,reserved_tokens=reserved_tokens+p_tokens,updated_at=now() where id=m.id;
 update mission_assignments set heartbeat_at=now(),lease_until=now()+interval '6 minutes' where id=j.id;
 return true;
end $$;

create function public.finish_mission_call(p_call uuid,p_tokens integer) returns void
language plpgsql security invoker set search_path=public as $$
declare c mission_calls;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into c from mission_calls where id=p_call for update;
 if not found or c.status<>'reserved' then return; end if;
 if p_tokens is null then update mission_calls set status='uncertain' where id=p_call;return; end if;
 if p_tokens<0 then raise exception 'Invalid usage'; end if;
 update mission_calls set actual_tokens=p_tokens,status='completed' where id=p_call;
 update agent_missions set actual_tokens=actual_tokens+p_tokens,reserved_tokens=reserved_tokens-c.reserved_tokens+p_tokens where id=(select mission_id from mission_assignments where id=c.job_id);
end $$;

create function public.commit_mission_work(p_id uuid,p_lease uuid,p_result jsonb,p_children jsonb default '[]',p_status text default 'completed',p_mission_status text default null,p_final text default null) returns boolean
language plpgsql security invoker set search_path=public as $$
declare j mission_assignments;m agent_missions;c jsonb; n integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_id;
 if not found then return false; end if;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into j from mission_assignments where id=p_id for update;
 if m.status not in ('running','awaiting_approval') or m.deadline<=now() or j.status<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then return false; end if;
 if p_status not in ('completed','waiting_external','awaiting_approval','failed','queued') or (p_mission_status is not null and p_mission_status not in ('completed','blocked','awaiting_approval')) then raise exception 'Invalid outcome'; end if;
 if jsonb_typeof(p_children)<>'array' or jsonb_array_length(p_children)>6 then raise exception 'Invalid children'; end if;
 n:=(select count(*) from mission_assignments where mission_id=m.id and role<>'plan');
 if n+jsonb_array_length(p_children)>6 then raise exception 'Assignment limit reached'; end if;
 for c in select value from jsonb_array_elements(p_children) loop
  if not exists(select 1 from jsonb_array_elements(m.team) a where a->>'id'=c->>'agent_id') then raise exception 'Agent outside saved team'; end if;
  insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload)
  values(m.id,c->>'key',c->>'role',(c->>'agent_id')::uuid,c->>'instruction',array(select jsonb_array_elements_text(coalesce(c->'dependencies','[]'))),coalesce(c->'payload','{}'));
 end loop;
 -- Every dependency must be in this mission. Planner validates acyclicity too.
 if exists(select 1 from mission_assignments a,unnest(a.dependencies) d where a.mission_id=m.id and (d=a.job_key or not exists(select 1 from mission_assignments b where b.mission_id=m.id and b.job_key=d))) then raise exception 'Invalid dependency'; end if;
 update mission_assignments set status=p_status,result=p_result,detail=p_result->>'detail',lease=null,lease_until=null,available_at=now()+interval '1 minute',updated_at=now() where id=j.id;
 if p_status='awaiting_approval' then p_mission_status:='awaiting_approval'; end if;
 if p_status='failed' then p_mission_status:='blocked'; end if;
 if p_mission_status='completed' and (j.role<>'review' or p_result->>'verdict' is distinct from 'pass' or p_status<>'completed' or coalesce(length(p_final),0)=0 or exists(select 1 from mission_assignments where mission_id=m.id and status<>'completed')) then raise exception 'Verified deliverable required'; end if;
 update agent_missions set status=coalesce(p_mission_status,status),result=coalesce(p_final,result),detail=coalesce(p_result->>'detail',detail),updated_at=now() where id=m.id;
 return true;
end $$;

revoke all on function public.create_mission(uuid,text,uuid[],integer,uuid),public.control_mission(uuid,text,uuid),public.claim_mission_work(),public.reserve_mission_call(uuid,uuid,uuid,text,integer),public.finish_mission_call(uuid,integer),public.commit_mission_work(uuid,uuid,jsonb,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.create_mission(uuid,text,uuid[],integer,uuid),public.control_mission(uuid,text,uuid),public.claim_mission_work(),public.reserve_mission_call(uuid,uuid,uuid,text,integer),public.finish_mission_call(uuid,integer),public.commit_mission_work(uuid,uuid,jsonb,jsonb,text,text,text) to service_role;

create function public.mission_development_task(p_job uuid,p_lease uuid) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare j mission_assignments;m agent_missions;a jsonb;t agent_tasks;created jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_job;
 if not found then raise exception 'Assignment missing'; end if;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into j from mission_assignments where id=p_job for update;
 if m.status<>'running' or m.deadline<=now() or j.role<>'development' or j.status<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() or j.payload->>'approved' is distinct from 'true' then raise exception 'Development approval unavailable'; end if;
 select v into a from jsonb_array_elements(m.team) v where v->>'id'=j.agent_id::text;
 if not (a->'config'->>'development')::boolean then raise exception 'Development permission denied'; end if;
 select * into t from agent_tasks where id=j.id;
 if found then
  if t.agent_id<>j.agent_id or t.repository_id is distinct from m.repository_id or t.initial_input<>j.instruction or t.snapshot<>a->'config' then raise exception 'Development task identity conflict'; end if;
  return to_jsonb(t);
 end if;
 -- Preserve normal lock ordering and reject changed definitions rather than
 -- silently approving a different actor configuration after mission creation.
 perform 1 from managed_agents where id=j.agent_id and config=a->'config' and version=(a->>'version')::integer and not archived for update;
 if not found then raise exception 'Agent changed; create a new mission to approve its new configuration'; end if;
 created:=create_agent_task(j.id,j.agent_id,j.instruction,'development',m.repository_id);
 return created;
end $$;
revoke all on function public.mission_development_task(uuid,uuid) from public,anon,authenticated;
grant execute on function public.mission_development_task(uuid,uuid) to service_role;

-- Preserve the existing transition contract; extend only admission accounting.
create or replace function public.transition_agent_task(p_id uuid,p_action text,p_message text default null,p_turn uuid default null,p_expected_request text default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare a managed_agents; t agent_tasks; n integer; receipt agent_task_continuations;
begin
 select a0.* into a from managed_agents a0 join agent_tasks t0 on t0.agent_id=a0.id where t0.id=p_id for update of a0;
 if not found then raise exception 'Task missing'; end if;
 select * into t from agent_tasks where id=p_id for update;
 perform 1 from chats where id=t.chat_id and actor_id=t.actor_id for key share;
 if not found or a.actor_id<>t.actor_id then raise exception 'Task association invalid'; end if;
 if p_action='start' then
  if a.archived then raise exception 'Agent archived'; end if;
  if t.status<>'draft' then return to_jsonb(t); end if;
 elsif p_action='continue' then
  if p_turn is null or p_expected_request is null or length(p_expected_request) not between 1 and 128 then raise exception 'Continuation identity required'; end if;
  select * into receipt from agent_task_continuations where task_id=p_id and turn_id=p_turn;
  if found then
   if receipt.input is distinct from p_message or receipt.base_request_id is distinct from p_expected_request then raise exception 'Continuation id conflict'; end if;
   -- Return the original receipt even after completion or later turns. Never admit it twice.
   return to_jsonb(t)||jsonb_build_object('continuation_receipt',to_jsonb(receipt));
  end if;
  if t.request_id<>p_expected_request then raise exception 'Task advanced; refresh before submitting a new continuation'; end if;
  if a.archived or t.kind<>'general' or t.status not in ('completed','pending','failed') then raise exception 'Task cannot continue'; end if;
  if length(trim(p_message))<1 or length(p_message)>(t.snapshot->>'maxInputChars')::integer then raise exception 'Invalid continuation'; end if;
  t.input:=p_message; t.request_id:='agent:'||gen_random_uuid()::text;
 else raise exception 'Invalid transition'; end if;
 select public.active_managed_work(a.id,t.id) into n;
 if n>=least((a.config->>'maxActiveTasks')::integer,(t.snapshot->>'maxActiveTasks')::integer) then raise exception 'Active task limit reached'; end if;
 if p_action='continue' then
  insert into agent_task_continuations(task_id,turn_id,input,base_request_id,request_id)
  values(t.id,p_turn,p_message,p_expected_request,t.request_id) returning * into receipt;
 end if;
 update agent_tasks set input=t.input,request_id=t.request_id,execution_claimed_at=null,execution_request_id=null,status=case when kind='development' then 'dispatching' else 'running' end,details=case when kind='development' then 'Approved; verifying owner credentials before submission.' else 'Execution admitted; waiting for durable runtime status.' end,updated_at=now() where id=t.id returning * into t;
 return to_jsonb(t)||case when p_action='continue' then jsonb_build_object('continuation_receipt',to_jsonb(receipt)) else '{}'::jsonb end;
end $$;

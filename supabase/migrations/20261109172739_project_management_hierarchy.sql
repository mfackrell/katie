-- Additive organization control. Existing project/mission/financial gates remain authoritative.
-- Historical projects receive ownership metadata only, never new authority.
alter table work_projects add column organization_version integer not null default 0 check(organization_version in (0,1));
alter table work_projects alter column organization_version set default 1;
alter table work_projects drop constraint work_projects_max_missions_check;
alter table work_projects add constraint work_projects_max_missions_check check(max_missions>=1 and (organization_version=1 or max_missions<=16));
alter table work_projects alter column max_missions set default 64;
create table project_organization_nodes (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references work_projects(id),
 parent_id uuid references project_organization_nodes(id), agent_id uuid not null references managed_agents(id),
 kind text not null check(kind in ('project_director','manager','worker')),
 area text not null default 'general', name text not null, objective text not null check(length(objective) between 1 and 8000),
 acceptance jsonb not null check(jsonb_typeof(acceptance)='array' and jsonb_array_length(acceptance) between 1 and 30),
 scope_paths text[] not null default '{}', tools text[] not null default '{}',
 token_limit bigint not null check(token_limit>0), deadline timestamptz not null,
 depth integer not null default 0, decision_needed boolean not null default true,
 scope_hash text, status text not null default 'active' check(status in ('active','accepted','blocked')),
 evidence jsonb, created_at timestamptz not null default now(),
 unique(project_id,agent_id), check((kind='project_director')=(parent_id is null))
);
alter table project_organization_nodes add column management_contract jsonb not null default '{}';
create unique index project_one_director on project_organization_nodes(project_id) where kind='project_director';
create table project_organization_plans (
 node_id uuid primary key references project_organization_nodes(id), objective_hash text not null,
 purpose text not null, direction text not null, outcomes jsonb not null, milestones jsonb not null,
 organizations jsonb not null, updated_at timestamptz not null default now()
);
create table project_organization_leadership (
 node_id uuid not null references project_organization_nodes(id), agent_id uuid not null unique references managed_agents(id),
 appointed_at timestamptz not null default now(), superseded_at timestamptz, primary key(node_id,agent_id)
);
create table project_organization_decisions (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references work_projects(id),
 node_id uuid not null references project_organization_nodes(id), assignment_id uuid not null unique references mission_assignments(id),
 decision jsonb not null, created_at timestamptz not null default now()
);
create table project_organization_assignments (
 assignment_id uuid primary key references mission_assignments(id), node_id uuid not null references project_organization_nodes(id),
 contract_hash text not null, created_at timestamptz not null default now()
);
create table project_organization_exceptions (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references work_projects(id),
 origin_id uuid not null references project_organization_nodes(id), owner_id uuid not null references project_organization_nodes(id),
 reason text not null check(reason in ('routine','authority','scope','resources','dependency','security','objective')),
 detail text not null, status text not null default 'open' check(status in ('open','resolved','owner_required')),
 resolution text, created_at timestamptz not null default now()
);
create table project_organization_dependencies (
 project_id uuid not null references work_projects(id), node_id uuid not null references project_organization_nodes(id),
 depends_on uuid not null references project_organization_nodes(id), primary key(node_id,depends_on), check(node_id<>depends_on)
);
create table project_organization_closures (
 project_id uuid primary key references work_projects(id), director_id uuid not null references project_organization_nodes(id),
 decision_id uuid not null references project_organization_decisions(id), scope_hash text not null, head_sha text not null,
 receipt jsonb not null, created_at timestamptz not null default now()
);
create table project_organization_scope_grants (
 node_id uuid not null references project_organization_nodes(id), scope_hash text not null,
 paths text[] not null, parent_id uuid references project_organization_nodes(id), primary key(node_id,scope_hash)
);
create table project_organization_work (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references work_projects(id),
 node_id uuid not null references project_organization_nodes(id), decision_id uuid not null references project_organization_decisions(id),
 capability text not null check(capability in ('analysis','research','writing','repository_review')),
 instruction text not null check(length(instruction) between 1 and 5000),
 mission_id uuid unique references agent_missions(id), status text not null default 'queued' check(status in ('queued','running','completed','blocked')),
 created_at timestamptz not null default now()
);
-- The original owner approves a management ceiling once; this is an additional
-- bound on existing mission reservations, never a replacement provider ledger.
create table project_organization_authority (
 project_id uuid primary key references work_projects(id), owner_id uuid not null,
 objective_hash text not null, ceiling_microusd numeric not null check(ceiling_microusd>0),
 per_call_microusd numeric not null check(per_call_microusd>0 and per_call_microusd<=ceiling_microusd),
 autonomous_execution boolean not null default false,
 created_at timestamptz not null default now()
);
create table project_organization_native_delegations (
 task_id uuid primary key references agent_tasks(id), project_id uuid not null references work_projects(id),
 node_id uuid not null references project_organization_nodes(id), scope_hash text not null,
 authority_objective_hash text not null, proposal_id text not null, approval_id uuid,
 limits jsonb not null, created_at timestamptz not null default now()
);
alter table mission_calls add column organization_exposure_microusd numeric;
alter table mission_calls add column organization_unit_microusd numeric;
-- Service workers can read; mutations are possible only through the fenced functions below.
do $$ declare t text; begin
 foreach t in array array['project_organization_nodes','project_organization_decisions','project_organization_assignments','project_organization_exceptions','project_organization_dependencies','project_organization_closures','project_organization_authority','project_organization_work','project_organization_scope_grants','project_organization_native_delegations','project_organization_plans','project_organization_leadership'] loop
 execute format('alter table %I enable row level security',t);
 execute format('revoke all on %I from public,anon,authenticated,service_role',t);
 execute format('grant select on %I to service_role',t);
 end loop;
end $$;

create function project_org_identity_guard() returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op='DELETE' or (new.project_id,new.kind,new.token_limit,new.deadline,new.scope_paths,new.tools,new.objective,new.acceptance,new.area,new.management_contract)
 is distinct from (old.project_id,old.kind,old.token_limit,old.deadline,old.scope_paths,old.tools,old.objective,old.acceptance,old.area,old.management_contract)
 then raise exception 'Organizational identity and delegated authority are immutable'; end if;
 if (new.parent_id,new.agent_id,new.depth) is distinct from (old.parent_id,old.agent_id,old.depth) and current_user in ('service_role','anon','authenticated') then raise exception 'Reporting and leadership changes require a management decision';end if;
 if new.parent_id is distinct from old.parent_id and (not exists(select 1 from project_organization_nodes where id=new.parent_id and project_id=new.project_id and kind<>'worker') or exists(with recursive chain(id,parent_id) as(select id,parent_id from project_organization_nodes where id=new.parent_id union all select x.id,x.parent_id from project_organization_nodes x join chain c on x.id=c.parent_id) select 1 from chain where id=new.id)) then raise exception 'Circular or invalid reporting relationship';end if;
 return new;
end $$;
create trigger project_org_immutable before update or delete on project_organization_nodes for each row execute function project_org_identity_guard();

create function project_org_leadership_record() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.kind<>'worker' then insert into project_organization_leadership(node_id,agent_id) values(new.id,new.agent_id);end if;return new;
end $$;
create trigger project_org_leadership after insert on project_organization_nodes for each row execute function project_org_leadership_record();

create function project_org_bootstrap() returns trigger language plpgsql security definer set search_path=public as $$
declare a jsonb; begin
 a:=save_managed_agent(null,jsonb_build_object('name','Project Director','instructions','Manage the complete original project. Delegate technical work. Never execute implementation or research. Certify only evidence-backed outcomes.','research',false,'development',false,'attachments',false,'reviewMode','always','maxActiveTasks',1,'maxInputChars',16000),false);
 insert into project_organization_nodes(project_id,agent_id,kind,name,objective,acceptance,token_limit,deadline,tools)
 values(new.id,(a->>'id')::uuid,'project_director','Project Director',new.objective,jsonb_build_array(new.objective),new.token_allowance,new.deadline,array['manage','analysis','research','development','repository_review']);
 return new;
end $$;
create trigger project_org_create after insert on work_projects for each row execute function project_org_bootstrap();
-- Backfill only ownership, keeping all legacy lifecycle routing and records unchanged.
do $$ declare p work_projects; a jsonb; begin
 for p in select * from work_projects loop
 a:=save_managed_agent(null,jsonb_build_object('name','Project Director','instructions','Accountable management owner. Historical authority remains unchanged. Never execute technical work.','research',false,'development',false,'attachments',false,'reviewMode','always','maxActiveTasks',1,'maxInputChars',16000),false);
 insert into project_organization_nodes(project_id,agent_id,kind,name,objective,acceptance,token_limit,deadline,decision_needed)
 values(p.id,(a->>'id')::uuid,'project_director','Project Director',p.objective,jsonb_build_array(p.objective),p.token_allowance,p.deadline,false);
 end loop;
end $$;

create function project_org_agent_guard() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from project_organization_leadership where agent_id=old.id) and
 (new.config is distinct from old.config or new.actor_id is distinct from old.actor_id or new.archived is distinct from old.archived)
 then raise exception 'Management identity cannot be reconfigured as execution';end if;
 return new;
end $$;
create trigger project_org_agent_immutable before update on managed_agents for each row execute function project_org_agent_guard();
create function project_org_execution_guard() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from project_organization_leadership where agent_id=new.agent_id) then
 if tg_table_name='agent_tasks' then raise exception 'Management agents cannot create execution tasks';end if;
 if not exists(select 1 from agent_missions m join work_projects p on p.id=m.project_id
 join project_organization_nodes n on n.project_id=p.id and n.agent_id=new.agent_id and n.kind<>'worker'
 where m.id=new.mission_id and m.project_kind='management' and p.active_mission_id=m.id
 and new.role='work' and new.payload->>'organizationNodeId'=n.id::text)
 then raise exception 'Management agents cannot execute technical assignments';end if;
 end if;return new;
end $$;
create trigger project_org_task_guard before insert or update on agent_tasks for each row execute function project_org_execution_guard();
create trigger project_org_assignment_guard before insert or update on mission_assignments for each row execute function project_org_execution_guard();

create function project_org_version_guard() returns trigger language plpgsql set search_path=public as $$
begin
 if new.organization_version is distinct from old.organization_version then raise exception 'Organization enforcement cannot be disabled';end if;return new;
end $$;
create trigger project_org_version before update on work_projects for each row execute function project_org_version_guard();
create function project_org_authorize(p_owner uuid,p_project uuid,p_objective_hash text,p_ceiling numeric,p_per_call numeric,p_autonomous boolean default false) returns boolean
language plpgsql security definer set search_path=public as $$
declare p work_projects;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project and organization_version=1 and status not in ('completed','stopped','failed') and deadline>now();
 if p.id is null or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 or p_objective_hash is distinct from encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')
 or p_ceiling is null or p_per_call is null or p_ceiling<=0 or p_per_call<=0 or p_per_call>p_ceiling or p_ceiling>1000000000
 then raise exception 'Exact owner-approved objective and financial ceiling required';end if;
 if exists(select 1 from project_organization_authority where project_id=p.id) then
 if not exists(select 1 from project_organization_authority where project_id=p.id and owner_id=p_owner and objective_hash=p_objective_hash and ceiling_microusd=p_ceiling and per_call_microusd=p_per_call and autonomous_execution=p_autonomous) then raise exception 'Existing authority cannot be silently amended';end if;
 return true;end if;
 insert into project_organization_authority values(p.id,p_owner,p_objective_hash,p_ceiling,p_per_call,p_autonomous,now());
 insert into project_events(project_id,event,data) values(p.id,'organization_financial_authority',jsonb_build_object('owner',p_owner,'objectiveHash',p_objective_hash,'ceilingMicrousd',p_ceiling,'perCallMicrousd',p_per_call,'autonomousExecution',p_autonomous));
 return true;
end $$;

-- Every command authenticates its principal from a live assignment, never a model-supplied agent ID.
create function project_org_principal(p_job uuid,p_lease uuid) returns project_organization_nodes
language plpgsql security definer set search_path=public as $$
declare n project_organization_nodes; begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select n0.* into n from project_organization_nodes n0 join mission_assignments j on j.agent_id=n0.agent_id
 join agent_missions m on m.id=j.mission_id and m.project_id=n0.project_id
 join work_projects p on p.id=n0.project_id
 where j.id=p_job and j.lease=p_lease and p_lease is not null and j.lease_until>now() and j.status='running'
 and m.status='running' and m.project_kind='management' and m.deadline>now()
 and p.status='running' and p.deadline>now() and p.active_mission_id=m.id and p.organization_version=1
 and j.payload->>'organizationNodeId'=n0.id::text and n0.kind<>'worker' and n0.status='active' and n0.deadline>now();
 if n.id is null then raise exception 'Live management assignment required';end if;return n;
end $$;

create function project_org_plan_ready(p_node uuid) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from project_organization_plans plan join project_organization_nodes n on n.id=plan.node_id join work_projects p on p.id=n.project_id where n.id=p_node and plan.objective_hash=encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')
 and not exists(select 1 from jsonb_array_elements_text(plan.organizations) as required(area_key) where not exists(select 1 from project_organization_nodes child where child.parent_id=n.id and child.kind='manager' and child.area=required.area_key)))
$$;

create function project_org_dependencies_cyclic(p_project uuid) returns boolean language sql stable security definer set search_path=public as $$
 with recursive ancestors(node_id,ancestor_id) as(
 select id,id from project_organization_nodes where project_id=p_project
 union select a.node_id,n.parent_id from ancestors a join project_organization_nodes n on n.id=a.ancestor_id where n.parent_id is not null
 ),edges(source,target) as(
 select a.node_id,d.depends_on from ancestors a join project_organization_dependencies d on d.node_id=a.ancestor_id
 union select parent_id,id from project_organization_nodes where project_id=p_project and parent_id is not null
 ),reach(source,target) as(
 select source,target from edges union select r.source,e.target from reach r join edges e on e.source=r.target
 ) select exists(select 1 from reach where source=target)
$$;

create function project_org_restructure(p_manager uuid,p_command jsonb) returns void language plpgsql security definer set search_path=public as $$
declare n project_organization_nodes;ch project_organization_nodes;target project_organization_nodes;fresh jsonb;delta integer;begin
 select * into n from project_organization_nodes where id=p_manager;
 select * into ch from project_organization_nodes where id=(p_command->>'nodeId')::uuid and parent_id=n.id;
 if ch.id is null then raise exception 'Only the immediate superior may change organization responsibility';end if;
 if p_command->>'action'='replace_leader' then
 if ch.kind<>'manager' then raise exception 'Only subordinate management leadership may be replaced';end if;
 fresh:=save_managed_agent(null,jsonb_build_object('name',ch.name,'instructions','Manage the existing delegated contract; preserve accepted evidence and never execute technical work.','research',false,'development',false,'attachments',false,'reviewMode','always','maxActiveTasks',1,'maxInputChars',16000),false);
 update project_organization_leadership set superseded_at=now() where node_id=ch.id and superseded_at is null;
 insert into project_organization_leadership(node_id,agent_id) values(ch.id,(fresh->>'id')::uuid);
 update project_organization_nodes set agent_id=(fresh->>'id')::uuid,decision_needed=true,status='active',evidence=null where id=ch.id;
 else
 select * into target from project_organization_nodes where id=(p_command->>'underId')::uuid and parent_id=n.id and kind='manager';
 if target.id is null or target.id=ch.id or ch.deadline>target.deadline or not ch.tools<@target.tools
 or (select coalesce(sum(token_limit),0) from project_organization_nodes where parent_id=target.id)+ch.token_limit>project_org_remaining_tokens(target.id)
 or exists(select 1 from project_organization_scope_grants g,unnest(g.paths) path where g.node_id=ch.id and g.scope_hash=(select approved_hash from work_projects where id=n.project_id) and not exists(select 1 from project_organization_scope_grants t,unnest(t.paths) prefix where t.node_id=target.id and t.scope_hash=g.scope_hash and (path=prefix or right(prefix,1)='/' and starts_with(path,prefix))))
 then raise exception 'Reorganization exceeds the receiving management authority';end if;
 delta:=target.depth+1-ch.depth;
 update project_organization_nodes set parent_id=target.id where id=ch.id;
 if project_org_dependencies_cyclic(n.project_id) then raise exception 'Reorganization creates a circular inherited dependency';end if;
 update project_organization_nodes set depth=depth+delta where id in(with recursive tree(id) as(select ch.id union all select x.id from project_organization_nodes x join tree t on x.parent_id=t.id) select id from tree);
 update project_organization_scope_grants set parent_id=target.id where node_id=ch.id and scope_hash=(select approved_hash from work_projects where id=n.project_id);
 insert into project_events(project_id,event,data) values(n.project_id,'organization_restructured',jsonb_build_object('nodeId',ch.id,'priorParentId',n.id,'parentId',target.id,'reason',p_command->>'reason'));
 update project_organization_nodes set decision_needed=true,status='active',evidence=null where id=target.id;
 end if;
 update project_organization_nodes set status='active',evidence=null where id in(with recursive ancestors(id,parent_id) as(select n.id,n.parent_id union all select x.id,x.parent_id from project_organization_nodes x join ancestors a on x.id=a.parent_id) select id from ancestors);
end $$;

-- A bounded, durable decision API. Model output is a proposal, not direct SQL/tool authority.
create function project_org_decide(p_job uuid,p_lease uuid,p_commands jsonb) returns boolean
language plpgsql security definer set search_path=public as $$
declare n project_organization_nodes; p work_projects; c jsonb; ch project_organization_nodes; a jsonb;
 allocated bigint; mid uuid; eid uuid; ev jsonb; did uuid; sibling uuid; evidence_id uuid;
begin
 n:=project_org_principal(p_job,p_lease);select * into p from work_projects where id=n.project_id;
 if jsonb_typeof(p_commands)<>'array' or jsonb_array_length(p_commands) not between 1 and 16 then raise exception 'Bounded management commands required';end if;
 insert into project_organization_decisions(project_id,node_id,assignment_id,decision) values(p.id,n.id,p_job,p_commands) returning id into did;
 for c in select value from jsonb_array_elements(p_commands) loop
 if c->>'action'='plan' then
 if length(coalesce(c->>'purpose','')) not between 1 and 8000 or length(coalesce(c->>'direction','')) not between 1 and 8000
 or jsonb_typeof(c->'outcomes') is distinct from 'array' or jsonb_array_length(c->'outcomes')<1
 or jsonb_typeof(c->'milestones') is distinct from 'array' or jsonb_array_length(c->'milestones')<1
 or jsonb_typeof(c->'organizations') is distinct from 'array' or (n.kind='project_director' and jsonb_array_length(c->'organizations')<1)
 or exists(select 1 from jsonb_array_elements(c->'outcomes') o where length(coalesce(o->>'criterion',''))=0 or length(coalesce(o->>'verification',''))=0)
 or exists(select 1 from jsonb_array_elements_text(c->'organizations') x where length(coalesce(x,''))=0)
 or (select count(distinct x) from jsonb_array_elements_text(c->'organizations') x)<>jsonb_array_length(c->'organizations')
 or exists(select 1 from jsonb_array_elements(c->'milestones') x where length(coalesce(x->>'objective',''))=0)
 then raise exception 'Purpose, direction and measurable success criteria required';end if;
 insert into project_organization_plans values(n.id,encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex'),c->>'purpose',c->>'direction',c->'outcomes',c->'milestones',c->'organizations',now())
 on conflict(node_id) do update set objective_hash=excluded.objective_hash,purpose=excluded.purpose,direction=excluded.direction,outcomes=excluded.outcomes,milestones=excluded.milestones,organizations=excluded.organizations,updated_at=now();
 elsif c->>'action'='appoint' then
 if c->>'kind' is null or c->>'kind' not in ('manager','worker') or length(coalesce(c->>'name','')) not between 1 and 80 or length(coalesce(c->>'objective','')) not between 1 and 8000
 or jsonb_typeof(c->'acceptance') is distinct from 'array' or jsonb_array_length(c->'acceptance') not between 1 and 30
 or coalesce(c->>'tokens','')!~'^[1-9][0-9]{0,11}$' or jsonb_typeof(c->'tools') is distinct from 'array' or jsonb_typeof(c->'paths') is distinct from 'array'
 then raise exception 'Invalid appointment contract';end if;
 if (c->>'deadline')::timestamptz>least(n.deadline,p.deadline) or (c->>'deadline')::timestamptz<=now() or c->>'deadline' is null
 then raise exception 'Organizational or deadline limit exceeded';end if;
 select coalesce(sum(token_limit),0) into allocated from project_organization_nodes where parent_id=n.id;
 if allocated+(c->>'tokens')::bigint+(select coalesce(sum(greatest(call.reserved_tokens,coalesce(call.actual_tokens,0))),0) from mission_calls call join project_organization_assignments b on b.assignment_id=call.job_id where b.node_id=n.id)>n.token_limit then raise exception 'Child resources exceed parent';end if;
 if exists(select 1 from jsonb_array_elements_text(c->'tools') t where not t=any(n.tools))
 or exists(select 1 from jsonb_array_elements_text(c->'tools') t where t is null) or exists(select 1 from jsonb_array_elements_text(c->'paths') x where x is null or x~'(^|/)\.\.?(/|$)' or x~'^/')
 or exists(select 1 from jsonb_array_elements_text(c->'paths') x where not exists(select 1 from unnest(case when n.kind='project_director' then coalesce(array(select jsonb_array_elements_text(p.spec->'allowedPaths')),n.scope_paths) else coalesce((select g.paths from project_organization_scope_grants g where g.node_id=n.id and g.scope_hash=p.approved_hash),n.scope_paths) end) prefix where x=prefix or right(prefix,1)='/' and starts_with(x,prefix)))
 then raise exception 'Child authority exceeds parent';end if;
 if ((c->>'area'='quality_assurance') or exists(with recursive ancestors(id,parent_id,area) as(select n.id,n.parent_id,n.area union all select x.id,x.parent_id,x.area from project_organization_nodes x join ancestors a on x.id=a.parent_id) select 1 from ancestors where area='quality_assurance')) and (c->'tools')?'development' then raise exception 'Independent QA cannot inherit implementation authority';end if;

 if c->>'reuseAgentId' is not null then
 if c->>'kind'<>'worker' or not (c->>'reuseAgentId')::uuid=any(p.team) then raise exception 'Only existing execution team may be reused';end if;
 a:=jsonb_build_object('id',c->>'reuseAgentId');
 else
 a:=save_managed_agent(null,jsonb_build_object('name',c->>'name','instructions',c->>'objective','research',c->>'kind'='worker' and (c->'tools')?'research','development',c->>'kind'='worker' and (c->'tools')?'development','attachments',false,'reviewMode','always','maxActiveTasks',1,'maxInputChars',16000),false);
 end if;
 insert into project_organization_nodes(project_id,parent_id,agent_id,kind,name,objective,acceptance,scope_paths,tools,token_limit,deadline,depth,scope_hash,decision_needed,area,management_contract)
 values(p.id,n.id,(a->>'id')::uuid,c->>'kind',c->>'name',c->>'objective',c->'acceptance',array(select jsonb_array_elements_text(c->'paths')),array(select jsonb_array_elements_text(c->'tools')),(c->>'tokens')::bigint,(c->>'deadline')::timestamptz,n.depth+1,p.approved_hash,c->>'kind'='manager',coalesce(c->>'area',n.area),jsonb_build_object('purpose',coalesce(c->>'purpose',c->>'objective'),'objectives',jsonb_build_array(c->>'objective'),'deliverables',coalesce(c->'deliverables',c->'acceptance'),'acceptance',c->'acceptance','interfaces',coalesce(c->'interfaces','[]'::jsonb),'reporting',coalesce(c->>'reporting','Certify verified outcomes and escalate material exceptions to the immediate superior')));
 elsif c->>'action' in ('replace_leader','reorganize') then
 if length(coalesce(c->>'reason','')) not between 1 and 2000 then raise exception 'Management change requires a recorded reason';end if;
 perform project_org_restructure(n.id,c);
 elsif c->>'action'='reject' then
 select * into ch from project_organization_nodes where id=(c->>'nodeId')::uuid and parent_id=n.id;
 if ch.id is null or length(coalesce(c->>'findings','')) not between 1 and 4000 then raise exception 'Rejection requires a direct component and objective findings';end if;
 update project_organization_nodes set status='active',evidence=null,decision_needed=(kind<>'worker') where id=ch.id;
 insert into project_organization_exceptions(project_id,origin_id,owner_id,reason,detail) values(p.id,ch.id,case when ch.kind='worker' then n.id else ch.id end,'routine',c->>'findings');
 elsif c->>'action'='grant_scope' then
 select * into ch from project_organization_nodes where id=(c->>'nodeId')::uuid and parent_id=n.id and project_id=p.id;
 if ch.id is null or p.approved_hash is null or p.approved_hash is distinct from p.approval_hash or jsonb_typeof(c->'paths') is distinct from 'array' or jsonb_array_length(c->'paths')<1
 or exists(select 1 from jsonb_array_elements_text(c->'paths') path where path is null or path~'(^|/)\.\.?(/|$)' or not exists(select 1 from project_organization_scope_grants g,unnest(g.paths) prefix where g.node_id=n.id and g.scope_hash=p.approved_hash and (path=prefix or right(prefix,1)='/' and starts_with(path,prefix))))
 then raise exception 'Scope grant exceeds approved parent';end if;
 insert into project_organization_scope_grants values(ch.id,p.approved_hash,array(select jsonb_array_elements_text(c->'paths')),n.id);
 update project_organization_nodes set decision_needed=kind<>'worker',status='active',evidence=null where id=ch.id;
 elsif c->>'action'='assign' then
 select * into ch from project_organization_nodes where id=(c->>'nodeId')::uuid and parent_id=n.id and kind='worker' and deadline>now();
 if ch.id is null or c->>'capability' is null or c->>'capability' not in ('analysis','research','writing','repository_review')
 or not (case when c->>'capability'='writing' then 'analysis' else c->>'capability' end)=any(ch.tools)
 then raise exception 'Worker assignment outside delegated authority';end if;
 if exists(select 1 from project_organization_work where node_id=ch.id and status in ('queued','running')) then raise exception 'Worker already has outstanding work';end if;
 insert into project_organization_work(project_id,node_id,decision_id,capability,instruction) values(p.id,ch.id,did,c->>'capability',c->>'instruction');
 update project_organization_nodes set status='active',evidence=null where id=ch.id;
 elsif c->>'action'='dependency' then
 select * into ch from project_organization_nodes where id=(c->>'nodeId')::uuid and parent_id=n.id;
 select id into sibling from project_organization_nodes where id=(c->>'dependsOn')::uuid and parent_id=n.id;
 if ch.id is null or sibling is null or ch.id=sibling then raise exception 'Dependencies require direct sibling organizations';end if;
 if exists(with recursive edges(id) as (select sibling union select d.depends_on from project_organization_dependencies d join edges e on d.node_id=e.id) select 1 from edges where id=ch.id) then raise exception 'Circular dependency';end if;
 insert into project_organization_dependencies values(p.id,ch.id,sibling) on conflict do nothing;
 if project_org_dependencies_cyclic(p.id) then raise exception 'Circular inherited dependency';end if;
 elsif c->>'action'='exception' then
 -- Routine problems stay local. Escalation moves exactly one reporting level.
 insert into project_organization_exceptions(project_id,origin_id,owner_id,reason,detail)
 values(p.id,n.id,case when c->>'reason'='routine' then n.id else coalesce(n.parent_id,n.id) end,c->>'reason',c->>'detail');
 if c->>'reason'<>'routine' and n.parent_id is not null then update project_organization_nodes set decision_needed=true where id=n.parent_id;end if;
 elsif c->>'action'='resolve' then
 if not exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id join project_organization_assignments b on b.assignment_id=j.id
 where j.id=(c->>'assignmentId')::uuid and j.status='completed' and m.status='completed' and m.project_id=p.id and j.result is not null and b.node_id in(with recursive tree(id) as(select n.id union all select x.id from project_organization_nodes x join tree t on x.parent_id=t.id) select id from tree)) then raise exception 'Exception resolution requires authenticated subordinate evidence';end if;
 update project_organization_exceptions set status='resolved',resolution=c->>'evidence' where id=(c->>'exceptionId')::uuid and owner_id=n.id and status='open' and length(coalesce(c->>'evidence','')) between 1 and 2000;
 if not found then raise exception 'Exception belongs to another manager or lacks evidence';end if;
 elsif c->>'action'='escalate' then
 update project_organization_exceptions set owner_id=coalesce(n.parent_id,n.id),status=case when n.parent_id is null then 'owner_required' else 'open' end
 where id=(c->>'exceptionId')::uuid and owner_id=n.id and status='open' and reason<>'routine';
 if not found then raise exception 'Escalation outside reporting line';end if;
 if n.parent_id is not null then update project_organization_nodes set decision_needed=true where id=n.parent_id;end if;
 elsif c->>'action'='certify' then
 select * into ch from project_organization_nodes where id=(c->>'nodeId')::uuid and parent_id=n.id and project_id=p.id;
 if ch.id is null or exists(select 1 from project_organization_nodes where parent_id=ch.id and status<>'accepted')
 or exists(select 1 from project_organization_dependencies d join project_organization_nodes x on x.id=d.depends_on where d.node_id=ch.id and x.status<>'accepted') then raise exception 'Component or dependency incomplete';end if;
 evidence_id:=(c->>'assignmentId')::uuid;
 select jsonb_build_object('assignmentId',j.id,'result',j.result,'scopeHash',p.approved_hash,'head',p.verified_sha) into ev
 from mission_assignments j join agent_missions m on m.id=j.mission_id
 join project_organization_assignments b on b.assignment_id=j.id
 where j.id=evidence_id and exists(select 1 from project_organization_nodes source where source.id=b.node_id and source.kind='worker') and j.status='completed' and m.project_id=p.id and m.status='completed'
 and b.node_id in (with recursive tree(id) as (select ch.id union all select x.id from project_organization_nodes x join tree on x.parent_id=tree.id) select id from tree) and (ch.kind<>'worker' or b.contract_hash=encode(sha256(convert_to(project_canonical(ch.acceptance),'UTF8')),'hex')) and j.result is not null and (p.approved_hash is null or exists(select 1 from project_runs r where r.mission_id=m.id and r.binding->>'scopeHash'=p.approved_hash and (p.verified_sha is null or r.outcome->>'head'=p.verified_sha or m.project_kind<>'development')) or (m.project_kind in ('organization_work','assessment') and m.project_evidence->>'approvedScopeHash'=p.approved_hash and (m.project_kind<>'assessment' or m.project_evidence->'preview'=p.preview)));
 if ev is null then raise exception 'Authenticated component evidence required';end if;
 if jsonb_typeof(c->'checks') is distinct from 'array' or jsonb_array_length(c->'checks')<>jsonb_array_length(ch.acceptance)
 or exists(select 1 from jsonb_array_elements_text(ch.acceptance) criterion where not exists(select 1 from jsonb_array_elements(c->'checks') check_item where check_item->>'criterion'=criterion and check_item->>'passed'='true' and check_item->>'assignmentId'=evidence_id::text and length(coalesce(check_item->>'evaluation',''))>0))
 then raise exception 'Every original delegated criterion requires an evidence-backed evaluation';end if;
 ev:=ev||jsonb_build_object('checks',c->'checks','contractHash',encode(sha256(convert_to(project_canonical(ch.management_contract),'UTF8')),'hex'));
 update project_organization_nodes set status='accepted',evidence=ev,decision_needed=false where id=ch.id;
 elsif c->>'action'='close' then
 if n.kind<>'project_director' or p.phase<>'assessment' or p.approved_hash is null or p.approved_hash is distinct from p.approval_hash or p.verified_sha is null then raise exception 'Only the Project Director may authorize closure';end if;
 if exists(select 1 from project_organization_nodes where project_id=p.id and parent_id is not null and status<>'accepted')
 or not exists(select 1 from project_organization_nodes where parent_id=n.id and kind='manager' and area='quality_assurance' and status='accepted')
 or exists(select 1 from project_organization_exceptions where project_id=p.id and status<>'resolved') then raise exception 'Organizations or exceptions remain incomplete';end if;
 select (m.project_evidence->>'previousMissionId')::uuid into mid from agent_missions m join mission_assignments j on j.mission_id=m.id where j.id=p_job;
 if not exists(select 1 from agent_missions m join mission_assignments j on j.mission_id=m.id
 where m.id=mid and m.project_id=p.id and m.project_kind='assessment' and m.status='completed'
 and m.project_evidence->>'approvedScopeHash'=p.approved_hash and m.project_evidence->'approvedFinalContract'=p.spec->'finalContract'
 and m.project_evidence->'preview'=p.preview and j.role='review' and j.status='completed' and j.result->>'verdict'='pass'
 and jsonb_array_length(j.result->'checks')=6 and (select count(distinct x->>'id') from jsonb_array_elements(j.result->'checks') x)=6 and not exists(select 1 from jsonb_array_elements(j.result->'checks') x where x->>'passed' is distinct from 'true')
 and exists(select 1 from project_organization_nodes qa where qa.parent_id=n.id and qa.area='quality_assurance' and qa.kind='manager' and qa.status='accepted'
 and qa.evidence->>'assignmentId'=j.id::text and qa.evidence->>'head'=p.verified_sha and qa.evidence->>'scopeHash'=p.approved_hash
 and exists(select 1 from project_organization_assignments b where b.assignment_id=j.id and b.node_id in(with recursive tree(id) as(select qa.id union all select x.id from project_organization_nodes x join tree t on x.parent_id=t.id) select id from tree)))
 and exists(select 1 from mission_assignments writer where writer.mission_id=m.id and writer.role='compose' and writer.agent_id<>j.agent_id and writer.status='completed'))
 then raise exception 'Independent original-requirement QA evidence required';end if;
 if exists(select 1 from mission_calls call join mission_assignments j on j.id=call.job_id join agent_missions m on m.id=j.mission_id where m.project_id=p.id and (call.status<>'completed' or call.actual_tokens is null or call.organization_exposure_microusd is null)) then raise exception 'Unresolved project financial exposure';end if;
 if exists(select 1 from benchmark_budget_calls c join benchmark_budget_accounts a on a.id=c.account_id where a.developer_project_id=p.id and c.state<>'settled') then raise exception 'Unresolved native financial exposure';end if;
 if exists(select 1 from benchmark_budget_calls c join benchmark_budget_accounts a on a.id=c.account_id left join benchmark_dollar_exposures e on e.call_id=c.id where a.developer_project_id=p.id and e.call_id is null) then raise exception 'Missing financial exposure evidence';end if;
 insert into project_organization_closures(project_id,director_id,decision_id,scope_hash,head_sha,receipt)
 values(p.id,n.id,did,p.approved_hash,p.verified_sha,jsonb_build_object('assessmentMissionId',mid,'components',(select jsonb_agg(jsonb_build_object('nodeId',id,'evidence',evidence)) from project_organization_nodes where project_id=p.id and parent_id is not null),'missionTokens',(select coalesce(sum(c.actual_tokens),0) from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=p.id),'settledMissionCostUpperBoundMicrousd',(select coalesce(sum(c.organization_exposure_microusd),0) from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=p.id),'nativeRecordedExposureMicrousd',(select coalesce(sum(e.exposure_microusd),0) from benchmark_dollar_exposures e join benchmark_budget_calls c on c.id=e.call_id join benchmark_budget_accounts a on a.id=e.account_id where a.developer_project_id=p.id and c.legacy_mission_call_id is null),'unsettledCalls',0,'costBasis','Mission amounts are conservative verified-price bounds, not supplier invoice amounts')) on conflict do nothing;
 elsif c->>'action'='ready' then
 if n.kind='project_director' and not project_org_plan_ready(n.id) then raise exception 'Director must establish its purpose and justified functional organizations';end if;
 else raise exception 'Unsupported management action';end if;
 end loop;
 update project_organization_nodes set decision_needed=(kind='project_director' and not project_org_plan_ready(n.id)) where id=n.id;
 if n.parent_id is not null and exists(select 1 from project_organization_nodes where parent_id=n.id) and not exists(select 1 from project_organization_nodes where parent_id=n.id and status<>'accepted') then
 update project_organization_nodes set decision_needed=true where id=n.parent_id;
 end if;
 select mission_id into mid from mission_assignments where id=p_job;
 update mission_assignments set status='completed',result=jsonb_build_object('decisionId',did,'output','Management decision recorded'),lease=null,lease_until=null where id=p_job;
 update agent_missions set status='completed',result='Management decisions committed' where id=mid;
 update work_projects set active_mission_id=(select (project_evidence->>'previousMissionId')::uuid from agent_missions where id=mid) where id=p.id;
 return true;
end $$;

create function project_org_dependencies_ready(p_node uuid) returns boolean language sql stable security definer set search_path=public as $$
 with recursive ancestors(id,parent_id) as(select id,parent_id from project_organization_nodes where id=p_node union all select x.id,x.parent_id from project_organization_nodes x join ancestors a on x.id=a.parent_id)
 select not exists(select 1 from project_organization_dependencies d join project_organization_nodes n on n.id=d.depends_on where d.node_id in(select id from ancestors) and n.status<>'accepted')
$$;

create function project_org_schedule(p_project uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare p work_projects; n project_organization_nodes; mid uuid; j uuid; previous_mid uuid; w project_organization_work; begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project and lease=p_lease and p_lease is not null and lease_until>now() and status='running' and deadline>now();
 if p.id is null then raise exception 'Project lease required';end if;
 if p.organization_version=0 then return null;end if;
 if p.active_mission_id is not null then
 if exists(select 1 from agent_missions where id=p.active_mission_id and project_kind='management') then
 if exists(select 1 from agent_missions where id=p.active_mission_id and status in ('blocked','stopped')) then
 select * into n from project_organization_nodes where id=(select (project_evidence->>'organizationNodeId')::uuid from agent_missions where id=p.active_mission_id);
 if (select count(*) from agent_missions where project_id=p.id and project_kind='management' and project_evidence->>'organizationNodeId'=n.id::text and status in ('blocked','stopped'))>=2 then
 if n.parent_id is null then return jsonb_build_object('blocked','Project management cannot achieve its objective within bounded retry authority');end if;
 insert into project_organization_exceptions(project_id,origin_id,owner_id,reason,detail) values(p.id,n.id,n.parent_id,'objective','Management session failed twice; saved decisions and charges retained.');
 update project_organization_nodes set decision_needed=(id=n.parent_id) where id in(n.id,n.parent_id);
 else update project_organization_nodes set decision_needed=true where id=n.id;end if;
 update work_projects set active_mission_id=(select (project_evidence->>'previousMissionId')::uuid from agent_missions where id=p.active_mission_id) where id=p.id;
 end if;return jsonb_build_object('waiting',true);end if;
 if exists(select 1 from agent_missions where id=p.active_mission_id and project_kind='organization_work') then
 if exists(select 1 from agent_missions where id=p.active_mission_id and status in ('completed','blocked','stopped')) then
 update project_organization_work set status=case when (select status from agent_missions where id=p.active_mission_id)='completed' then 'completed' else 'blocked' end where mission_id=p.active_mission_id returning * into w;
 update project_organization_nodes set decision_needed=true where id=(select parent_id from project_organization_nodes where id=w.node_id);
 update work_projects set active_mission_id=(select (project_evidence->>'previousMissionId')::uuid from agent_missions where id=p.active_mission_id) where id=p.id;
 end if;return jsonb_build_object('waiting',true);end if;
 if not exists(select 1 from agent_missions where id=p.active_mission_id and status in ('completed','blocked')) then return null;end if;
 previous_mid:=p.active_mission_id;
 end if;
 if p.phase='assessment' and previous_mid is not null and not exists(select 1 from project_organization_closures where project_id=p.id) then update project_organization_nodes set decision_needed=true where project_id=p.id and kind='project_director';end if;
 select * into n from project_organization_nodes where project_id=p.id and kind<>'worker' and status='active' and decision_needed and deadline>now() and project_org_dependencies_ready(id) order by case when kind='project_director' and not project_org_plan_ready(id) then 0 else 1 end,depth desc,created_at,id limit 1;
 if n.id is null then
 select * into w from project_organization_work where project_id=p.id and status='queued' and project_org_dependencies_ready(node_id) order by created_at,id limit 1;
 if w.id is null then
 if exists(select 1 from project_organization_nodes where project_id=p.id and kind<>'worker' and status='active' and decision_needed) or exists(select 1 from project_organization_work where project_id=p.id and status='queued') then return jsonb_build_object('waiting',true,'detail','Organizations are coordinating their accepted dependencies.');end if;
 return null;end if;
 select * into n from project_organization_nodes where id=w.node_id;
 end if;
 -- Planning uses the existing project authorization, never an implicit new allowance.
 if not exists(select 1 from project_organization_authority where project_id=p.id and objective_hash=encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')) then return jsonb_build_object('waiting',true,'detail','Project financial authority is required before management inference');end if;
 if n.token_limit<10000 then return jsonb_build_object('blocked','Delegated management capacity unavailable');end if;
 if (select count(*) from agent_missions where project_id=p.id)>=p.max_missions then return jsonb_build_object('blocked','Approved project mission limit reached');end if;
 if exists(select 1 from project_organization_dependencies d join project_organization_nodes x on x.id=d.depends_on where d.node_id in(n.id,n.parent_id) and x.status<>'accepted') then return jsonb_build_object('blocked','Delegated organization dependency is incomplete');end if;
 mid:=gen_random_uuid();
 if n.kind='worker' then
 perform create_mission(mid,w.instruction,array[n.agent_id],20,case when w.capability='repository_review' then p.repository_id else null end);
 update work_projects set active_mission_id=mid where id=p.id;
 update agent_missions set project_id=p.id,project_kind='organization_work',project_evidence=jsonb_build_object('organizationNodeId',n.id,'previousMissionId',previous_mid,'approvedScopeHash',p.approved_hash),token_allowance=least(60000,n.token_limit)::int,deadline=least(p.deadline,n.deadline),status='running' where id=mid;
 -- Fixed assignment: the manager already planned this work; no worker may appoint agents.
 update mission_assignments set role='work',payload=jsonb_build_object('capability',w.capability),instruction=w.instruction where mission_id=mid;
 update project_organization_work set mission_id=mid,status='running' where id=w.id;
 return jsonb_build_object('missionId',mid,'nodeId',n.id);
 end if;
 -- create_mission validates definitions/capacity; create its plan as an execution identity first,
 -- then bind the management-only assignment after the project lease owns this mission.
 perform create_mission(mid,n.objective,array[p.team[1]],20,null);
 update work_projects set active_mission_id=mid where id=p.id;
 update agent_missions set project_id=p.id,project_kind='management',project_evidence=jsonb_build_object('organizationNodeId',n.id,'previousMissionId',previous_mid),team=jsonb_build_array((select to_jsonb(a) from managed_agents a where a.id=n.agent_id)),token_allowance=least(60000,n.token_limit)::int,deadline=least(p.deadline,n.deadline),status='running' where id=mid;
 update mission_assignments set role='work',agent_id=n.agent_id,payload=jsonb_build_object('organizationNodeId',n.id),instruction='Make bounded management decisions. Delegate all technical execution.' where mission_id=mid returning id into j;
 insert into project_organization_assignments values(j,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex'),now());
 return jsonb_build_object('missionId',mid,'nodeId',n.id);
end $$;

create function project_org_scope_approved() returns trigger language plpgsql security definer set search_path=public as $$
declare root_id uuid;begin
 if new.organization_version=1 and new.approved_hash is not null and new.approved_hash is distinct from old.approved_hash then
 select id into root_id from project_organization_nodes where project_id=new.id and kind='project_director';
 insert into project_organization_scope_grants values(root_id,new.approved_hash,array(select jsonb_array_elements_text(new.spec->'allowedPaths')),null) on conflict do nothing;
 update project_organization_nodes set status='active',evidence=null,decision_needed=(id=root_id) where project_id=new.id;
 end if;return new;
end $$;
create trigger project_org_scope after update of approved_hash on work_projects for each row execute function project_org_scope_approved();

-- Component work ends at its manager, not at project completion. This RPC is
-- restricted to the exact subordinate assignment; acceptance remains separate.
create function project_org_finish_work(p_job uuid,p_lease uuid,p_result jsonb) returns boolean
language plpgsql security definer set search_path=public as $$
declare j mission_assignments;m agent_missions;n project_organization_nodes;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_job and lease=p_lease and p_lease is not null and lease_until>now() and status='running';
 select * into m from agent_missions where id=j.mission_id and project_kind='organization_work' and status='running' and deadline>now();
 select x.* into n from project_organization_assignments b join project_organization_nodes x on x.id=b.node_id where b.assignment_id=j.id and x.agent_id=j.agent_id and x.kind='worker';
 if j.id is null or m.id is null or n.id is null or not exists(select 1 from work_projects where id=m.project_id and active_mission_id=m.id and status='running' and deadline>now()) or length(coalesce(p_result->>'text','')) not between 1 and 40000 then raise exception 'Live subordinate work receipt required';end if;
 update mission_assignments set status='completed',result=p_result,lease=null,lease_until=null where id=j.id;
 update agent_missions set status='completed',result=p_result->>'text' where id=m.id;
 return true;
end $$;

-- Supplemental tool-dispatch check. The manager cannot bypass this via a mutable prompt/config.
create function project_org_assert_execution(p_agent uuid) returns boolean language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from project_organization_leadership where agent_id=p_agent) then raise exception 'Management agents cannot execute tools';end if;return true;
end $$;
-- Bind legacy execution assignments to their durable worker organization automatically.
create function project_org_bind_assignment() returns trigger language plpgsql security definer set search_path=public as $$
declare n project_organization_nodes; begin
 select x.* into n from project_organization_nodes x join agent_missions m on m.project_id=x.project_id where m.id=new.mission_id and x.agent_id=new.agent_id and x.kind='worker';
 if n.id is null and exists(select 1 from agent_missions m join work_projects p on p.id=m.project_id where m.id=new.mission_id and m.project_kind<>'management' and p.organization_version=1) then raise exception 'Assignment lacks appointed execution owner';end if;
 if n.id is not null then
 if n.deadline<=now() or ((new.payload->>'capability' in ('analysis','writing') or new.role in ('plan','compose','revise','review')) and not 'analysis'=any(n.tools)) or (new.role='development' and not 'development'=any(n.tools)) or (new.payload->>'capability'='research' and not 'research'=any(n.tools)) or (new.payload->>'capability'='repository_review' and not 'repository_review'=any(n.tools)) then raise exception 'Assignment exceeds delegated execution authority';end if;
 if exists(with recursive ancestors(id,parent_id) as(select n.id,n.parent_id union all select x.id,x.parent_id from project_organization_nodes x join ancestors a on x.id=a.parent_id) select 1 from project_organization_dependencies d join project_organization_nodes dependency on dependency.id=d.depends_on where d.node_id in(select id from ancestors) and dependency.status<>'accepted') then raise exception 'Unaccepted organizational dependency';end if;
 if new.role='development' and not exists(select 1 from work_projects p join project_organization_scope_grants g on g.node_id=n.id and g.scope_hash=p.approved_hash where p.id=n.project_id and p.approved_hash=p.approval_hash and not exists(select 1 from jsonb_array_elements_text(p.spec->'allowedPaths') path where not exists(select 1 from unnest(g.paths) prefix where path=prefix or right(prefix,1)='/' and starts_with(path,prefix)))) then raise exception 'Coding scope not delegated to worker';end if;
 update project_organization_nodes set status='active',evidence=null where id in (with recursive ancestors(id,parent_id) as(select n.id,n.parent_id union all select x.id,x.parent_id from project_organization_nodes x join ancestors a on x.id=a.parent_id) select id from ancestors);
 insert into project_organization_assignments values(new.id,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex'),now()) on conflict do nothing;
 end if;return new;
end $$;
create trigger project_org_bind after insert or update of agent_id,role,payload on mission_assignments for each row execute function project_org_bind_assignment();


create function project_org_worker_outcome() returns trigger language plpgsql security definer set search_path=public as $$
declare n project_organization_nodes;begin
 if new.status is not distinct from old.status or new.status not in ('completed','failed') then return new;end if;
 select x.* into n from project_organization_assignments b join project_organization_nodes x on x.id=b.node_id where b.assignment_id=new.id and x.kind='worker';
 if n.id is not null then
 update project_organization_nodes set decision_needed=true where id=n.parent_id;
 if new.status='failed' then insert into project_organization_exceptions(project_id,origin_id,owner_id,reason,detail) values(n.project_id,n.id,n.parent_id,'routine',coalesce(new.detail,'Worker failed; inspect saved evidence before bounded repair'));end if;
 end if;return new;
end $$;
create trigger project_org_outcome after update of status on mission_assignments for each row execute function project_org_worker_outcome();

-- Financial delegation is an additional constraint, not a new spending rail.
create function project_org_call_guard() returns trigger language plpgsql security definer set search_path=public as $$
declare n project_organization_nodes; used bigint; authority project_organization_authority; price model_registry; exposure numeric; total numeric; manager boolean; begin
 select x.* into n from project_organization_assignments b join project_organization_nodes x on x.id=b.node_id where b.assignment_id=new.job_id;
 if n.id is null then return new;end if;
 manager:=n.kind<>'worker';
 if not exists(select 1 from work_projects p join mission_assignments j on j.mission_id=p.active_mission_id where p.id=n.project_id and j.id=new.job_id and p.status='running' and p.deadline>now() and p.organization_version=1) then raise exception 'Active project authority required';end if;
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into authority from project_organization_authority where project_id=n.project_id;
 if strpos(new.model,':')>0 then
 select * into price from model_registry where provider_name=split_part(new.model,':',1) and model_id=substr(new.model,strpos(new.model,':')+1);
 else
 -- The existing native OpenAI adapter records its approved model without a
 -- provider prefix. Admit that spelling only with its actual account binding.
 select r.* into price from model_registry r where r.provider_name='openai' and r.model_id=new.model and not manager
 and exists(select 1 from mission_assignments j join benchmark_mission_bindings b on b.mission_id=j.mission_id join benchmark_native_spending_approvals a on a.account_id=b.account_id where j.id=new.job_id and a.project_id=n.project_id and a.model=new.model and a.revoked_at is null and a.deadline>now());
 end if;
 if authority.project_id is null or price.model_id is null or price.pricing_status<>'verified' or price.pricing_verified_at is null or price.pricing_verified_at<now()-interval '24 hours' or price.pricing_verified_at>now() or price.pricing_input_per_1m is null or price.pricing_output_per_1m is null
 or (manager and (price.provider_name not in ('openai','anthropic') or price.reasoning_tier is distinct from 'high' or price.capability_status is distinct from 'verified' or price.capability_verified_at is null or price.capability_verified_at<now()-interval '24 hours' or price.capability_verified_at>now() or not price.is_active or price.routing_eligibility is distinct from 'verified'))
 then raise exception 'Verified authorized management model and pricing required';end if;
 exposure:=new.reserved_tokens*greatest(price.pricing_input_per_1m,price.pricing_output_per_1m);
 select coalesce(sum(c.organization_exposure_microusd),0) into total from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=n.project_id;
 total:=total+(select coalesce(sum(e.exposure_microusd),0) from benchmark_dollar_exposures e join benchmark_budget_calls c on c.id=e.call_id join benchmark_budget_accounts a on a.id=c.account_id where a.developer_project_id=n.project_id and c.legacy_mission_call_id is null);
 if exposure>authority.per_call_microusd or total+exposure>authority.ceiling_microusd then raise exception 'Organization monetary ceiling exceeded';end if;
 new.organization_exposure_microusd:=exposure;
 new.organization_unit_microusd:=greatest(price.pricing_input_per_1m,price.pricing_output_per_1m);
 loop
 select coalesce(sum(greatest(c.reserved_tokens,coalesce(c.actual_tokens,0))),0) into used from mission_calls c join project_organization_assignments b on b.assignment_id=c.job_id
 where b.node_id in (with recursive tree(id) as (select n.id union all select x.id from project_organization_nodes x join tree on x.parent_id=tree.id) select id from tree);
 used:=used+(select coalesce(sum(greatest(c.reserved_tokens,coalesce(c.actual_tokens,0))),0) from benchmark_budget_calls c join benchmark_budget_accounts a on a.id=c.account_id join mission_assignments j on j.id=a.developer_task_id where a.developer_project_id=n.project_id and c.legacy_mission_call_id is null and j.agent_id in(with recursive tree(id,agent_id) as(select n.id,n.agent_id union all select x.id,x.agent_id from project_organization_nodes x join tree on x.parent_id=tree.id) select agent_id from tree));
 if used+new.reserved_tokens>n.token_limit or n.deadline<=now() or n.status<>'active' then raise exception 'Delegated resource authority exhausted';end if;
 exit when n.parent_id is null;select * into n from project_organization_nodes where id=n.parent_id;
 end loop;return new;
end $$;
create trigger project_org_call_admission before insert on mission_calls for each row execute function project_org_call_guard();

create function project_org_call_settlement() returns trigger language plpgsql security definer set search_path=public as $$
declare pid uuid;total numeric;begin
 if old.organization_unit_microusd is null then return new;end if;
 new.organization_unit_microusd:=old.organization_unit_microusd;
 new.organization_exposure_microusd:=greatest(new.reserved_tokens,coalesce(new.actual_tokens,0))*old.organization_unit_microusd;
 select m.project_id into pid from mission_assignments j join agent_missions m on m.id=j.mission_id where j.id=new.job_id;
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select coalesce(sum(c.organization_exposure_microusd),0) into total from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=pid and c.id<>new.id;
 total:=total+new.organization_exposure_microusd+(select coalesce(sum(e.exposure_microusd),0) from benchmark_dollar_exposures e join benchmark_budget_calls c on c.id=e.call_id join benchmark_budget_accounts a on a.id=c.account_id where a.developer_project_id=pid and c.legacy_mission_call_id is null);
 if total>(select ceiling_microusd from project_organization_authority where project_id=pid) or new.actual_tokens>new.reserved_tokens then
 update work_projects set status='blocked',detail='Actual provider usage exceeded reserved authority; receipt preserved for reconciliation.' where id=pid;
 end if;return new;
end $$;
create trigger project_org_call_settle before update on mission_calls for each row execute function project_org_call_settlement();

-- Native coding uses the existing canonical ledger. Apply the same delegated
-- token and project monetary constraints there, excluding mission projections.
create function project_org_native_guard() returns trigger language plpgsql security definer set search_path=public as $$
declare n project_organization_nodes; a benchmark_budget_accounts; used bigint; total numeric; authority project_organization_authority; begin
 select * into a from benchmark_budget_accounts where id=new.account_id;
 -- Linked mission projections are already admitted by the mission-call guard;
 -- counting their exposure again would deny an otherwise authorized final call.
 if tg_table_name='benchmark_budget_calls' then
 if new.legacy_mission_call_id is not null then return new;end if;
 elsif exists(select 1 from benchmark_budget_calls where id=new.call_id and legacy_mission_call_id is not null) then return new;
 end if;
 select x.* into n from project_organization_nodes x join mission_assignments j on j.agent_id=x.agent_id join agent_missions m on m.id=j.mission_id and m.project_id=x.project_id where j.id=a.developer_task_id;
 if n.id is null then
 if exists(select 1 from work_projects where id=a.developer_project_id and organization_version=1) then raise exception 'Native work requires an appointed execution worker';end if;
 return new;end if;
 if n.kind<>'worker' or not 'development'=any(n.tools) or not project_org_dependencies_ready(n.id) then raise exception 'Native execution authority denied';end if;
 if not exists(select 1 from work_projects p join project_organization_scope_grants g on g.node_id=n.id and g.scope_hash=p.approved_hash where p.id=n.project_id and p.status='running' and p.deadline>now() and p.approved_hash=p.approval_hash) then raise exception 'Native execution requires current delegated project scope';end if;
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if tg_table_name='benchmark_budget_calls' then
 if new.legacy_mission_call_id is not null then return new;end if;
 loop
 with recursive tree(id,agent_id) as (select n.id,n.agent_id union all select x.id,x.agent_id from project_organization_nodes x join tree on x.parent_id=tree.id)
 select coalesce((select sum(greatest(c.reserved_tokens,coalesce(c.actual_tokens,0))) from mission_calls c join project_organization_assignments b on b.assignment_id=c.job_id where b.node_id in(select id from tree)),0)+
 coalesce((select sum(greatest(c.reserved_tokens,coalesce(c.actual_tokens,0))) from benchmark_budget_calls c join benchmark_budget_accounts account on account.id=c.account_id join mission_assignments j on j.id=account.developer_task_id where j.agent_id in(select agent_id from tree) and account.developer_project_id=n.project_id and c.legacy_mission_call_id is null),0) into used;
 if used+new.reserved_tokens>n.token_limit or n.deadline<=now() or n.status<>'active' then raise exception 'Native delegated resource authority exhausted';end if;
 exit when n.parent_id is null;select * into n from project_organization_nodes where id=n.parent_id;
 end loop;
 elsif tg_table_name='benchmark_dollar_exposures' then
 select * into authority from project_organization_authority where project_id=n.project_id;
 select coalesce(sum(c.organization_exposure_microusd),0) into total from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=n.project_id;
 total:=total+(select coalesce(sum(e.exposure_microusd),0) from benchmark_dollar_exposures e join benchmark_budget_calls c on c.id=e.call_id join benchmark_budget_accounts account on account.id=c.account_id where account.developer_project_id=n.project_id and c.legacy_mission_call_id is null and e.call_id<>new.call_id);
 if authority.project_id is null or new.exposure_microusd>authority.per_call_microusd or total+new.exposure_microusd>authority.ceiling_microusd then raise exception 'Native project monetary ceiling exceeded';end if;
 end if;return new;
end $$;
create trigger project_org_native_admission before insert on benchmark_budget_calls for each row execute function project_org_native_guard();
create trigger project_org_native_exposure before insert on benchmark_dollar_exposures for each row execute function project_org_native_guard();

create function project_org_native_settlement() returns trigger language plpgsql security definer set search_path=public as $$
declare pid uuid;total numeric;begin
 select developer_project_id into pid from benchmark_budget_accounts where id=new.account_id;
 if not exists(select 1 from work_projects where id=pid and organization_version=1) then return new;end if;
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select coalesce(sum(e.exposure_microusd),0) into total from benchmark_dollar_exposures e join benchmark_budget_calls c on c.id=e.call_id join benchmark_budget_accounts a on a.id=c.account_id where a.developer_project_id=pid and c.legacy_mission_call_id is null;
 total:=total+(select coalesce(sum(c.organization_exposure_microusd),0) from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=pid);
 if total>(select ceiling_microusd from project_organization_authority where project_id=pid) then
 update work_projects set status='blocked',detail='Actual financial exposure exceeded the approved ceiling; settlement preserved.' where id=pid;
 end if;return new;
end $$;
create trigger project_org_native_settle after update on benchmark_dollar_exposures for each row execute function project_org_native_settlement();

-- Before a registered project mission can execute, every team member must be
-- a worker appointed by its management organization. Historical projects bypass
-- this new gate, but manager identities can never use that compatibility path.
create function project_org_mission_binding() returns trigger language plpgsql security definer set search_path=public as $$
declare p work_projects;j mission_assignments;n project_organization_nodes;begin
 if new.project_id is null or new.project_kind='management' then return new;end if;
 select * into p from work_projects where id=new.project_id;
 if p.organization_version<>1 then return new;end if;
 for j in select * from mission_assignments where mission_id=new.id loop
 select * into n from project_organization_nodes where project_id=p.id and agent_id=j.agent_id and kind='worker' and status in ('active','accepted') and deadline>now();
 if n.id is null then raise exception 'Execution mission requires appointed workers';end if;
 if ((j.role in ('plan','compose','revise','review') or j.payload->>'capability' in ('analysis','writing')) and not 'analysis'=any(n.tools)) or (j.role='development' and not 'development'=any(n.tools)) then raise exception 'Worker lacks delegated coding authority';end if;
 if exists(select 1 from project_organization_dependencies d join project_organization_nodes x on x.id=d.depends_on where d.node_id in (n.id,n.parent_id) and x.status<>'accepted') then raise exception 'Organization dependency not accepted';end if;
 insert into project_organization_assignments values(j.id,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex'),now()) on conflict do nothing;
 end loop;return new;
end $$;
create trigger project_org_mission_execution after insert or update of project_id,project_kind on agent_missions for each row execute function project_org_mission_binding();

-- Completion requires a director decision in addition to every existing lifecycle gate.
create function project_org_closure_guard() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.organization_version=1 and new.status='completed' and old.status is distinct from 'completed' then
 if not exists(select 1 from project_organization_closures c join project_organization_nodes n on n.id=c.director_id
 where c.project_id=new.id and n.kind='project_director' and c.scope_hash=new.approved_hash and c.head_sha=new.verified_sha)
 then raise exception 'Project Director closure authorization required';end if;
 if exists(select 1 from project_organization_nodes where project_id=new.id and parent_id is not null and status<>'accepted') or exists(select 1 from project_organization_exceptions where project_id=new.id and status<>'resolved') or exists(select 1 from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=new.id and c.status<>'completed') or exists(select 1 from benchmark_budget_calls c join benchmark_budget_accounts a on a.id=c.account_id where a.developer_project_id=new.id and c.state<>'settled') then raise exception 'Closure evidence or financial position changed';end if;
 end if;return new;
end $$;
create trigger project_org_close before update of status on work_projects for each row execute function project_org_closure_guard();

create function project_org_remaining_tokens(p_node uuid) returns bigint language plpgsql stable security definer set search_path=public as $$
declare n project_organization_nodes;used bigint;remaining bigint:=9223372036854775807;begin
 select * into n from project_organization_nodes where id=p_node;
 if n.id is null then return 0;end if;
 loop
 with recursive tree(id,agent_id) as(select n.id,n.agent_id union all select x.id,x.agent_id from project_organization_nodes x join tree t on x.parent_id=t.id)
 select coalesce((select sum(greatest(c.reserved_tokens,coalesce(c.actual_tokens,0))) from mission_calls c join project_organization_assignments b on b.assignment_id=c.job_id where b.node_id in(select id from tree)),0)+coalesce((select sum(greatest(c.reserved_tokens,coalesce(c.actual_tokens,0))) from benchmark_budget_calls c join benchmark_budget_accounts a on a.id=c.account_id join mission_assignments j on j.id=a.developer_task_id where a.developer_project_id=n.project_id and c.legacy_mission_call_id is null and j.agent_id in(select agent_id from tree)),0) into used;
 if n.status<>'active' or n.deadline<=now() then return 0;end if;
 remaining:=least(remaining,n.token_limit-used);
 exit when n.parent_id is null;select * into n from project_organization_nodes where id=n.parent_id;
 end loop;return greatest(0,remaining);
end $$;

-- Derive a task grant from the original owner envelope and the manager's
-- worker/path delegation. This never treats historical coding consent as money.
create function project_org_prepare_native(p_task uuid,p_lease uuid) returns boolean
language plpgsql security definer set search_path=public as $$
declare p work_projects;j mission_assignments;n project_organization_nodes;a project_organization_authority;
 offered jsonb;limits jsonb;decision jsonb;used numeric;remaining numeric;seconds integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_task and lease=p_lease and p_lease is not null and lease_until>now() and status='running' and role='development';
 select x.* into p from work_projects x join agent_missions m on m.project_id=x.id where m.id=j.mission_id and m.status='running' and x.active_mission_id=m.id and x.organization_version=1 and x.status='running' and x.deadline>now();
 select * into a from project_organization_authority where project_id=p.id and autonomous_execution and objective_hash=encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex');
 select x.* into n from project_organization_assignments b join project_organization_nodes x on x.id=b.node_id where b.assignment_id=j.id and x.agent_id=j.agent_id and x.kind='worker' and x.status='active' and 'development'=any(x.tools) and x.deadline>now();
 if j.id is null or p.id is null or a.project_id is null or n.id is null or not project_org_dependencies_ready(n.id)
 or not exists(select 1 from project_organization_scope_grants g where g.node_id=n.id and g.scope_hash=p.approved_hash and p.approval_hash=p.approved_hash)
 then raise exception 'Live delegated worker and original autonomous project authority required';end if;
 perform developer_task_binding(a.owner_id,p_task);
 if exists(select 1 from project_organization_native_delegations d join benchmark_native_spending_approvals approval on approval.id=d.approval_id where d.task_id=p_task and d.node_id=n.id and d.scope_hash=p.approved_hash and approval.deadline>now() and approval.revoked_at is null) then return true;end if;
 -- The existing adapter selects its verified model and preserves protected
 -- completion/assessment reserves. No model identifier or budget is invented here.
 offered:=developer_prepare_initial(a.owner_id,p_task);limits:=offered->'proposal'->'proposed';
 select coalesce(sum(c.organization_exposure_microusd),0) into used from mission_calls c join mission_assignments job on job.id=c.job_id join agent_missions m on m.id=job.mission_id where m.project_id=p.id;
 used:=used+(select coalesce(sum(e.exposure_microusd),0) from benchmark_dollar_exposures e join benchmark_budget_calls c on c.id=e.call_id join benchmark_budget_accounts account on account.id=c.account_id where account.developer_project_id=p.id and c.legacy_mission_call_id is null);
 remaining:=a.ceiling_microusd-used;
 seconds:=floor(extract(epoch from least(p.deadline,n.deadline)-clock_timestamp()))::integer;
 if remaining<=0 or seconds<60 or (limits->>'developmentTokens')::bigint>project_org_remaining_tokens(n.id) or (limits->>'cumulativeTokens')::bigint>project_org_remaining_tokens((select id from project_organization_nodes where project_id=p.id and kind='project_director')) then
 insert into project_organization_exceptions(project_id,origin_id,owner_id,reason,detail) values(p.id,n.id,n.parent_id,'resources','Native work cannot fit delegated capacity; task '||p_task::text||'. Existing records and authority retained.');
 update project_organization_nodes set decision_needed=true where id=n.parent_id;return false;
 end if;
 limits:=limits||jsonb_build_object('ceilingMicrousd',least((limits->>'ceilingMicrousd')::numeric,remaining),'perCallMicrousd',least((limits->>'perCallMicrousd')::numeric,a.per_call_microusd,remaining),'durationSeconds',least((limits->>'durationSeconds')::integer,seconds));
 offered:=developer_offer_initial(a.owner_id,p_task,limits,offered->'proposal'->>'model');
 insert into project_organization_native_delegations(task_id,project_id,node_id,scope_hash,authority_objective_hash,proposal_id,limits)
 values(p_task,p.id,n.id,p.approved_hash,a.objective_hash,offered->>'id',limits);
 decision:=developer_decide_initial(a.owner_id,p_task,offered->>'id','approved');
 update project_organization_native_delegations set approval_id=(decision->>'developer_approval_id')::uuid where task_id=p_task;
 insert into project_events(project_id,event,data) values(p.id,'organization_native_delegation',jsonb_build_object('taskId',p_task,'nodeId',n.id,'scopeHash',p.approved_hash,'authorityObjectiveHash',a.objective_hash,'approvalId',decision->>'developer_approval_id','source','original-owner-project-envelope','newOwnerConsent',false));
 return true;
end $$;

-- Legacy tasks retain their existing owner-consent UI. Hierarchical tasks use
-- the original envelope and never appear as routine owner approval requests.
create or replace function developer_next_initial_task(p_owner uuid,p_chat uuid default null) returns uuid
language plpgsql security definer set search_path=public as $$
declare candidate record;
begin
 for candidate in select t.id from agent_tasks t join mission_assignments j on j.id=t.id
 join agent_missions m on m.id=j.mission_id join work_projects p on p.id=m.project_id
 where p.organization_version=0 and j.role='development' and p.active_mission_id=m.id and p.phase='development' and p.status='running'
 and (p_chat is null or p.chat_id=p_chat) and standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 and not exists(select 1 from benchmark_full_project_bindings where project_id=p.id)
 and not exists(select 1 from benchmark_native_spending_approvals where task_id=t.id)
 order by t.created_at desc limit 8 loop
  begin perform developer_initial_snapshot(p_owner,candidate.id);return candidate.id;
  exception when others then continue;end;
 end loop;
 return null;
end $$;
revoke all on function developer_next_initial_task(uuid,uuid) from public,anon,authenticated;
grant execute on function developer_next_initial_task(uuid,uuid) to service_role;

-- Lock the new surface down. Internal helpers and trigger functions are not RPC entry points.
do $$ declare r record; begin
 for r in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'project_org_%' loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',r.signature);
 if r.proname in ('project_org_schedule','project_org_decide','project_org_assert_execution','project_org_authorize','project_org_finish_work','project_org_prepare_native') then execute format('grant execute on function %s to service_role',r.signature);end if;
 end loop;
end $$;

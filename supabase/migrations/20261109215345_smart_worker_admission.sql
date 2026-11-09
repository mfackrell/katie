-- Add explicit immutable leadership levels without changing execution identity.
alter table project_organization_nodes add column management_level text;
update project_organization_nodes n set management_level=case when kind='project_director' then 'project_director' when kind='worker' then 'worker' when exists(select 1 from project_organization_nodes p where p.id=n.parent_id and p.kind='project_director') then 'functional_director' else 'manager' end;
alter table project_organization_nodes alter column management_level set not null;
alter table project_organization_nodes add constraint project_management_level check
 ((kind='project_director' and management_level='project_director') or (kind='worker' and management_level='worker') or (kind='manager' and management_level in ('functional_director','manager','supervisor')));
create or replace function project_org_reporting_guard() returns trigger language plpgsql set search_path=public as $$
declare parent project_organization_nodes;begin
 if tg_op='UPDATE' and new.management_level is distinct from old.management_level then raise exception 'Management level is immutable';end if;
 select * into parent from project_organization_nodes where id=new.parent_id;
 -- Backward-compatible structural defaults, never names or model claims.
 if new.management_level is null then new.management_level:=case when new.kind='project_director' then 'project_director' when new.kind='worker' then 'worker' when parent.kind='project_director' then 'functional_director' else 'manager' end;end if;
 if new.kind<>'project_director' and (parent.id is null or parent.project_id<>new.project_id or parent.kind='worker'
 or parent.kind='project_director' and (new.kind<>'manager' or new.management_level<>'functional_director')
 or parent.management_level='manager' and new.management_level='functional_director'
 or parent.management_level='supervisor' and new.kind<>'worker') then raise exception 'Reporting level violation: Project Director commissions Functional Directors; supervisors commission workers only';end if;
 return new;
end $$;

-- A manager's single-worker contract is distinct from its multi-worker package.
-- Sizing is a documented estimate grounded in explicit workload/context inventory,
-- current worker configuration and remaining capacity, not a guarantee of success.
create table project_worker_contracts (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references work_projects,
 manager_id uuid not null references project_organization_nodes, worker_id uuid not null references project_organization_nodes,
 decision_assignment uuid not null references mission_assignments, package_id uuid references project_work_packages,
 work_id uuid references project_organization_work, target_assignment uuid unique references mission_assignments, role text not null, contract jsonb not null,
 scope_hash text, parent_hash text not null, agent_version integer not null,
 token_limit bigint not null check(token_limit>0), deadline timestamptz not null,
 max_assignments integer not null check(max_assignments>0), created_at timestamptz not null default now(),
 check(num_nonnulls(package_id,work_id,target_assignment)=1), unique(package_id,role),unique(work_id,role)
);
create table project_worker_admissions (
 assignment_id uuid primary key references mission_assignments, contract_id uuid not null references project_worker_contracts,
 fingerprint text not null, created_at timestamptz not null default now()
);
alter table project_worker_contracts enable row level security;
alter table project_worker_admissions enable row level security;
revoke all on project_worker_contracts,project_worker_admissions from public,anon,authenticated,service_role;
grant select on project_worker_contracts,project_worker_admissions to service_role;

create function project_smart_contract(p_job uuid,p_lease uuid,p_worker uuid,p_role text,c jsonb,p_package uuid default null,p_work uuid default null,p_target uuid default null) returns uuid
language plpgsql security definer set search_path=public as $$
declare n project_organization_nodes;w project_organization_nodes;p work_projects;a managed_agents;v uuid;
 budget bigint;seconds bigint;context_chars bigint;paths text[];capability text;pkg project_work_packages;
begin
 n:=project_org_principal(p_job,p_lease);select * into p from work_projects where id=n.project_id;
 select * into w from project_organization_nodes where id=p_worker and parent_id=n.id and kind='worker';
 if n.kind<>'manager' or w.id is null then raise exception 'SMART requires the immediate management owner';end if;
 update project_organization_nodes set status='active',evidence=null where id in (with recursive ancestors(id,parent_id) as(select w.id,w.parent_id union all select x.id,x.parent_id from project_organization_nodes x join ancestors t on x.id=t.parent_id) select id from ancestors);
 select * into a from managed_agents where id=w.agent_id;
 capability:=case when p_role='development' then 'development' when p_role in ('compose','review','revise') then 'analysis' else case when c->>'capability'='writing' then 'analysis' else c->>'capability' end end;
 if c is null or jsonb_typeof(c) is distinct from 'object'
 or length(trim(coalesce(c->>'objective',''))) not between 1 and 2000
 or length(trim(coalesce(c->>'deliverable',''))) not between 1 and 500
 or length(trim(coalesce(c->>'instruction',''))) not between 1 and 5000
 or c->>'objective' in (p.objective,n.objective)
 or c->>'parentObjective' is distinct from n.objective
 or jsonb_typeof(c->'acceptance') is distinct from 'array' or jsonb_array_length(c->'acceptance')<1
 or exists(select 1 from jsonb_array_elements(c->'acceptance') x where length(trim(coalesce(x->>'criterion','')))=0 or length(trim(coalesce(x->>'evidence','')))=0)
 or jsonb_typeof(c->'inventory') is distinct from 'array' or jsonb_array_length(c->'inventory')<1
 or exists(select 1 from jsonb_array_elements(c->'inventory') x where length(trim(coalesce(x->>'item','')))=0 or coalesce(x->>'contextChars','')!~'^[0-9]{1,7}$')
 or c->'estimate'->>'basis' is distinct from 'declared_inventory'
 or length(trim(coalesce(c->'estimate'->>'rationale','')))=0 or length(trim(coalesce(c->'estimate'->>'uncertainty','')))=0
 or coalesce(c->'estimate'->>'tokens','')!~'^[1-9][0-9]{0,8}$' or coalesce(c->'estimate'->>'seconds','')!~'^[1-9][0-9]{0,6}$'
 or coalesce(c->>'tokens','')!~'^[1-9][0-9]{0,8}$' or coalesce(c->>'maxAssignments','')!~'^[1-9][0-9]{0,3}$'
 or c->>'deadline' is null or capability is null or not capability=any(w.tools)
 then raise exception 'Specific measurable single-worker SMART contract and traceable sizing estimate required';end if;
 budget:=(c->>'tokens')::bigint;seconds:=(c->'estimate'->>'seconds')::bigint;
 context_chars:=length(c::text)+(select coalesce(sum((x->>'contextChars')::bigint),0) from jsonb_array_elements(c->'inventory') x);
 if context_chars>coalesce((a.config->>'maxInputChars')::bigint,16000)
 or (c->'estimate'->>'tokens')::bigint*(c->>'maxAssignments')::int>budget
 or seconds*(c->>'maxAssignments')::int>extract(epoch from (least(w.deadline,n.deadline,p.deadline,(c->>'deadline')::timestamptz)-now()))
 or (c->>'deadline')::timestamptz>least(w.deadline,n.deadline,p.deadline)
 or budget+coalesce((select sum(token_limit) from project_worker_contracts where worker_id=w.id),0)>w.token_limit
 or budget+coalesce((select sum(token_limit) from project_worker_contracts where worker_id=w.id),0)>project_org_remaining_tokens(w.id)
 then raise exception 'SMART estimated workload exceeds single-worker context, resources or execution window; decompose before dispatch';end if;
 if jsonb_typeof(c->'paths') is distinct from 'array' then raise exception 'Explicit SMART scope required';end if;
 paths:=array(select jsonb_array_elements_text(c->'paths'));
 if exists(select 1 from unnest(paths) x where x is null or x='' or x~'(^|/)\.\.?(/|$)' or x~'^/' or x~'[*?]' or right(x,1)='/')
 or exists(select 1 from unnest(paths) x where not exists(select 1 from unnest(coalesce((select g.paths from project_organization_scope_grants g where g.node_id=w.id and g.scope_hash=p.approved_hash),w.scope_paths)) prefix where x=prefix or right(prefix,1)='/' and starts_with(x,prefix)))
 or (p_role='development' and cardinality(paths)=0) then raise exception 'SMART requires an explicit bounded file inventory within worker scope';end if;
 if p_package is not null then
 select * into pkg from project_work_packages where id=p_package and manager_id=n.id;
 if pkg.id is null or (c->>'deadline')::timestamptz>pkg.deadline or (c->>'maxAssignments')::int>pkg.max_attempts
 or budget+coalesce((select sum(token_limit) from project_worker_contracts where package_id=pkg.id),0)>pkg.token_limit
 or exists(select 1 from unnest(paths) x where not exists(select 1 from unnest(pkg.paths) prefix where x=prefix or right(prefix,1)='/' and starts_with(x,prefix))) then raise exception 'SMART contract exceeds package authority';end if;
 elsif p_target is not null then
 if not exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id where j.id=p_target and j.agent_id=w.agent_id and m.project_id=p.id and j.role=p_role and j.status in ('queued','awaiting_approval') and not exists(select 1 from project_worker_admissions where assignment_id=j.id)) then raise exception 'Only unadmitted direct-worker assignments may be commissioned';end if;
 elsif not exists(select 1 from project_organization_work ow where ow.id=p_work and ow.node_id=w.id and ow.capability=c->>'capability') then raise exception 'SMART work binding missing';end if;
 insert into project_worker_contracts(project_id,manager_id,worker_id,decision_assignment,package_id,work_id,target_assignment,role,contract,scope_hash,parent_hash,agent_version,token_limit,deadline,max_assignments)
 values(p.id,n.id,w.id,p_job,p_package,p_work,p_target,p_role,c,p.approved_hash,encode(sha256(convert_to(n.objective,'UTF8')),'hex'),a.version,budget,(c->>'deadline')::timestamptz,(c->>'maxAssignments')::int) returning id into v;
 return v;
end $$;

create function project_smart_fingerprint(j mission_assignments) returns text language sql immutable as $$
 select encode(sha256(convert_to(jsonb_build_object('mission',j.mission_id,'worker',j.agent_id,'role',j.role,'instruction',j.instruction,'payload',j.payload-'development_input'-'reviewModelCheckpoint','dependencies',j.dependencies)::text,'UTF8')),'hex')
$$;
create function project_smart_admit(p_job uuid,p_tokens bigint default 0) returns void language plpgsql security definer set search_path=public as $$
declare j mission_assignments;m agent_missions;p work_projects;c project_worker_contracts;w project_organization_nodes;a managed_agents;used bigint;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_job;select * into m from agent_missions where id=j.mission_id;
 select * into p from work_projects where id=m.project_id;
 if p.id is null or p.organization_version<>1 or m.project_kind='management' then return;end if;
 select x.* into c from project_worker_contracts x where x.id=(select contract_id from project_worker_admissions where assignment_id=j.id);
 if c.id is null then
 if j.payload ?| array['development_input','reviewModelCheckpoint'] then raise exception 'Preseeded SMART execution metadata is forbidden';end if;
 select x.* into c from project_worker_contracts x left join project_work_package_attempts t on t.package_id=x.package_id
 left join project_organization_work ow on ow.id=x.work_id where x.role=j.role and (t.mission_id=m.id or ow.mission_id=m.id or x.target_assignment=j.id);
 if c.id is null then raise exception 'Immediate manager SMART admission required before worker execution';end if;
 if (select count(*) from project_worker_admissions where contract_id=c.id)>=c.max_assignments then raise exception 'SMART assignment capacity exhausted';end if;
 if (case when j.role='development' then 'development' when j.role in ('plan','compose','review','revise') then 'analysis' else case when j.payload->>'capability'='writing' then 'analysis' else j.payload->>'capability' end end) is distinct from (case when c.role='development' then 'development' when c.role in ('plan','compose','review','revise') then 'analysis' else case when c.contract->>'capability'='writing' then 'analysis' else c.contract->>'capability' end end) then raise exception 'SMART runtime capability mismatch';end if;
 if j.instruction is distinct from c.contract->>'instruction' then raise exception 'Worker instruction differs from SMART contract';end if;
 insert into project_worker_admissions values(j.id,c.id,project_smart_fingerprint(j),now());
 end if;
 select * into w from project_organization_nodes where id=c.worker_id;select * into a from managed_agents where id=w.agent_id;
 if c.project_id is distinct from p.id or w.agent_id is distinct from j.agent_id or w.kind<>'worker' or w.parent_id is distinct from c.manager_id
 or w.status not in ('active','accepted') or c.scope_hash is distinct from p.approved_hash
 or c.agent_version is distinct from a.version or c.deadline<=now() or w.deadline<=now()
 or (c.contract->'estimate'->>'seconds')::bigint>extract(epoch from least(c.deadline,w.deadline,p.deadline)-now())
 or c.parent_hash is distinct from (select encode(sha256(convert_to(objective,'UTF8')),'hex') from project_organization_nodes where id=c.manager_id and kind='manager' and status in ('active','accepted'))
 or (select fingerprint from project_worker_admissions where assignment_id=j.id) is distinct from project_smart_fingerprint(j)
 then raise exception 'SMART authority changed or expired';end if;
 select coalesce(sum(tokens),0) into used from (
 select greatest(mc.reserved_tokens,coalesce(mc.actual_tokens,0)) tokens from mission_calls mc join project_worker_admissions b on b.assignment_id=mc.job_id where b.contract_id=c.id
 union all select greatest(bc.reserved_tokens,coalesce(bc.actual_tokens,0)) from benchmark_budget_calls bc join benchmark_budget_accounts ba on ba.id=bc.account_id join project_worker_admissions b on b.assignment_id=ba.developer_task_id where b.contract_id=c.id and bc.legacy_mission_call_id is null) usage;
 if used+p_tokens>c.token_limit then raise exception 'SMART cumulative token authority exhausted';end if;
end $$;

-- Immutable after admission; all routes, including lease/restart claims, are checked.
create function project_smart_assignment_guard() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_op='UPDATE' and exists(select 1 from project_worker_admissions where assignment_id=old.id) and project_smart_fingerprint(new) is distinct from project_smart_fingerprint(old) then raise exception 'Admitted SMART assignment is immutable';end if;
 if new.status='running' and (tg_op='INSERT' or old.status is distinct from new.status or old.lease is distinct from new.lease) then perform project_smart_admit(new.id);end if;
 return new;
end $$;
create trigger project_smart_assignment after insert or update on mission_assignments for each row execute function project_smart_assignment_guard();
create function project_smart_call_guard() returns trigger language plpgsql security definer set search_path=public as $$
declare job uuid;begin
 if tg_table_name='mission_calls' then job:=new.job_id;
 else select developer_task_id into job from benchmark_budget_accounts where id=new.account_id;
 -- Linked native reservations are already charged by mission admission.
 if new.legacy_mission_call_id is not null then select job_id into job from mission_calls where id=new.legacy_mission_call_id;perform project_smart_admit(job);return new;end if;
 end if;
 perform project_smart_admit(job,new.reserved_tokens);return new;
end $$;
create trigger project_smart_call before insert on mission_calls for each row execute function project_smart_call_guard();
create trigger project_smart_native_call before insert on benchmark_budget_calls for each row execute function project_smart_call_guard();
create function project_smart_mission_guard() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from mission_assignments j join project_worker_admissions a on a.assignment_id=j.id where j.mission_id=old.id)
 and (new.project_id is distinct from old.project_id or new.project_kind is distinct from old.project_kind or new.objective is distinct from old.objective or new.project_evidence is distinct from old.project_evidence or new.repository_id is distinct from old.repository_id or new.team is distinct from old.team) then raise exception 'Admitted SMART mission context is immutable';end if;
 if new.project_id is not null and new.project_kind<>'management' and (new.project_id is distinct from old.project_id or new.project_kind is distinct from old.project_kind) then
 perform project_smart_admit(j.id) from mission_assignments j where j.mission_id=new.id and j.status in ('running','waiting_external');end if;
 return new;
end $$;
create trigger project_smart_mission after update on agent_missions for each row execute function project_smart_mission_guard();
revoke all on function project_smart_contract(uuid,uuid,uuid,text,jsonb,uuid,uuid,uuid),project_smart_fingerprint(mission_assignments),project_smart_admit(uuid,bigint),project_smart_assignment_guard(),project_smart_call_guard(),project_smart_mission_guard() from public,anon,authenticated,service_role;

create or replace function project_org_decide_hierarchy(p_job uuid,p_lease uuid,p_commands jsonb) returns boolean
language plpgsql security definer set search_path=public as $$
declare n project_organization_nodes; p work_projects; c jsonb; ch project_organization_nodes; a jsonb;
 allocated bigint; mid uuid; eid uuid; ev jsonb; did uuid; sibling uuid; evidence_id uuid;
begin
 n:=project_org_principal(p_job,p_lease);select * into p from work_projects where id=n.project_id;
 if jsonb_typeof(p_commands)<>'array' or jsonb_array_length(p_commands) not between 1 and 16 then raise exception 'Bounded management commands required';end if;
 insert into project_organization_decisions(project_id,node_id,assignment_id,decision) values(p.id,n.id,p_job,p_commands) returning id into did;
 for c in select value from jsonb_array_elements(p_commands) loop
 if n.kind='project_director' and ((c->>'action'='appoint' and c->>'kind' is distinct from 'manager') or c->>'action'='assign') then
 raise exception 'Project Director may commission only Functional Directors and cannot assign execution work';end if;
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
 insert into project_organization_nodes(project_id,parent_id,agent_id,kind,name,objective,acceptance,scope_paths,tools,token_limit,deadline,depth,scope_hash,decision_needed,area,management_contract,management_level)
 values(p.id,n.id,(a->>'id')::uuid,c->>'kind',c->>'name',c->>'objective',c->'acceptance',array(select jsonb_array_elements_text(c->'paths')),array(select jsonb_array_elements_text(c->'tools')),(c->>'tokens')::bigint,(c->>'deadline')::timestamptz,n.depth+1,p.approved_hash,c->>'kind'='manager',coalesce(c->>'area',n.area),jsonb_build_object('purpose',coalesce(c->>'purpose',c->>'objective'),'objectives',jsonb_build_array(c->>'objective'),'deliverables',coalesce(c->'deliverables',c->'acceptance'),'acceptance',c->'acceptance','interfaces',coalesce(c->'interfaces','[]'::jsonb),'reporting',coalesce(c->>'reporting','Certify verified outcomes and escalate material exceptions to the immediate superior')),coalesce(c->>'managementLevel',case when c->>'kind'='worker' then 'worker' when n.kind='project_director' then 'functional_director' else 'manager' end));
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
 elsif c->>'action'='authorize_assignment' then
 select x.* into ch from project_organization_nodes x join mission_assignments j on j.agent_id=x.agent_id join agent_missions m on m.id=j.mission_id where j.id=(c->>'assignmentId')::uuid and x.parent_id=n.id and x.project_id=p.id and m.project_id=p.id and x.kind='worker';
 if ch.id is null then raise exception 'Immediate worker reporting required';end if;
 perform project_smart_contract(p_job,p_lease,ch.id,(select role from mission_assignments where id=(c->>'assignmentId')::uuid),c->'smart',null,null,(c->>'assignmentId')::uuid);
 update mission_assignments set instruction=c->'smart'->>'instruction',status='queued' where id=(c->>'assignmentId')::uuid;
 elsif c->>'action'='assign' then
 select * into ch from project_organization_nodes where id=(c->>'nodeId')::uuid and parent_id=n.id and kind='worker' and deadline>now();
 if ch.id is null or c->>'capability' is null or c->>'capability' not in ('analysis','research','writing','repository_review')
 or not (case when c->>'capability'='writing' then 'analysis' else c->>'capability' end)=any(ch.tools)
 then raise exception 'Worker assignment outside delegated authority';end if;
 if exists(select 1 from project_organization_work where node_id=ch.id and status in ('queued','running')) then raise exception 'Worker already has outstanding work';end if;
 insert into project_organization_work(project_id,node_id,decision_id,capability,instruction) values(p.id,ch.id,did,c->>'capability',c->'smart'->>'instruction') returning id into eid;
 perform project_smart_contract(p_job,p_lease,ch.id,'work',c->'smart',null,eid);
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
 elsif c->>'action' in ('certify','submit_component') then
 if c->>'action'='submit_component' then
 if n.kind<>'manager' or c->>'nodeId' is not null then raise exception 'Only the responsible Functional Director may submit its own component';end if;
 select * into ch from project_organization_nodes where id=n.id;
 else
 select * into ch from project_organization_nodes where id=(c->>'nodeId')::uuid and parent_id=n.id and project_id=p.id;
 end if;
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
 if c->>'action'='submit_component' then
 if not exists(select 1 from project_organization_nodes where parent_id=ch.id) then raise exception 'Directorate submission requires accepted subordinate deliverables';end if;
 update project_organization_nodes set completion_submission=ev||jsonb_build_object('leaderId',n.agent_id,'decisionId',did,'subtreeHash',project_org_component_fingerprint(ch.id)) where id=ch.id;
 update project_organization_nodes set decision_needed=true where id=n.parent_id;
 else
 if ch.kind='manager' and (ch.completion_submission is null
 or ch.completion_submission->>'leaderId' is distinct from ch.agent_id::text
 or ch.completion_submission->>'contractHash' is distinct from ev->>'contractHash'
 or ch.completion_submission->>'assignmentId' is distinct from evidence_id::text
 or ch.completion_submission->'result' is distinct from ev->'result'
 or ch.completion_submission->>'scopeHash' is distinct from p.approved_hash
 or ch.completion_submission->>'head' is distinct from p.verified_sha
 or ch.completion_submission->>'subtreeHash' is distinct from project_org_component_fingerprint(ch.id))
 then raise exception 'Current responsible director component submission required before superior acceptance';end if;
 if ch.kind='manager' then ev:=ev||jsonb_build_object('directorSubmission',ch.completion_submission);end if;
 update project_organization_nodes set status='accepted',evidence=ev,decision_needed=false where id=ch.id;
 end if;
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

revoke all on function project_org_decide_hierarchy(uuid,uuid,jsonb) from public,anon,authenticated,service_role;

-- Existing RPC lease and input validation remains intact. SECURITY DEFINER allows
-- only their validated metadata writes through the invoker-level payload guard.
alter function prepare_mission_development(uuid,uuid) security definer;
alter function checkpoint_mission_review_model(uuid,uuid,text,jsonb) security definer;
create function project_smart_metadata_guard() returns trigger language plpgsql security invoker set search_path=public as $$
begin
 if current_user in ('service_role','authenticated','anon') and exists(select 1 from agent_missions m join work_projects p on p.id=m.project_id where m.id=new.mission_id and p.organization_version=1)
 and (new.payload->'development_input' is distinct from old.payload->'development_input' or new.payload->'reviewModelCheckpoint' is distinct from old.payload->'reviewModelCheckpoint') then raise exception 'SMART execution metadata requires authenticated preparation or checkpoint RPC';end if;
 return new;
end $$;
create trigger project_smart_metadata before update on mission_assignments for each row execute function project_smart_metadata_guard();
revoke all on function project_smart_metadata_guard() from public,anon,authenticated,service_role;

create function project_smart_pending(p_mission uuid) returns boolean language plpgsql security definer set search_path=public as $$
declare pending_count integer;begin
 update project_organization_nodes leader set decision_needed=true,status='active' where leader.id in (
 select worker.parent_id from mission_assignments j join agent_missions m on m.id=j.mission_id
 join project_organization_nodes worker on worker.agent_id=j.agent_id and worker.project_id=m.project_id and worker.kind='worker'
 where m.id=p_mission and m.project_kind<>'management' and j.status in ('queued','awaiting_approval')
 and not exists(select 1 from project_worker_contracts c left join project_work_package_attempts a on a.package_id=c.package_id left join project_organization_work ow on ow.id=c.work_id
 where c.role=j.role and (a.mission_id=m.id or ow.mission_id=m.id or c.target_assignment=j.id)));
 get diagnostics pending_count = row_count;
 return pending_count>0;
end $$;
revoke all on function project_smart_pending(uuid) from public,anon,authenticated,service_role;

create or replace function project_org_schedule_hierarchy(p_project uuid,p_lease uuid) returns jsonb
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
 if not exists(select 1 from agent_missions where id=p.active_mission_id and status in ('completed','blocked')) and not project_smart_pending(p.active_mission_id) then return null;end if;
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
revoke all on function project_org_schedule_hierarchy(uuid,uuid) from public,anon,authenticated,service_role;

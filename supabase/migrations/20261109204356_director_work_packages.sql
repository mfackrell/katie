-- Director-owned execution extends the existing cumulative project lifecycle.
-- No historical project, authority, financial record or released migration changes.
create table project_work_packages (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references work_projects(id),
 manager_id uuid not null references project_organization_nodes(id), worker_id uuid not null references project_organization_nodes(id),
 writer_id uuid not null references project_organization_nodes(id), reviewer_id uuid not null references project_organization_nodes(id),
 milestone_index integer not null check(milestone_index>=0), scope_hash text not null,
 contract jsonb not null, contract_hash text not null, paths text[] not null,
 token_limit bigint not null check(token_limit>60000), ceiling_microusd numeric not null check(ceiling_microusd>0),
 deadline timestamptz not null, max_attempts integer not null check(max_attempts>0),
 status text not null default 'queued' check(status in ('queued','running','review','rejected','repair','accepted')),
 evidence jsonb, findings jsonb, commissioned_by uuid not null references mission_assignments(id),
 created_at timestamptz not null default now(), unique(project_id,milestone_index)
);
create table project_work_package_dependencies (
 package_id uuid not null references project_work_packages(id), depends_on uuid not null references project_work_packages(id),
 primary key(package_id,depends_on), check(package_id<>depends_on)
);
create table project_work_package_attempts (
 package_id uuid not null references project_work_packages(id), attempt integer not null,
 mission_id uuid not null unique references agent_missions(id), base_sha text not null,
 primary key(package_id,attempt)
);
-- Contracts and attempts have no caller-writable surface. Commands authenticate
-- their manager from the live management assignment; workers never issue them.
alter table project_work_packages enable row level security;
alter table project_work_package_dependencies enable row level security;
alter table project_work_package_attempts enable row level security;
revoke all on project_work_packages,project_work_package_dependencies,project_work_package_attempts from public,anon,authenticated,service_role;
grant select on project_work_packages,project_work_package_dependencies,project_work_package_attempts to service_role;

create function project_package_usage(p_package uuid) returns jsonb language sql stable security definer set search_path=public as $$
 select jsonb_build_object('tokens',coalesce(sum(tokens),0),'cost',coalesce(sum(cost),0)) from (
 select greatest(c.reserved_tokens,coalesce(c.actual_tokens,0)) tokens,c.organization_exposure_microusd cost
 from mission_calls c join mission_assignments j on j.id=c.job_id join project_work_package_attempts a on a.mission_id=j.mission_id where a.package_id=p_package
 union all
 select greatest(c.reserved_tokens,coalesce(c.actual_tokens,0)),e.exposure_microusd
 from benchmark_budget_calls c join benchmark_budget_accounts b on b.id=c.account_id join mission_assignments j on j.id=b.developer_task_id
 join project_work_package_attempts a on a.mission_id=j.mission_id left join benchmark_dollar_exposures e on e.call_id=c.id
 where a.package_id=p_package and c.legacy_mission_call_id is null) charges;
$$;

create function project_package_command(p_job uuid,p_lease uuid,c jsonb) returns void
language plpgsql security definer set search_path=public as $$
declare n project_organization_nodes;p work_projects;w project_work_packages;x project_organization_nodes;
 package_paths text[];wid uuid;contract jsonb;dep uuid;mid uuid;j mission_assignments;v jsonb;checks jsonb;
begin
 n:=project_org_principal(p_job,p_lease);select * into p from work_projects where id=n.project_id;
 if n.kind<>'manager' then raise exception 'Only the immediate Functional Director may commission or evaluate execution packages';end if;
 if c->>'action'='commission_package' then
 if p.approved_hash is null or p.approved_hash is distinct from p.approval_hash or not exists(select 1 from project_organization_authority where project_id=p.id and autonomous_execution)
 then raise exception 'Original approved scope and autonomous authority required';end if;
 if (c->>'milestoneIndex')::integer<p.milestone_index or (c->>'milestoneIndex')::integer>=jsonb_array_length(p.spec->'milestones')
 or length(coalesce(c->>'objective','')) not between 1 and 8000
 or jsonb_typeof(c->'deliverables') is distinct from 'array' or jsonb_array_length(c->'deliverables')<1
 or jsonb_typeof(c->'interfaces') is distinct from 'array'
 or jsonb_typeof(c->'acceptance') is distinct from 'array' or jsonb_array_length(c->'acceptance')<1
 or exists(select 1 from jsonb_array_elements_text(c->'acceptance') a where length(a)=0)
 or jsonb_typeof(c->'dependencies') is distinct from 'array'
 then raise exception 'Complete approved work package contract required';end if;
 package_paths:=array(select jsonb_array_elements_text(c->'paths'));
 if cardinality(package_paths)=0 or exists(select 1 from unnest(package_paths) path where path is null or path~'(^|/)\.\.?(/|$)' or path~'^/') or not exists(select 1 from project_organization_scope_grants g where g.node_id=n.id and g.scope_hash=p.approved_hash
 and not exists(select 1 from unnest(package_paths) path where not exists(select 1 from unnest(g.paths) prefix where path=prefix or right(prefix,1)='/' and starts_with(path,prefix))))
 then raise exception 'Package exceeds delegated scope';end if;
 -- Workers must be immediate reports, including technical composition/review.
 if (c->>'workerId')=(c->>'reviewerId') or (c->>'writerId')=(c->>'reviewerId') then raise exception 'Independent technical reviewer required';end if;
 foreach wid in array array[(c->>'workerId')::uuid,(c->>'writerId')::uuid,(c->>'reviewerId')::uuid] loop
 select * into x from project_organization_nodes where id=wid and project_id=p.id and parent_id=n.id and kind='worker' and status in ('active','accepted');
 if x.id is null or x.deadline<(c->>'deadline')::timestamptz or (wid=(c->>'workerId')::uuid and not 'development'=any(x.tools))
 or (wid in ((c->>'writerId')::uuid,(c->>'reviewerId')::uuid) and not 'analysis'=any(x.tools)) then raise exception 'Package requires immediately delegated capable workers';end if;
 if wid=(c->>'workerId')::uuid and not exists(select 1 from project_organization_scope_grants g where g.node_id=x.id and g.scope_hash=p.approved_hash
 and not exists(select 1 from unnest(package_paths) path where not exists(select 1 from unnest(g.paths) prefix where path=prefix or right(prefix,1)='/' and starts_with(path,prefix)))) then raise exception 'Package exceeds worker scope';end if;
 end loop;
 if (c->>'tokens')::bigint<=60000 or (c->>'tokens')::bigint+coalesce((select sum(token_limit) from project_work_packages where manager_id=n.id),0)>n.token_limit
 or (c->>'ceilingMicrousd')::numeric<=0 or (c->>'ceilingMicrousd')::numeric>(select ceiling_microusd from project_organization_authority where project_id=p.id)
 or (c->>'deadline')::timestamptz>least(n.deadline,p.deadline) or (c->>'deadline')::timestamptz<=now()
 or (c->>'maxAttempts')::integer not between 1 and p.max_cycles then raise exception 'Package resources exceed delegated authority';end if;
 contract:=jsonb_build_object('objective',c->'objective','deliverables',c->'deliverables','interfaces',c->'interfaces','acceptance',c->'acceptance',
 'milestone',p.spec->'milestones'->(c->>'milestoneIndex')::integer,'paths',c->'paths','dependencies',c->'dependencies',
 'tokens',c->'tokens','ceilingMicrousd',c->'ceilingMicrousd','deadline',c->'deadline','maxAttempts',c->'maxAttempts');
 insert into project_work_packages(project_id,manager_id,worker_id,writer_id,reviewer_id,milestone_index,scope_hash,contract,contract_hash,paths,token_limit,ceiling_microusd,deadline,max_attempts,commissioned_by)
 values(p.id,n.id,(c->>'workerId')::uuid,(c->>'writerId')::uuid,(c->>'reviewerId')::uuid,(c->>'milestoneIndex')::integer,p.approved_hash,contract,
 encode(sha256(convert_to(project_canonical(contract),'UTF8')),'hex'),package_paths,(c->>'tokens')::bigint,(c->>'ceilingMicrousd')::numeric,(c->>'deadline')::timestamptz,(c->>'maxAttempts')::integer,p_job) returning * into w;
 for dep in select value::uuid from jsonb_array_elements_text(c->'dependencies') loop
 if not exists(select 1 from project_work_packages where id=dep and project_id=p.id and scope_hash=p.approved_hash and milestone_index<w.milestone_index) then raise exception 'Package dependency must precede its consumer within the approved project';end if;
 insert into project_work_package_dependencies values(w.id,dep);
 end loop;
 else
 select * into w from project_work_packages where id=(c->>'packageId')::uuid and manager_id=n.id and project_id=p.id and scope_hash=p.approved_hash for update;
 if w.id is null or not exists(select 1 from project_organization_nodes where id=w.worker_id and parent_id=n.id) then raise exception 'Immediate package ownership required';end if;
 select mission_id into mid from project_work_package_attempts where package_id=w.id order by attempt desc limit 1;
 select * into j from mission_assignments where mission_id=mid and role='development';
 if c->>'action'='evaluate_package' then
 if w.status<>'review' or (c->>'assignmentId')::uuid is distinct from j.id then raise exception 'Current package attempt evidence required';end if;
 if c->>'accepted'='false' then
 if jsonb_typeof(c->'findings') is distinct from 'array' or jsonb_array_length(c->'findings')<1 then raise exception 'Rejection requires actionable findings';end if;
 update project_work_packages set status='rejected',findings=c->'findings',evidence=jsonb_build_object('assignmentId',j.id,'result',j.result,'decisionAssignment',p_job) where id=w.id;
 else
 v:=j.result->'verification';checks:=c->'checks';
 if c->>'accepted' is distinct from 'true' or (project_package_usage(w.id)->>'tokens')::bigint>w.token_limit or (project_package_usage(w.id)->>'cost')::numeric>w.ceiling_microusd or j.status<>'completed' or not exists(select 1 from agent_missions where id=mid and status='completed')
 or exists(select 1 from mission_calls call join mission_assignments job on job.id=call.job_id where job.mission_id=mid and (call.status<>'completed' or call.actual_tokens is null))
 or exists(select 1 from benchmark_budget_calls call join benchmark_budget_accounts acct on acct.id=call.account_id join mission_assignments job on job.id=acct.developer_task_id where job.mission_id=mid and call.state<>'settled')
 or v->>'testedHeadSha'!~'^[a-f0-9]{40}$' or v->>'testedHeadSha' is null or v->>'testedHeadSha' is distinct from v->>'reviewedHeadSha' or v->>'testedHeadSha' is distinct from v->>'observedHeadSha'
 or v->'projectAcceptance'->>'passed' is distinct from 'true' or v->'projectAcceptance'->>'headSha' is distinct from v->>'testedHeadSha'
 or v->'projectAcceptance'->>'projectId' is distinct from p.id::text
 or v->'projectAcceptance'->>'contractHash' is distinct from (select binding->>'contractHash' from project_runs where mission_id=mid)
 or v->'packageDelta'->>'baseSha' is distinct from (select base_sha from project_work_package_attempts where mission_id=mid)
 or v->'packageDelta'->>'headSha' is distinct from v->>'testedHeadSha'
 or jsonb_typeof(v->'packageDelta'->'changedFiles') is distinct from 'array' or jsonb_array_length(v->'packageDelta'->'changedFiles')<1
 or exists(select 1 from jsonb_array_elements(v->'packageDelta'->'changedFiles') f where not exists(select 1 from unnest(w.paths) prefix where f->>'path'=prefix or right(prefix,1)='/' and starts_with(f->>'path',prefix)))
 or jsonb_typeof(v->'projectAcceptance'->'checks') is distinct from 'array'
 or jsonb_array_length(v->'projectAcceptance'->'checks')<>jsonb_array_length(w.contract->'milestone'->'contract'->'scenarios')
 or exists(select 1 from jsonb_array_elements(v->'projectAcceptance'->'checks') with ordinality ck(v,i) where ck.v->>'passed' is distinct from 'true' or ck.v->>'name' is distinct from w.contract->'milestone'->'contract'->'scenarios'->(ck.i::int-1)->>'name')
 or jsonb_typeof(checks) is distinct from 'array' or jsonb_array_length(checks)<>jsonb_array_length(w.contract->'acceptance')
 or exists(select 1 from jsonb_array_elements_text(w.contract->'acceptance') criterion where not exists(select 1 from jsonb_array_elements(checks) ck where ck->>'criterion'=criterion and ck->>'passed'='true' and ck->>'assignmentId'=j.id::text and length(coalesce(ck->>'evaluation',''))>0))
 then raise exception 'Verified original package acceptance required';end if;
 update project_work_packages set status='accepted',evidence=jsonb_build_object('assignmentId',j.id,'result',j.result,'checks',checks,'head',v->>'testedHeadSha','decisionAssignment',p_job,'contractHash',w.contract_hash) where id=w.id;
 end if;
 elsif c->>'action'='repair_package' then
 if w.status<>'rejected' or (project_package_usage(w.id)->>'tokens')::bigint>=w.token_limit or (project_package_usage(w.id)->>'cost')::numeric>=w.ceiling_microusd or w.deadline<=now() or (select count(*) from project_work_package_attempts where package_id=w.id)>=w.max_attempts or p.cycles>=p.max_cycles
 then raise exception 'Bounded package repair unavailable';end if;
 if exists(select 1 from benchmark_budget_calls call join benchmark_budget_accounts a on a.id=call.account_id join mission_assignments job on job.id=a.developer_task_id where job.mission_id=mid and call.state<>'settled')
 then raise exception 'Unsettled package exposure prevents repair';end if;
 update project_work_packages set status='repair' where id=w.id;
 else raise exception 'Unknown package command';end if;
 end if;
end $$;

alter function project_org_decide(uuid,uuid,jsonb) rename to project_org_decide_hierarchy;
create function project_org_decide(p_job uuid,p_lease uuid,p_commands jsonb) returns boolean language plpgsql security definer set search_path=public as $$
declare c jsonb;forward jsonb:='[]';n project_organization_nodes;begin
 n:=project_org_principal(p_job,p_lease);
 if jsonb_typeof(p_commands)<>'array' or jsonb_array_length(p_commands) not between 1 and 16 then raise exception 'Bounded management commands required';end if;
 if exists(select 1 from jsonb_array_elements(p_commands) command where command->>'action' in ('commission_package','evaluate_package','repair_package')) and exists(select 1 from jsonb_array_elements(p_commands) command where command->>'action' not in ('commission_package','evaluate_package','repair_package','ready')) then raise exception 'Package decisions require a separate management turn after hierarchy changes';end if;
 for c in select value from jsonb_array_elements(p_commands) loop
 if c->>'action' in ('commission_package','evaluate_package','repair_package') then
 perform project_package_command(p_job,p_lease,c);forward:=forward||jsonb_build_array(jsonb_build_object('action','ready'));
 else
 if c->>'action' in ('reorganize','replace_leader') and exists(select 1 from project_work_packages w where w.status<>'accepted' and (w.manager_id=(c->>'nodeId')::uuid or (c->>'nodeId')::uuid in(w.worker_id,w.writer_id,w.reviewer_id))) then raise exception 'Outstanding package responsibility cannot be reorganized';end if;
 if c->>'action' in ('certify','submit_component') and exists(with recursive tree(id) as(select case when c->>'action'='certify' then (c->>'nodeId')::uuid else n.id end union all select x.id from project_organization_nodes x join tree t on x.parent_id=t.id) select 1 from project_work_packages w where (w.manager_id in(select id from tree) or w.worker_id in(select id from tree)) and w.status<>'accepted') then raise exception 'Unaccepted work packages prevent component certification';end if;
 forward:=forward||jsonb_build_array(c);
 end if;
 end loop;
 perform project_org_decide_hierarchy(p_job,p_lease,forward);
 update project_organization_decisions set decision=p_commands where assignment_id=p_job;
 return true;
end $$;

create or replace function public.finish_work_project_lifecycle(p_id uuid,p_lease uuid,p_action text,p_data jsonb default '{}') returns boolean language plpgsql security invoker set search_path=public as $$ declare p work_projects;mid uuid;kind text;seq integer;contract jsonb;binding jsonb;dev uuid;lead uuid;reviewer uuid;goal text;scope_data jsonb;wp project_work_packages;agents uuid[];begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));select * into p from work_projects where id=p_id for update;
 if not found or p.status<>'running' or p.lease is distinct from p_lease or p.lease_until<=now() or p.deadline<=now() then return false;end if;
 if p_action='child' then
  if p.active_mission_id is not null then raise exception 'A milestone is already bound';end if;
  seq:=(select count(*)+1 from project_runs where project_id=p.id);if seq>p.max_missions then update work_projects set status='blocked',detail='Project milestone allowance exhausted.' where id=p.id;else
   kind:=p_data->>'kind';goal:=p_data->>'objective';if kind is distinct from p.phase or kind not in ('research','specification','development','assessment') or length(goal) not between 1 and 12000 then raise exception 'Invalid project milestone';end if;
   if kind='development' and (p.approved_hash is distinct from p.approval_hash or p.approved_hash is null or p.cycles>=p.max_cycles or p.phase<>'development') then raise exception 'Approved coding allowance required';end if;
   agents:=p.team;
   if kind='development' and p.organization_version=1 then
    select * into wp from project_work_packages where project_id=p.id and milestone_index=p.milestone_index and status='queued' and scope_hash=p.approved_hash;
    if wp.id is null or wp.deadline<=now() or not exists(select 1 from project_organization_nodes org where id=wp.manager_id and org.kind='manager' and status='active')
    or exists(select 1 from project_work_package_dependencies d join project_work_packages x on x.id=d.depends_on where d.package_id=wp.id and x.status<>'accepted')
    then raise exception 'Director-commissioned executable package required';end if;
    if exists(select 1 from project_organization_nodes org where id in(wp.worker_id,wp.writer_id,wp.reviewer_id) and (parent_id<>wp.manager_id or org.kind<>'worker' or status not in ('active','accepted'))) then raise exception 'Package reporting authority changed';end if;
    agents:=array[(select agent_id from project_organization_nodes where id=wp.writer_id),(select agent_id from project_organization_nodes where id=wp.reviewer_id),(select agent_id from project_organization_nodes where id=wp.worker_id)];
    goal:=goal||E'\nDIRECTOR WORK PACKAGE (within approved milestone):\n'||wp.contract::text;
    if length(goal)>12000 then raise exception 'Work package exceeds bounded mission context';end if;
   end if;
   mid:=gen_random_uuid();perform create_mission(mid,goal,agents,120,case when kind='development' then p.repository_id else null end);
   if wp.id is not null then
    insert into project_work_package_attempts values(wp.id,(select count(*)+1 from project_work_package_attempts where package_id=wp.id),mid,coalesce(p.verified_sha,p.baseline_sha));
    update project_work_packages set status='running' where id=wp.id;
   end if;
   if length(coalesce((p_data->'evidence')::text,''))>30000 then raise exception 'Project evidence exceeds bounded context; narrow the acceptance package without dropping original requirements';end if;
   update agent_missions set token_allowance=least(120000,p.token_allowance,coalesce(wp.token_limit-(project_package_usage(wp.id)->>'tokens')::bigint,120000))::int,project_id=p.id,project_kind=kind,project_evidence=p_data->'evidence' where id=mid;perform control_mission(mid,'start');
   if kind='development' then
    contract:=p.spec->'milestones'->p.milestone_index->'contract';if contract is null then raise exception 'Approved milestone contract missing';end if;
    binding:=jsonb_build_object('version',1,'projectId',p.id,'baseSha',coalesce(p.verified_sha,p.baseline_sha),'baselineSha',p.baseline_sha,'allowedPaths',case when wp.id is null then p.spec->'allowedPaths' else to_jsonb(wp.paths) end,'contractHash',encode(sha256(convert_to(project_canonical(contract),'UTF8')),'hex'),'contract',contract,'scopeHash',p.approved_hash);
    if wp.id is not null then binding:=binding||jsonb_build_object('cumulativePaths',p.spec->'allowedPaths');end if;
    update agent_missions set deadline=least(p.deadline,coalesce(wp.deadline,p.deadline)) where id=mid;
    update mission_assignments set status='completed',result='{"output":"Server-owned approved project milestone; no planning inference was claimed."}' where mission_id=mid and job_key='plan';
    lead:=agents[1];reviewer:=agents[2];dev:=agents[3];
    insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload) values(mid,'implement','development',dev,'Implement the approved milestone in the full mission objective. Preserve all previous verified work. Run focused checks and satisfy the approved browser contract. Deliver an isolated draft PR only.','{}','{"capability":"development"}'),(mid,'compose','compose',lead,'Report the actual verified milestone result, draft PR, immutable commit and browser checks concisely. Do not reconstruct code or invent actions.',array['implement'],'{}'),(mid,'review','review',reviewer,'Verify the actual approved milestone against its original scope and immutable external evidence.',array['compose'],'{}');
    update work_projects set cycles=cycles+1 where id=p.id;
   end if;
   insert into project_runs(project_id,mission_id,kind,ordinal,milestone_index,binding) values(p.id,mid,kind,seq,p.milestone_index,binding);
   update work_projects set active_mission_id=mid,detail='Working on '||kind||' milestone.',updated_at=now() where id=p.id;
  end if;
 elsif p_action='spec' then
  if p.verified_sha is not null and p_data->>'baseline' is distinct from p.baseline_sha then raise exception 'Verified cumulative project baseline cannot be replaced by current main';end if;
  if p.phase<>'approval' and not exists(select 1 from agent_missions where id=p.active_mission_id and status='completed') then raise exception 'Reviewed specification required';end if;
  if p.approved_hash is not null then raise exception 'Approved specification is immutable';end if;
  update project_runs set outcome=jsonb_build_object('specification_reviewed',true) where mission_id=p.active_mission_id and outcome is null;
  scope_data:=jsonb_build_object('objective',p.objective,'clarifications',p.clarifications,'spec',p_data->'spec','repository',p.repository_id,'repository_name',(select repository_full_name from repo_sync_runs where id=p.repository_id),'baseline',p_data->>'baseline','max_cycles',p.max_cycles,'max_missions',p.max_missions,'token_allowance',p.token_allowance,'deadline',p.deadline);
  update work_projects set spec=p_data->'spec',repository_full_name=(select repository_full_name from repo_sync_runs where id=p.repository_id),baseline_sha=p_data->>'baseline',approval_hash=encode(sha256(convert_to(project_canonical(scope_data),'UTF8')),'hex'),active_mission_id=null,status=case when repository_id is null then 'awaiting_input' else 'awaiting_approval' end,phase='approval',detail=p_data->>'detail' where id=p.id;
 elsif p_action='advance' then
  if p.organization_version=1 and p.phase='development' and not exists(select 1 from project_work_packages w join project_work_package_attempts a on a.package_id=w.id join mission_assignments j on j.mission_id=a.mission_id and j.role='development' where a.mission_id=p.active_mission_id and w.status='accepted' and w.evidence->>'head'=p_data->>'head' and w.evidence->>'assignmentId'=j.id::text and w.evidence->'result'=j.result) then raise exception 'Responsible director acceptance required before progression';end if;
  if not exists(select 1 from agent_missions where id=p.active_mission_id and status='completed') then raise exception 'Reviewed milestone completion required';end if;
  update project_runs set outcome=p_data where mission_id=p.active_mission_id and outcome is null;
  if p.phase='development' then
   if p_data->>'head'!~'^[a-f0-9]{40}$' or not exists(
    select 1 from mission_assignments j join project_runs r on r.mission_id=j.mission_id where j.mission_id=p.active_mission_id and j.role='development' and j.status='completed'
    and r.binding->>'scopeHash'=p.approved_hash and j.result->'verification'->>'testedHeadSha'=p_data->>'head' and j.result->'verification'->>'reviewedHeadSha'=p_data->>'head'
    and j.result->'verification'->>'observedHeadSha'=p_data->>'head'
    and j.result->'verification'->'projectAcceptance'->>'passed'='true'
    and j.result->'verification'->'projectAcceptance'->>'headSha'=p_data->>'head'
    and j.result->'verification'->'projectAcceptance'->>'contractHash'=r.binding->>'contractHash'
    and j.result->'verification'->'projectAcceptance'->>'projectId'=p.id::text
   ) then raise exception 'Immutable reviewed head and approved browser evidence required';end if;
   update work_projects set verified_sha=p_data->>'head',milestone_index=milestone_index+1,phase=case when milestone_index+1>=jsonb_array_length(spec->'milestones') then 'delivery' else 'development' end,active_mission_id=null,detail='Verified coding increment saved.' where id=p.id;
  elsif p.phase='research' then update work_projects set phase='specification',active_mission_id=null,detail='Research reviewed. Developing the specification.' where id=p.id;
  else raise exception 'Unsupported milestone progression';end if;
 elsif p_action='preview' then
  if p.phase not in ('delivery','assessment') or p_data->>'immutable' is distinct from 'true' or p_data->>'headSha' is distinct from p.verified_sha or not exists(select 1 from project_runs r join agent_missions m on m.id=r.mission_id where r.project_id=p.id and r.kind='development' and m.status='completed' and r.outcome->>'head'=p.verified_sha) then raise exception 'Verified integrated preview required';end if;
  if p.active_mission_id is not null then update project_runs set outcome=jsonb_build_object('superseded',true,'reason','Deployment changed after assessment') where mission_id=p.active_mission_id and outcome is null;end if;
  update work_projects set preview=p_data,phase='browser_check',active_mission_id=null,detail='Same-head deployment found. Running the approved contract against the actual deployed application.' where id=p.id;
 elsif p_action='browser' then
  if p.phase<>'browser_check' or p.preview->>'immutable' is distinct from 'true' or p_data->>'passed' is distinct from 'true' or p_data->>'projectId' is distinct from p.id::text or p_data->>'headSha' is distinct from p.verified_sha or p_data->>'deploymentId' is distinct from p.preview->>'deploymentId' or p_data->>'statusId' is distinct from p.preview->>'statusId' or p_data->>'url' is distinct from p.preview->>'url' or p_data->>'contractHash' is distinct from encode(sha256(convert_to(project_canonical(p.spec->'finalContract'),'UTF8')),'hex') or jsonb_array_length(p_data->'checks') is distinct from jsonb_array_length(p.spec->'finalContract'->'scenarios') or exists(select 1 from jsonb_array_elements(p_data->'checks') with ordinality c(v,n) where c.v->>'passed' is distinct from 'true' or c.v->>'name' is distinct from p.spec->'finalContract'->'scenarios'->(c.n::int-1)->>'name') then raise exception 'Actual deployment-bound final browser acceptance required';end if;
  update work_projects set preview=preview||jsonb_build_object('browserAcceptance',p_data),phase='assessment',detail='Actual deployed browser contract passed. Performing independent whole-project assessment.' where id=p.id;
 elsif p_action='complete' then
  if p.phase<>'assessment' or p.preview->>'immutable' is distinct from 'true' or p.preview->'browserAcceptance'->>'passed' is distinct from 'true' or p.preview->'browserAcceptance'->>'headSha' is distinct from p.verified_sha or p.preview->'browserAcceptance'->>'deploymentId' is distinct from p.preview->>'deploymentId' or p.preview->'browserAcceptance'->>'statusId' is distinct from p.preview->>'statusId' or p.preview->>'headSha' is distinct from p.verified_sha or not exists(select 1 from agent_missions where id=p.active_mission_id and status='completed' and length(result)>0) or exists(select 1 from project_runs r join agent_missions m on m.id=r.mission_id where r.project_id=p.id and r.kind='development' and r.outcome is null and m.status<>'blocked') then raise exception 'Independent integrated project assessment required';end if;
  update project_runs set outcome=p_data where mission_id=p.active_mission_id;update work_projects set status='completed',result=p_data->>'result',detail='Integrated result independently approved and delivered to the original chat.' where id=p.id;
 elsif p_action in ('block','input','retry','wait','error') then
  if p_action='retry' then
   if p.organization_version=1 then
    update project_work_packages w set status='queued' from project_work_package_attempts a where a.package_id=w.id and a.mission_id=p.active_mission_id and w.status='repair';
    if not found then raise exception 'Responsible director must authorize bounded repair';end if;
   end if;
   if p.cycles>=p.max_cycles then update work_projects set status='blocked',detail='Project coding-cycle allowance exhausted.' where id=p.id;else
    update project_runs set outcome=p_data where mission_id=p.active_mission_id and outcome is null;
    update work_projects set phase='development',milestone_index=least(milestone_index,jsonb_array_length(spec->'milestones')-1),active_mission_id=null,detail=p_data->>'detail' where id=p.id;
   end if;
  elsif p_action='error' then update work_projects set failures=failures+1,status=case when failures>=2 then 'blocked' else status end,detail=p_data->>'detail' where id=p.id;
  elsif p_action='input' then update work_projects set status='awaiting_input',detail=p_data->>'detail' where id=p.id;
  elsif p_action='block' then update work_projects set status='blocked',detail=p_data->>'detail' where id=p.id;
  else update work_projects set detail=coalesce(p_data->>'detail',detail) where id=p.id;end if;
 else raise exception 'Unknown project outcome';end if;
 insert into project_events(project_id,event,data) values(p.id,p_action,p_data);
 update work_projects set lease=null,lease_until=null,failures=case when p_action='error' then failures else 0 end,updated_at=now() where id=p.id;
 select * into strict p from work_projects where id=p.id;
 if p.status='awaiting_approval' and p.spec is not null then perform project_publish(p.id,project_scope_proposal(p.id));elsif p_action<>'wait' or p.status<>'running' then perform project_publish(p.id,coalesce(p.result,p.detail,p.status));end if;
 return true;
end $$;

create or replace function project_org_bind_assignment() returns trigger language plpgsql security definer set search_path=public as $$
declare n project_organization_nodes; begin
 if exists(select 1 from project_work_packages w join project_work_package_attempts a on a.package_id=w.id where a.mission_id=new.mission_id and
 (new.role not in ('plan','development','compose','review','revise') or new.agent_id is distinct from (select agent_id from project_organization_nodes where id=case when new.role='development' then w.worker_id when new.role='review' then w.reviewer_id else w.writer_id end))) then raise exception 'Assignment cannot bypass commissioned package ownership';end if;
 select x.* into n from project_organization_nodes x join agent_missions m on m.project_id=x.project_id where m.id=new.mission_id and x.agent_id=new.agent_id and x.kind='worker';
 if n.id is null and exists(select 1 from agent_missions m join work_projects p on p.id=m.project_id where m.id=new.mission_id and m.project_kind<>'management' and p.organization_version=1) then raise exception 'Assignment lacks appointed execution owner';end if;
 if n.id is not null then
 if n.deadline<=now() or ((new.payload->>'capability' in ('analysis','writing') or new.role in ('plan','compose','revise','review')) and not 'analysis'=any(n.tools)) or (new.role='development' and not 'development'=any(n.tools)) or (new.payload->>'capability'='research' and not 'research'=any(n.tools)) or (new.payload->>'capability'='repository_review' and not 'repository_review'=any(n.tools)) then raise exception 'Assignment exceeds delegated execution authority';end if;
 if exists(with recursive ancestors(id,parent_id) as(select n.id,n.parent_id union all select x.id,x.parent_id from project_organization_nodes x join ancestors a on x.id=a.parent_id) select 1 from project_organization_dependencies d join project_organization_nodes dependency on dependency.id=d.depends_on where d.node_id in(select id from ancestors) and dependency.status<>'accepted') then raise exception 'Unaccepted organizational dependency';end if;
 if new.role='development' and not exists(select 1 from work_projects p join project_organization_scope_grants g on g.node_id=n.id and g.scope_hash=p.approved_hash where p.id=n.project_id and p.approved_hash=p.approval_hash and not exists(select 1 from jsonb_array_elements_text(coalesce((select to_jsonb(w.paths) from project_work_packages w join project_work_package_attempts a on a.package_id=w.id where a.mission_id=new.mission_id),p.spec->'allowedPaths')) path where not exists(select 1 from unnest(g.paths) prefix where path=prefix or right(prefix,1)='/' and starts_with(path,prefix)))) then raise exception 'Coding scope not delegated to worker';end if;
 update project_organization_nodes set status='active',evidence=null where id in (with recursive ancestors(id,parent_id) as(select n.id,n.parent_id union all select x.id,x.parent_id from project_organization_nodes x join ancestors a on x.id=a.parent_id) select id from ancestors);
 insert into project_organization_assignments values(new.id,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex'),now()) on conflict do nothing;
 end if;return new;
end $$;

alter function project_org_schedule(uuid,uuid) rename to project_org_schedule_hierarchy;
create function project_org_schedule(p_project uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare p work_projects;w project_work_packages;r jsonb;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project and lease=p_lease and p_lease is not null and lease_until>now() and status='running' and deadline>now();
 if p.id is null then raise exception 'Project lease required';end if;
 select x.* into w from project_work_packages x join project_work_package_attempts a on a.package_id=x.id where a.mission_id=p.active_mission_id;
 if w.id is not null then
 if w.status='repair' then
 perform finish_work_project(p.id,p_lease,'retry',jsonb_build_object('findings',w.findings,'detail','Responsible Functional Director commissioned bounded correction; all prior records retained.'));
 return jsonb_build_object('handled',true);
 end if;
 if w.status in ('running','review','rejected') and exists(select 1 from agent_missions where id=p.active_mission_id and status in ('completed','blocked','stopped')) then
 update project_work_packages set status='review' where id=w.id and status='running';
 update project_organization_nodes set decision_needed=true where id=w.manager_id;
 -- Existing scheduler runs the lowest responsible manager and restores this
 -- exact execution mission after the management decision. Root is not involved.
 end if;
 end if;
 r:=project_org_schedule_hierarchy(p_project,p_lease);
 if r is null and p.organization_version=1 and p.phase='development' and p.active_mission_id is null
 and not exists(select 1 from project_work_packages where project_id=p.id and milestone_index=p.milestone_index and status='queued')
 then return jsonb_build_object('waiting',true,'detail','Functional Director must commission the next approved coding package.');end if;
 return r;
end $$;

create function project_package_admission(p_mission uuid,p_tokens bigint,p_cost numeric) returns void language plpgsql security definer set search_path=public as $$
declare w project_work_packages;usage jsonb;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select x.* into w from project_work_packages x join project_work_package_attempts a on a.package_id=x.id where a.mission_id=p_mission;
 if w.id is null then return;end if;
 usage:=project_package_usage(w.id);
 if w.status<>'running' or w.deadline<=now() or (usage->>'tokens')::bigint+p_tokens>w.token_limit or (usage->>'cost')::numeric+p_cost>w.ceiling_microusd
 or exists(select 1 from project_organization_nodes where id in(w.worker_id,w.writer_id,w.reviewer_id) and (parent_id<>w.manager_id or kind<>'worker' or status<>'active'))
 then raise exception 'Work package authority exhausted or changed';end if;
end $$;
create function project_package_call_guard() returns trigger language plpgsql security definer set search_path=public as $$
declare mid uuid;begin
 if tg_table_name='mission_calls' then
 select mission_id into mid from mission_assignments where id=new.job_id;
 perform project_package_admission(mid,new.reserved_tokens,coalesce(new.organization_exposure_microusd,0));
 elsif tg_table_name='benchmark_budget_calls' then
 if new.legacy_mission_call_id is not null then return new;end if;
 select j.mission_id into mid from benchmark_budget_accounts a join mission_assignments j on j.id=a.developer_task_id where a.id=new.account_id;
 perform project_package_admission(mid,new.reserved_tokens,0);
 else
 if exists(select 1 from benchmark_budget_calls where id=new.call_id and legacy_mission_call_id is not null) then return new;end if;
 select j.mission_id into mid from benchmark_budget_accounts a join mission_assignments j on j.id=a.developer_task_id where a.id=new.account_id;
 perform project_package_admission(mid,0,new.exposure_microusd);
 end if;return new;
end $$;
-- Alphabetical order: existing org pricing/admission runs before this cap.
create trigger project_package_call_admission before insert on mission_calls for each row execute function project_package_call_guard();
create trigger project_package_native_admission before insert on benchmark_budget_calls for each row execute function project_package_call_guard();
create trigger project_package_native_cost before insert on benchmark_dollar_exposures for each row execute function project_package_call_guard();

alter function project_org_prepare_native(uuid,uuid) rename to project_org_prepare_native_hierarchy;
create function project_org_prepare_native(p_task uuid,p_lease uuid) returns boolean language plpgsql security definer set search_path=public as $$
declare j mission_assignments;w project_work_packages;r project_runs;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_task;
 select x.* into w from project_work_packages x join project_work_package_attempts a on a.package_id=x.id where a.mission_id=j.mission_id;
 select * into r from project_runs where mission_id=j.mission_id;
 if w.id is null or w.status<>'running' or not exists(select 1 from project_organization_nodes where id=w.worker_id and agent_id=j.agent_id and parent_id=w.manager_id and kind='worker')
 or r.binding->'allowedPaths' is distinct from to_jsonb(w.paths) or r.binding->>'scopeHash' is distinct from w.scope_hash
 then raise exception 'Native dispatch requires director-owned package binding';end if;
 perform project_package_admission(j.mission_id,0,0);
 return project_org_prepare_native_hierarchy(p_task,p_lease);
end $$;

-- Only lease-bound public entry points remain callable; no direct legacy/helper bypass.
revoke all on function project_org_decide_hierarchy(uuid,uuid,jsonb),project_org_schedule_hierarchy(uuid,uuid),project_org_prepare_native_hierarchy(uuid,uuid),
 project_package_usage(uuid),project_package_command(uuid,uuid,jsonb),project_package_admission(uuid,bigint,numeric),project_package_call_guard(),
 finish_work_project_lifecycle(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function project_org_decide(uuid,uuid,jsonb),project_org_schedule(uuid,uuid),project_org_prepare_native(uuid,uuid) from public,anon,authenticated;
grant execute on function project_org_decide(uuid,uuid,jsonb),project_org_schedule(uuid,uuid),project_org_prepare_native(uuid,uuid) to service_role;

-- Actual usage is never erased to fit a contract. Excess exposure keeps the
-- package unaccepted and wakes the responsible organization for a resource exception.
create function project_package_settlement() returns trigger language plpgsql security definer set search_path=public as $$
declare mid uuid;w project_work_packages;usage jsonb;begin
 if tg_table_name='mission_calls' then select mission_id into mid from mission_assignments where id=new.job_id;
 else select j.mission_id into mid from benchmark_budget_accounts a join mission_assignments j on j.id=a.developer_task_id where a.id=new.account_id;end if;
 select x.* into w from project_work_packages x join project_work_package_attempts a on a.package_id=x.id where a.mission_id=mid;
 if w.id is null then return new;end if;
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));usage:=project_package_usage(w.id);
 if (usage->>'tokens')::bigint>w.token_limit or (usage->>'cost')::numeric>w.ceiling_microusd then
 update project_work_packages set status='review',evidence=null where id=w.id;
 update project_organization_nodes set decision_needed=true,status='active',evidence=null where id=w.manager_id;
 insert into project_organization_exceptions(project_id,origin_id,owner_id,reason,detail) values(w.project_id,w.worker_id,w.manager_id,'resources','Actual package exposure exceeded delegated capacity; settlement preserved. Package '||w.id);
 end if;return new;
end $$;
create trigger project_package_settled_call after update on mission_calls for each row execute function project_package_settlement();
create trigger project_package_settled_native after update on benchmark_dollar_exposures for each row execute function project_package_settlement();
revoke all on function project_package_settlement() from public,anon,authenticated,service_role;

-- Mission 104: authorize only the already-commissioned package.
-- Installing this migration grants no owner consent, starts no mission,
-- and leaves all historical receipts and package records intact.
create table public.project_package_execution_receipts(
 project_id uuid primary key references public.work_projects(id),
 package_id uuid not null unique references public.project_work_packages(id),
 authorization_id uuid not null unique,
 prior_authorization_id uuid not null, owner_id uuid not null,
 release_sha text not null, release_generation bigint not null, deployment_id text not null,
 scope_hash text not null, cutoff timestamptz not null, state_hash text not null,
 contract_fingerprint text not null, historical_mission_ids uuid[] not null check(cardinality(historical_mission_ids)=104),
 terms jsonb not null, authorization_txid bigint not null default txid_current(),
 authorized_at timestamptz not null default clock_timestamp()
);
alter table public.project_package_execution_receipts enable row level security;
revoke all on public.project_package_execution_receipts from public,anon,authenticated,service_role;
create trigger package_execution_receipt_immutable before update or delete on public.project_package_execution_receipts
 for each row execute function public.project_org_change_immutable();

create function public.project_org_package_execution_required(p_project uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_package_execution_receipts where project_id=p_project)
$$;

create function public.project_org_package_execution_fingerprint(p_package uuid) returns text
language sql stable security definer set search_path=public,pg_temp as $$
 select encode(sha256(convert_to(project_canonical(jsonb_build_object(
  'package',to_jsonb(w)-'status'-'evidence'-'findings',
  'contracts',(select jsonb_agg(to_jsonb(c) order by c.id) from project_worker_contracts c where c.package_id=w.id),
  'principals',(select jsonb_agg(jsonb_build_object('node',to_jsonb(n)-'status'-'decision_needed'-'evidence'-'completion_submission',
    'agent',jsonb_build_object('id',a.id,'version',a.version,'archived',a.archived,'config',a.config)) order by n.id)
    from project_organization_nodes n join managed_agents a on a.id=n.agent_id where n.id in(w.manager_id,w.worker_id,w.writer_id,w.reviewer_id)),
  'grants',(select jsonb_agg(to_jsonb(g) order by g.node_id) from project_organization_scope_grants g join project_organization_nodes n on n.id=g.node_id where n.project_id=w.project_id),
  'dependencies',(select jsonb_agg(to_jsonb(d) order by to_jsonb(d)::text) from project_work_package_dependencies d where d.package_id=w.id),
  'spec',p.spec,'objective',p.objective,'clarifications',p.clarifications,'baseline',p.baseline_sha
 )),'UTF8')),'hex') from project_work_packages w join work_projects p on p.id=w.project_id where w.id=p_package
$$;

create function public.project_org_package_execution_offer(p_owner uuid,p_project uuid,p_release text) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare p work_projects; w project_work_packages; g project_retest_production_release_gate;
 a project_provider_execution; prior project_coding_capacity_resume_receipts; f text; h text; terms jsonb;
begin
 select * into p from work_projects where id=p_project;
 select * into w from project_work_packages where id='f88d4d10-dfe4-479e-a2cf-41b3e8209e47' and project_id=p_project;
 select * into g from project_retest_production_release_gate where project_id=p_project;
 select * into a from project_provider_execution where project_id=p_project;
 select * into prior from project_coding_capacity_resume_receipts where project_id=p_project and historical_missions=103;
 if p.id is distinct from 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid or p_owner is null or a.owner_id is distinct from p_owner
 or standalone_verify_scope(p_owner,p.actor_id,p.chat_id) is distinct from true
 or prior.owner_id is distinct from p_owner or prior.approved_max_missions is distinct from 104
 or g.state is distinct from 'active' or g.release_sha is distinct from p_release or g.alias_name is distinct from 'katie-mu.vercel.app'
 or p.status is distinct from 'paused' or p.phase is distinct from 'development' or p.max_missions is distinct from 104
 or p.detail is distinct from 'Owner-authorized commissioning complete; development package queued; further execution requires separate approval.'
 or p.active_mission_id is not null or p.lease is not null or p.lease_until is not null
 or p.cycles is distinct from 0 or p.max_cycles is distinct from 3 or p.milestone_index is distinct from 0 or p.token_allowance is distinct from 600000
 or p.deadline<=clock_timestamp()+interval '5 minutes' or p.deadline is distinct from prior.cutoff or p.deadline is distinct from a.deadline
 or p.approved_hash is distinct from p.approval_hash or p.approved_hash is distinct from a.approved_scope or p.approved_hash is distinct from prior.scope_hash
 or not project_provider_mode(p.id) or not project_provider_continued(p.id)
 or project_org_coding_capacity_final_roles_valid(p.id) is distinct from true
 or w.id is null or w.status is distinct from 'queued' or w.milestone_index is distinct from 0 or w.max_attempts is distinct from 3
 or w.deadline is distinct from p.deadline or w.scope_hash is distinct from p.approved_hash
 or w.worker_id is distinct from w.writer_id or w.worker_id=w.reviewer_id
 or w.contract_hash is distinct from encode(sha256(convert_to(project_canonical(w.contract),'UTF8')),'hex')
 or (select count(*) from project_work_packages where project_id=p.id)<>1
 or exists(select 1 from project_work_package_attempts where package_id=w.id)
 or exists(select 1 from project_work_package_dependencies where package_id=w.id)
 or (select count(*) from project_worker_contracts c where c.package_id=w.id)<>3
 or (select count(*) from project_worker_contracts c join project_organization_nodes n on n.id=c.worker_id join managed_agents ma on ma.id=n.agent_id
   where c.package_id=w.id and c.project_id=p.id and c.manager_id=w.manager_id and c.scope_hash=w.scope_hash
   and c.deadline=w.deadline and c.max_assignments>=3 and c.agent_version=ma.version
   and ((c.role='development' and c.worker_id=w.worker_id) or (c.role='compose' and c.worker_id=w.writer_id) or (c.role='review' and c.worker_id=w.reviewer_id)))<>3
 or (select count(*) from agent_missions where project_id=p.id)<>104
 or exists(select 1 from agent_missions m where m.project_id=p.id and (m.project_kind<>'management' or m.status not in('completed','blocked','stopped','failed')))
 or exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=p.id and (j.lease is not null or j.lease_until is not null or j.status not in('completed','failed','blocked','stopped','cancelled','canceled')))
 or exists(select 1 from project_runs where project_id=p.id) or project_provider_request_pending(p.id)
 or project_org_package_execution_required(p.id)
 or not exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
   join project_organization_decisions d on d.assignment_id=j.id and d.project_id=p.id and d.node_id=w.manager_id
   where j.id=w.commissioned_by and m.project_id=p.id and m.status='completed' and j.status='completed'
   and m.project_evidence->>'codingCapacityAuthorizationId'=prior.authorization_id::text
   and exists(select 1 from project_provider_requests q where q.assignment_id=j.id and q.operation='inference' and q.resolved_at is not null and q.provider_receipt is not null))
 or not exists(select 1 from project_events e where e.project_id=p.id and e.event='coding_capacity_finished' and e.data->>'packageId'=w.id::text and e.data->>'authorizationId'=prior.authorization_id::text and e.data->>'usedMissions'='104')
 then raise exception 'Exact unexecuted Mission 104 package and authenticated owner required';end if;
 f:=project_org_package_execution_fingerprint(w.id);
 -- Three saved attempts, three evaluations and up to two separate repair decisions.
 -- Native 12-call cap per dispatch is NEW explicit authorization, not predicted usage.
 terms:=jsonb_build_object('historicalMissions',104,'additionalMissions',8,'maxMissions',112,
  'developmentAttempts',3,'codingDispatches',3,'nativeInferencePerDispatch',12,'nativeInferenceLimit',36,
  'compositionLimit',3,'reviewLimit',3,'managerEvaluationLimit',3,'managerRepairLimit',2,'paidInferenceLimit',47,
  'automaticRetries',0,'nativeAutomaticRepairs',0,'tokenAllowance',600000,'additionalTokens',0,
  'spendMode','provider-account','dollarCeilingMicrousd',null,'stopAt','package-acceptance');
 h:=encode(sha256(convert_to(project_canonical(jsonb_build_object('checkpoint',project_org_coding_capacity_state(p.id),
 'packageFingerprint',f,'priorReceipt',to_jsonb(prior),'terms',terms)),'UTF8')),'hex');
 return jsonb_build_object('stage','authorize','projectId',p.id,'packageId',w.id,'priorAuthorizationId',prior.authorization_id,
 'releaseSha',g.release_sha,'releaseGeneration',g.generation,'deploymentId',g.deployment_id,'scopeHash',w.scope_hash,'cutoff',p.deadline,
 'stateHash',h,'contractFingerprint',f,'managerId',w.manager_id,'coderId',w.worker_id,'writerId',w.writer_id,'reviewerId',w.reviewer_id,
 'paths',w.paths,'developmentPaths',(select c.contract->'paths' from project_worker_contracts c where c.package_id=w.id and c.role='development'),
 'terms',terms);
end $$;

create function public.project_org_package_execution_authorize(p_owner uuid,p_project uuid,p_package uuid,p_release text,p_generation bigint,p_deployment text,p_authorization uuid,p_state_hash text,p_terms jsonb,p_consent boolean) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare o jsonb; p work_projects; stamp timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 select * into p from work_projects where id=p_project for update;
 perform 1 from project_retest_production_release_gate where project_id=p_project for update;
 perform 1 from project_work_packages where id=p_package and project_id=p_project for update;
 perform 1 from project_worker_contracts where package_id=p_package order by id for update;
 perform 1 from project_organization_nodes where project_id=p_project order by id for update;
 o:=project_org_package_execution_offer(p_owner,p_project,p_release);
 if p_consent is distinct from true or p_authorization is null or p_package is distinct from (o->>'packageId')::uuid
 or p_generation is distinct from (o->>'releaseGeneration')::bigint or p_deployment is distinct from o->>'deploymentId'
 or p_state_hash is distinct from o->>'stateHash' or p_terms is distinct from o->'terms'
 or exists(select 1 from project_coding_capacity_receipts where authorization_id=p_authorization)
 or exists(select 1 from project_coding_capacity_resume_receipts where authorization_id=p_authorization)
 then raise exception 'Exact fresh package execution consent required';end if;
 stamp:=clock_timestamp();
 insert into project_package_execution_receipts(project_id,package_id,authorization_id,prior_authorization_id,owner_id,release_sha,release_generation,deployment_id,scope_hash,cutoff,state_hash,contract_fingerprint,historical_mission_ids,terms,authorized_at)
 values(p.id,p_package,p_authorization,(o->>'priorAuthorizationId')::uuid,p_owner,p_release,p_generation,p_deployment,o->>'scopeHash',(o->>'cutoff')::timestamptz,p_state_hash,o->>'contractFingerprint',
 array(select id from agent_missions where project_id=p.id order by id),p_terms,stamp);
 perform authorize_work_project_resources(p.id,p.actor_id,p.chat_id,600000,null,112,null,p_authorization,
 'Authenticated owner: existing Mission 104 package only; ceiling 112, three native dispatches and 47 paid inferences maximum, zero automatic retries, no scope/deadline/token increase or downstream authority.');
 update work_projects set status='running',detail='Owner-authorized existing package execution; awaiting normal scheduler',
 progress_since=stamp,progress_signature=null,error_signature=null,repeated_errors=0,impediment=null,updated_at=stamp
 where id=p.id and status='paused' and active_mission_id is null and max_missions=112;
 if not found then raise exception 'Atomic package authorization failed';end if;
 insert into project_events(project_id,event,data) values(p.id,'package_execution_authorized',o||jsonb_build_object('authorizationId',p_authorization));
 return o||jsonb_build_object('stage','authorized','authorizationId',p_authorization,'authorizedAt',stamp);
end $$;

create function public.project_org_package_execution_live(p_project uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_package_execution_receipts r join work_projects p on p.id=r.project_id
 join project_work_packages w on w.id=r.package_id and w.project_id=p.id
 join project_retest_production_release_gate g on g.project_id=p.id join project_provider_execution a on a.project_id=p.id
 where p.id=p_project and p.status='running' and p.phase='development' and p.milestone_index=0 and p.max_missions=112 and p.max_cycles=3
 and p.approved_hash=r.scope_hash and p.approval_hash=r.scope_hash and a.approved_scope=r.scope_hash and a.owner_id=r.owner_id
 and p.deadline=r.cutoff and w.deadline=r.cutoff and a.deadline=r.cutoff and r.cutoff>clock_timestamp()
 and g.state='active' and g.release_sha=r.release_sha and g.generation=r.release_generation and g.deployment_id=r.deployment_id and g.alias_name='katie-mu.vercel.app'
 and p.token_allowance=600000 and project_provider_continued(p.id)
 and project_org_package_execution_fingerprint(w.id)=r.contract_fingerprint
 and (select count(*) from agent_missions where project_id=p.id and id=any(r.historical_mission_ids))=104
 and (select count(*) from agent_missions where project_id=p.id)<=112
 and (select count(*) from project_work_packages where project_id=p.id)=1
 and (select count(*) from project_work_package_attempts where package_id=w.id)<=3)
$$;

create function public.project_org_package_execution_assignment(p_job uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
 join work_projects p on p.active_mission_id=m.id and p.id=m.project_id
 join project_package_execution_receipts r on r.project_id=p.id join project_work_packages w on w.id=r.package_id
 join project_organization_nodes n on n.id=case j.role when 'development' then w.worker_id when 'compose' then w.writer_id when 'review' then w.reviewer_id when 'work' then w.manager_id end
 where j.id=p_job and n.agent_id=j.agent_id and n.status in('active','accepted') and n.deadline>clock_timestamp()
 and m.status='running' and m.deadline>clock_timestamp() and not m.id=any(r.historical_mission_ids)
 and m.project_evidence->>'packageExecutionAuthorizationId'=r.authorization_id::text
 and project_org_package_execution_live(p.id) and project_provider_continued_assignment(j.id)
 and ((m.project_kind='development' and w.status='running' and j.role in('development','compose','review')
   and exists(select 1 from project_work_package_attempts pa where pa.package_id=w.id and pa.mission_id=m.id and pa.attempt between 1 and 3))
 or (m.project_kind='management' and w.status in('review','rejected') and j.role='work'
   and m.project_evidence->>'organizationNodeId'=w.manager_id::text
   and exists(select 1 from project_work_package_attempts pa where pa.package_id=w.id and pa.mission_id::text=m.project_evidence->>'previousMissionId'))))
$$;

create function public.project_org_package_execution_claim(p_project uuid,p_release text,p_generation bigint,p_deployment text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_package_execution_receipts r join work_projects p on p.id=r.project_id
 join mission_assignments j on j.mission_id=p.active_mission_id
 where r.project_id=p_project and r.release_sha=p_release and r.release_generation=p_generation and r.deployment_id=p_deployment
 and j.status in('queued','waiting_external') and project_org_package_execution_assignment(j.id))
$$;

create function public.project_org_package_execution_request(p_job uuid,p_attempt text,p_operation text,p_scope text) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare j mission_assignments; m agent_missions; r project_package_execution_receipts; n int;
begin
 select * into j from mission_assignments where id=p_job;
 select * into m from agent_missions where id=j.mission_id;
 select * into r from project_package_execution_receipts where project_id=m.project_id;
 if r.project_id is null or not project_org_package_execution_assignment(p_job) or project_provider_request_pending(r.project_id) then return false;end if;
 if (select count(*) from project_provider_requests q where q.project_id=r.project_id and q.operation='inference' and not q.mission_id=any(r.historical_mission_ids))>=47 then return false;end if;
 if p_scope is null then
  if j.role not in('work','compose','review') or j.status<>'running' or j.lease::text is distinct from p_attempt or j.lease_until<=clock_timestamp()
  or p_operation not in('model-list','inference') or exists(select 1 from project_provider_requests q where q.assignment_id=j.id and q.operation=p_operation)
  or (p_operation='inference' and not exists(select 1 from project_provider_requests q where q.assignment_id=j.id and q.execution_attempt=p_attempt and q.operation='model-list' and q.resolved_at is not null)) then return false;end if;
  return true;
 end if;
 if j.role<>'development' or p_scope is distinct from r.scope_hash or p_operation not in('input-count','inference')
 or not exists(select 1 from project_provider_dispatches where task_id=j.id and run_id=p_attempt) then return false;end if;
 select count(*) into n from project_provider_requests q where q.assignment_id=j.id and q.operation=p_operation;
 if n>=12 then return false;end if;
 if p_operation='inference' and (select count(*) from project_provider_requests q where q.assignment_id=j.id and q.execution_attempt=p_attempt and q.operation='input-count' and q.resolved_at is not null)<=n then return false;end if;
 return true;
end $$;

create function public.project_org_package_execution_schedule(p_project uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare p work_projects; r project_package_execution_receipts; w project_work_packages; m agent_missions; result jsonb; attempts int; mgmt int;
begin
 select * into p from work_projects where id=p_project and status='running' and lease=p_lease and p_lease is not null and lease_until>now();
 if p.id is null then raise exception 'Project lease required';end if;
 select * into r from project_package_execution_receipts where project_id=p.id;
 select * into w from project_work_packages where id=r.package_id;
 if not project_org_package_execution_live(p.id) then return jsonb_build_object('blocked','Package execution authorization expired or changed');end if;
 if project_provider_request_pending(p.id) then return jsonb_build_object('waiting',true,'detail','Awaiting existing provider settlement');end if;
 select count(*) into attempts from project_work_package_attempts where package_id=w.id;
 select count(*) into mgmt from agent_missions where project_id=p.id and project_kind='management' and not id=any(r.historical_mission_ids);
 if p.active_mission_id is null then
  if w.status='queued' and attempts<3 and (select count(*) from agent_missions where project_id=p.id)<112 then return null;end if;
  return jsonb_build_object('blocked','No further authorized package attempt');
 end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id;
 if m.project_evidence->>'packageExecutionAuthorizationId' is distinct from r.authorization_id::text then raise exception 'Unexpected active package mission';end if;
 if m.project_kind='management' then
  if m.status in('blocked','failed','stopped') then return jsonb_build_object('blocked','Package management failed; no automatic retry');end if;
  return jsonb_build_object('waiting',true);
 end if;
 if m.project_kind<>'development' or not exists(select 1 from project_work_package_attempts where package_id=w.id and mission_id=m.id) then raise exception 'Unexpected package attempt';end if;
 if w.status='accepted' then return null;end if;
 if m.status not in('completed','blocked','stopped','failed') then return null;end if;
 if w.status='rejected' and attempts>=3 then return jsonb_build_object('blocked','Authorized package correction attempts exhausted');end if;
 if w.status<>'repair' and (mgmt>=5 or (select count(*) from agent_missions where project_id=p.id)>=112) then return jsonb_build_object('blocked','Authorized package management capacity exhausted');end if;
 result:=project_org_schedule_before_exception_recovery(p_project,p_lease);
 if result->>'missionId' is not null then
  update agent_missions mm set project_evidence=mm.project_evidence||jsonb_build_object('packageExecutionAuthorizationId',r.authorization_id)
   where mm.id::text=result->>'missionId' and mm.project_id=p.id and mm.project_kind='management'
   and mm.project_evidence->>'organizationNodeId'=w.manager_id::text and mm.project_evidence->>'previousMissionId'=m.id::text
   and not mm.id=any(r.historical_mission_ids);
  if not found then raise exception 'Scheduler attempted work outside exact package management';end if;
 end if;
 return coalesce(result,jsonb_build_object('blocked','Package manager decision unavailable'));
end $$;

create function public.project_org_package_execution_commands(p_job uuid,p_lease uuid,p_commands jsonb) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare w project_work_packages; r project_package_execution_receipts; m agent_missions; j mission_assignments; expected_action text;
begin
 select * into j from mission_assignments where id=p_job; select * into m from agent_missions where id=j.mission_id;
 select * into r from project_package_execution_receipts where project_id=m.project_id; select * into w from project_work_packages where id=r.package_id;
 if not project_org_package_execution_assignment(p_job) or j.role<>'work' or m.project_kind<>'management'
 or j.lease is distinct from p_lease or j.lease_until<=clock_timestamp() or j.status<>'running'
 or jsonb_typeof(p_commands) is distinct from 'array' or jsonb_array_length(p_commands) not between 1 and 2
 or m.calls<>1 or project_provider_request_pending(r.project_id)
 or not exists(select 1 from project_provider_requests q where q.assignment_id=j.id and q.execution_attempt=p_lease::text and q.operation='inference' and q.resolved_at is not null and q.provider_receipt is not null)
 then raise exception 'Exact package manager lease and settled inference required';end if;
 expected_action:=case w.status when 'review' then 'evaluate_package' when 'rejected' then 'repair_package' end;
 if expected_action is null or (select count(*) from jsonb_array_elements(p_commands) c where c->>'action'=expected_action)<>1
 or exists(select 1 from jsonb_array_elements(p_commands) c where c->>'action' is distinct from 'ready' and (c->>'action' is distinct from expected_action or c->>'packageId' is distinct from w.id::text))
 or (expected_action='repair_package' and (select count(*) from project_work_package_attempts where package_id=w.id)>=3)
 then raise exception 'Only evaluation or bounded correction of the existing package is authorized';end if;
end $$;

-- Fail closed on unexpected predecessor source. Retain existing permissions.
DO $package_patch$
DECLARE d text; a text; b text; s regprocedure; patch record;
BEGIN
 FOR patch IN SELECT * FROM (VALUES
('public.project_org_coding_capacity_resource_guard()', $before$ THEN RAISE EXCEPTION 'Original commissioning resources require the exact one-time owner receipt'; END IF;$before$, $after$ AND NOT (OLD.status='paused' AND OLD.max_missions=104 AND NEW.max_missions=112 AND OLD.active_mission_id is null
 AND NEW.token_allowance=OLD.token_allowance AND NEW.deadline=OLD.deadline
 AND EXISTS(SELECT 1 FROM project_package_execution_receipts x WHERE x.project_id=OLD.id AND x.authorization_txid=txid_current()))
 THEN RAISE EXCEPTION 'Original commissioning resources require the exact one-time owner receipt'; END IF;$after$),
('public.project_org_schedule(uuid,uuid)', $before$ PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));$before$, $after$ PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 IF project_org_package_execution_required(p_project) THEN RETURN project_org_package_execution_schedule(p_project,p_lease); END IF;$after$),
('public.finish_work_project_lifecycle(uuid,uuid,text,jsonb)', $before$ if p_action='child' then$before$, $after$ if p_action='child' then
  if project_org_package_execution_required(p.id) then
   if not project_org_package_execution_live(p.id) or p_data->>'kind' is distinct from 'development'
   or (select count(*) from agent_missions where project_id=p.id)>=112
   or not exists(select 1 from project_package_execution_receipts rr join project_work_packages ww on ww.id=rr.package_id where rr.project_id=p.id and ww.status='queued'
    and (select count(*) from project_work_package_attempts where package_id=ww.id)<3)
   then raise exception 'Exact package execution authority required';end if;
   p_data:=p_data||jsonb_build_object('evidence',coalesce(p_data->'evidence','{}'::jsonb)||jsonb_build_object('packageExecutionAuthorizationId',(select authorization_id from project_package_execution_receipts where project_id=p.id)));
  end if;$after$),
('public.finish_work_project_lifecycle(uuid,uuid,text,jsonb)', $before$mid:=gen_random_uuid();perform create_mission(mid,goal,agents,120,case when kind='development' then p.repository_id else null end);$before$, $after$mid:=gen_random_uuid();
   if wp.id is not null and project_org_package_execution_required(p.id) then
    -- Deduplicate only the mission team. Preserve all three role positions.
    perform create_mission(mid,goal,ARRAY(SELECT x FROM unnest(agents) WITH ORDINALITY q(x,i) GROUP BY x ORDER BY min(i)),120,p.repository_id);
   else perform create_mission(mid,goal,agents,120,case when kind='development' then p.repository_id else null end);end if;$after$),
('public.finish_work_project_lifecycle(uuid,uuid,text,jsonb)', $before$update work_projects set verified_sha=p_data->>'head',milestone_index=milestone_index+1,$before$, $after$update work_projects set status=case when project_org_package_execution_required(p.id) then 'paused' else status end,verified_sha=p_data->>'head',milestone_index=milestone_index+1,$after$),
('public.project_org_retest_claim_release_authorized_epoch(uuid,text,bigint,text)', $before$  OR public.project_org_coding_capacity_claim_authorized(p_project,p_release,p_generation,p_deployment)$before$, $after$  OR public.project_org_coding_capacity_claim_authorized(p_project,p_release,p_generation,p_deployment)
  OR public.project_org_package_execution_claim(p_project,p_release,p_generation,p_deployment)$after$),
('public.claim_mission_work_release_epoch(text,bigint,text)', $before$ and active_managed_work(a.agent_id,a.id) < least$before$, $after$ and (not project_org_package_execution_required(b.project_id)
  or (project_org_package_execution_assignment(a.id) and project_org_package_execution_claim(b.project_id,p_release,p_epoch,p_deployment)
    and (a.attempts=0 or (a.role='development' and a.status='waiting_external'))))
 and active_managed_work(a.agent_id,a.id) < least$after$),
('public.claim_mission_work_release_epoch(text,bigint,text)', $before$case when attempts<2 and not exists(select 1 from project_director_recoveries recovery where recovery.assignment_id=j0.id) then 'queued' else 'failed' end$before$, $after$case when attempts<2 and not exists(select 1 from project_director_recoveries recovery where recovery.assignment_id=j0.id)
 and not exists(select 1 from agent_missions m where m.id=j0.mission_id and project_org_package_execution_required(m.project_id))
 then 'queued' else 'failed' end$after$),
('public.project_provider_request(uuid,text,uuid,text,text,text,text)', $before$ IF p_receipt IS NULL AND EXISTS(SELECT 1 FROM project_coding_capacity_authority c JOIN agent_missions m ON m.project_id=c.project_id$before$, $after$ IF p_receipt IS NULL AND EXISTS(SELECT 1 FROM project_package_execution_receipts x JOIN agent_missions m ON m.project_id=x.project_id JOIN mission_assignments j ON j.mission_id=m.id WHERE j.id=p_job) THEN
  IF NOT project_org_package_execution_request(p_job,p_attempt,p_operation,p_scope) THEN RETURN false; END IF;
 ELSIF p_receipt IS NULL AND EXISTS(SELECT 1 FROM project_coding_capacity_authority c JOIN agent_missions m ON m.project_id=c.project_id$after$),
('public.project_provider_dispatch_live(uuid,text)', $before$ and p_scope=p.approved_hash and p_scope=p.approval_hash$before$, $after$ and (not project_org_package_execution_required(p.id) or project_org_package_execution_assignment(j.id))
 and p_scope=p.approved_hash and p_scope=p.approval_hash$after$),
('public.project_org_coding_capacity_commands(uuid,uuid,jsonb)', $before$ SELECT receipt.* INTO r FROM project_coding_capacity_authority receipt JOIN agent_missions m ON m.project_id=receipt.project_id$before$, $after$ IF EXISTS(SELECT 1 FROM project_package_execution_receipts x JOIN agent_missions m ON m.project_id=x.project_id JOIN mission_assignments j ON j.mission_id=m.id WHERE j.id=p_job) THEN
  PERFORM project_org_package_execution_commands(p_job,p_lease,p_commands); RETURN;
 END IF;
 SELECT receipt.* INTO r FROM project_coding_capacity_authority receipt JOIN agent_missions m ON m.project_id=receipt.project_id$after$),
('public.project_org_coding_capacity_finish(uuid)', $before$ SELECT receipt.* INTO r FROM project_coding_capacity_authority receipt JOIN agent_missions m ON m.project_id=receipt.project_id$before$, $after$ IF EXISTS(SELECT 1 FROM project_package_execution_receipts x JOIN agent_missions m ON m.project_id=x.project_id JOIN mission_assignments j ON j.mission_id=m.id WHERE j.id=p_job) THEN RETURN; END IF;
 SELECT receipt.* INTO r FROM project_coding_capacity_authority receipt JOIN agent_missions m ON m.project_id=receipt.project_id$after$)
 ) AS edits(signature,anchor,replacement) LOOP
  s:=patch.signature::regprocedure;d:=pg_get_functiondef(s);a:=patch.anchor;b:=patch.replacement;
  IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected Mission104 runtime predecessor: %',s; END IF;
  EXECUTE replace(d,a,b);
 END LOOP;
END $package_patch$;
revoke all on function public.project_org_package_execution_required(uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_execution_fingerprint(uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_execution_offer(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_execution_authorize(uuid,uuid,uuid,text,bigint,text,uuid,text,jsonb,boolean) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_execution_live(uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_execution_assignment(uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_execution_claim(uuid,text,bigint,text) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_execution_request(uuid,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_execution_schedule(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_execution_commands(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.project_org_package_execution_required(uuid) to service_role;
grant execute on function public.project_org_package_execution_assignment(uuid) to service_role;
grant execute on function public.project_org_package_execution_claim(uuid,text,bigint,text) to service_role;
grant execute on function public.project_org_package_execution_offer(uuid,uuid,text) to service_role;
grant execute on function public.project_org_package_execution_authorize(uuid,uuid,uuid,text,bigint,text,uuid,text,jsonb,boolean) to service_role;

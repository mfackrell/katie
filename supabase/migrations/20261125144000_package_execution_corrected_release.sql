-- Correct the two observed Mission 105 failures and preserve the original
-- owner-signed package receipt across one explicitly authenticated release handoff.
-- No paid request, new package, mission, scope or resource grant at installation.
create table public.project_package_execution_release_receipts(
 project_id uuid primary key references public.work_projects(id),
 package_id uuid not null references public.project_work_packages(id),
 authorization_id uuid not null unique,
 prior_authorization_id uuid not null references public.project_package_execution_receipts(authorization_id),
 owner_id uuid not null, failed_mission_id uuid not null references public.agent_missions(id),
 failed_assignment_id uuid not null references public.mission_assignments(id),
 release_sha text not null, release_generation bigint not null, deployment_id text not null,
 state_hash text not null, authorized_at timestamptz not null default clock_timestamp()
);
alter table public.project_package_execution_release_receipts enable row level security;
revoke all on public.project_package_execution_release_receipts from public,anon,authenticated,service_role;
create trigger package_execution_release_receipt_immutable before update or delete on public.project_package_execution_release_receipts
 for each row execute function public.project_org_change_immutable();

-- Exact demonstrated, drained pre-dispatch failure. This predicate permits
-- release maintenance only; it does NOT grant paid execution on a new release.
create function public.project_org_package_release_drained(p_project uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(
  select 1 from project_package_execution_receipts r join work_projects p on p.id=r.project_id
  join project_work_packages w on w.id=r.package_id and w.project_id=p.id
  join project_provider_execution a on a.project_id=p.id
  join project_work_package_attempts pa on pa.package_id=w.id and pa.attempt=1
  join agent_missions m on m.id=pa.mission_id and m.project_id=p.id
  join mission_assignments j on j.mission_id=m.id and j.role='development'
  where p.id=p_project and p.id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'
  and w.id='f88d4d10-dfe4-479e-a2cf-41b3e8209e47'
  and m.id='a6cf216a-6ef6-46fb-968c-1bac950c916b'
  and j.id='4c15dddd-5a3f-481e-87cb-7607902bbd06'
  and p.status='failed' and p.phase='development' and p.active_mission_id=m.id
  and position('42702' in p.detail)>0 and position('result' in p.detail)>0 and position('ambiguous' in p.detail)>0
  and p.lease is null and p.lease_until is null and p.max_missions=112 and p.cycles=1 and p.max_cycles=3
  and p.organization_version=1 and p.milestone_index=0 and p.token_allowance=600000
  and p.deadline=r.cutoff and a.deadline=r.cutoff and w.deadline=r.cutoff and r.cutoff>clock_timestamp()+interval '5 minutes'
  and p.approved_hash=r.scope_hash and p.approval_hash=r.scope_hash and a.approved_scope=r.scope_hash and a.owner_id=r.owner_id
  and w.status='running' and w.scope_hash=r.scope_hash and w.max_attempts=3
  and project_provider_continued(p.id) and project_org_package_execution_fingerprint(w.id)=r.contract_fingerprint
  and m.status='blocked' and m.project_kind='development' and m.calls=0 and m.detail='Trial provider admission could not be confirmed'
  and m.project_evidence->>'packageExecutionAuthorizationId'=r.authorization_id::text
  and j.status='failed' and j.attempts=1 and j.lease is null and j.lease_until is null
  and j.detail='Trial provider admission could not be confirmed' and j.result->>'providerOutcomeUnresolved'='true'
  and j.result->'diagnostic'->>'acceptedIssue'='false'
  and (select count(*) from agent_missions x where x.project_id=p.id)=105
  and (select count(*) from agent_missions x where x.project_id=p.id and x.id=any(r.historical_mission_ids))=104
  and (select count(*) from project_work_packages x where x.project_id=p.id)=1
  and (select count(*) from project_work_package_attempts x where x.package_id=w.id)=1
  and not exists(select 1 from agent_missions x where x.project_id=p.id and x.status in ('running','awaiting_approval'))
  and not exists(select 1 from mission_assignments x join agent_missions y on y.id=x.mission_id where y.project_id=p.id and (x.lease is not null or x.lease_until is not null))
  and not exists(select 1 from project_provider_requests q where q.project_id=p.id and not q.mission_id=any(r.historical_mission_ids))
  and not project_provider_request_pending(p.id)
  and not exists(select 1 from agent_tasks t join mission_assignments x on x.id=t.id where x.mission_id=m.id)
  and not exists(select 1 from project_provider_dispatches d join mission_assignments x on x.id=d.task_id where x.mission_id=m.id)
  and not exists(select 1 from project_package_execution_release_receipts s where s.project_id=p.id))
$$;

create function public.project_org_package_release_matches(p_project uuid,p_release text,p_generation bigint,p_deployment text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_package_execution_receipts r
 left join project_package_execution_release_receipts s on s.project_id=r.project_id and s.prior_authorization_id=r.authorization_id and s.package_id=r.package_id and s.owner_id=r.owner_id
 where r.project_id=p_project and (
  (s.project_id is null and r.release_sha=p_release and r.release_generation=p_generation and r.deployment_id=p_deployment)
  or (s.project_id is not null and s.release_sha=p_release and s.release_generation=p_generation and s.deployment_id=p_deployment)))
$$;

create function public.project_org_package_release_offer(p_owner uuid,p_project uuid,p_release text) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare p work_projects; w project_work_packages; r project_package_execution_receipts; g project_retest_production_release_gate; j uuid; h text;
begin
 select * into p from work_projects where id=p_project;
 select * into r from project_package_execution_receipts where project_id=p_project;
 select * into w from project_work_packages where id=r.package_id;
 select * into g from project_retest_production_release_gate where project_id=p_project;
 select id into j from mission_assignments where mission_id=p.active_mission_id and role='development';
 if not project_org_package_release_drained(p_project) or p_owner is null or r.owner_id is distinct from p_owner
 or standalone_verify_scope(p_owner,p.actor_id,p.chat_id) is distinct from true
 or g.state is distinct from 'active' or g.alias_name is distinct from 'katie-mu.vercel.app'
 or g.release_sha is distinct from p_release or g.release_sha=r.release_sha or g.deployment_id=r.deployment_id
 or g.generation is distinct from r.release_generation+2
 then raise exception 'Exact corrected package release and authenticated original owner required';end if;
 h:=encode(sha256(convert_to(project_canonical(jsonb_build_object('checkpoint',project_org_coding_capacity_state(p.id),
 'priorPackageReceipt',to_jsonb(r),'failedMission',p.active_mission_id,'failedAssignment',j,'packageFingerprint',r.contract_fingerprint)),'UTF8')),'hex');
 return jsonb_build_object('stage','authorize','projectId',p.id,'packageId',w.id,'priorAuthorizationId',r.authorization_id,
 'releaseSha',g.release_sha,'releaseGeneration',g.generation,'deploymentId',g.deployment_id,'scopeHash',r.scope_hash,'cutoff',r.cutoff,
 'stateHash',h,'contractFingerprint',r.contract_fingerprint,'managerId',w.manager_id,'coderId',w.worker_id,'writerId',w.writer_id,'reviewerId',w.reviewer_id,
 'paths',w.paths,'developmentPaths',(select c.contract->'paths' from project_worker_contracts c where c.package_id=w.id and c.role='development'),
 'terms',r.terms,'continuation',jsonb_build_object('failedMissionId',p.active_mission_id,'failedAssignmentId',j,'usedMissions',105,'remainingMissions',7,'usedAttempts',1,'remainingAttempts',2,'recordedProviderRequests',0));
end $$;

create function public.project_org_package_release_authorize(p_owner uuid,p_project uuid,p_package uuid,p_release text,p_generation bigint,p_deployment text,p_authorization uuid,p_state_hash text,p_terms jsonb,p_consent boolean) returns jsonb
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
 o:=project_org_package_release_offer(p_owner,p_project,p_release);
 if p_consent is distinct from true or p_authorization is null or p_package is distinct from (o->>'packageId')::uuid
 or p_generation is distinct from (o->>'releaseGeneration')::bigint or p_deployment is distinct from o->>'deploymentId'
 or p_state_hash is distinct from o->>'stateHash' or p_terms is distinct from o->'terms'
 or exists(select 1 from project_package_execution_receipts where authorization_id=p_authorization)
 or exists(select 1 from project_coding_capacity_receipts where authorization_id=p_authorization)
 or exists(select 1 from project_coding_capacity_resume_receipts where authorization_id=p_authorization)
 then raise exception 'Exact fresh corrected release consent required';end if;
 stamp:=clock_timestamp();
 insert into project_package_execution_release_receipts(project_id,package_id,authorization_id,prior_authorization_id,owner_id,failed_mission_id,failed_assignment_id,release_sha,release_generation,deployment_id,state_hash,authorized_at)
 values(p.id,p_package,p_authorization,(o->>'priorAuthorizationId')::uuid,p_owner,(o->'continuation'->>'failedMissionId')::uuid,(o->'continuation'->>'failedAssignmentId')::uuid,
 p_release,p_generation,p_deployment,p_state_hash,stamp);
 update work_projects set status='running',detail='Owner-authorized corrected package release; evaluate the saved failed attempt',
 progress_since=stamp,progress_signature=null,error_signature=null,repeated_errors=0,impediment=null,updated_at=stamp
 where id=p.id and status='failed' and active_mission_id=(o->'continuation'->>'failedMissionId')::uuid and max_missions=112;
 if not found then raise exception 'Atomic package release continuation failed';end if;
 insert into project_events(project_id,event,data) values(p.id,'package_execution_release_authorized',o||jsonb_build_object('authorizationId',p_authorization));
 return o||jsonb_build_object('stage','authorized','authorizationId',p_authorization,'authorizedAt',stamp);
end $$;

-- Keep the original resource, deadline, package and assignment predicates.
-- Only the exact observed result ambiguity and the release identity seam change.
DO $package_patch$
DECLARE d text; a text; b text; s regprocedure; patch record;
BEGIN
 FOR patch IN SELECT * FROM (VALUES
 ('public.project_org_package_execution_schedule(uuid,uuid)','result jsonb;','schedule_result jsonb;'),
 ('public.project_org_package_execution_schedule(uuid,uuid)','result:=project_org_schedule_before_exception_recovery','schedule_result:=project_org_schedule_before_exception_recovery'),
 ('public.project_org_package_execution_schedule(uuid,uuid)','if result->>','if schedule_result->>'),
 ('public.project_org_package_execution_schedule(uuid,uuid)','mm.id::text=result->>','mm.id::text=schedule_result->>'),
 ('public.project_org_package_execution_schedule(uuid,uuid)','return coalesce(result,','return coalesce(schedule_result,'),
 ('public.project_org_retest_set_release_gate(uuid,text,text,text,bigint)',$old$or (p.max_missions<>96 and not exists(select 1 from project_coding_capacity_authority c where c.project_id=p.id and c.approved_max_missions=p.max_missions))$old$,$new$or (p.max_missions<>96 and not exists(select 1 from project_coding_capacity_authority c where c.project_id=p.id and c.approved_max_missions=p.max_missions) and not project_org_package_release_drained(p.id))$new$),
 ('public.project_org_package_execution_live(uuid)',$old$g.release_sha=r.release_sha and g.generation=r.release_generation and g.deployment_id=r.deployment_id$old$,$new$project_org_package_release_matches(p.id,g.release_sha,g.generation,g.deployment_id)$new$),
 ('public.project_org_package_execution_claim(uuid,text,bigint,text)',$old$r.release_sha=p_release and r.release_generation=p_generation and r.deployment_id=p_deployment$old$,$new$project_org_package_release_matches(p.id,p_release,p_generation,p_deployment)$new$)
 ) AS edits(signature,anchor,replacement) LOOP
  s:=patch.signature::regprocedure;d:=pg_get_functiondef(s);a:=patch.anchor;b:=patch.replacement;
  IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected package correction predecessor: %',s;END IF;
  EXECUTE replace(d,a,b);
 END LOOP;
END $package_patch$;
revoke all on function public.project_org_package_release_drained(uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_release_matches(uuid,text,bigint,text) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_release_offer(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_release_authorize(uuid,uuid,uuid,text,bigint,text,uuid,text,jsonb,boolean) from public,anon,authenticated,service_role;
grant execute on function public.project_org_package_release_offer(uuid,uuid,text) to service_role;
grant execute on function public.project_org_package_release_authorize(uuid,uuid,uuid,text,bigint,text,uuid,text,jsonb,boolean) to service_role;

-- Bounded invalid management response recovery. Installation is not owner consent.
-- No request, lease, mission, package or existing receipt is changed by this migration.
create table public.project_package_invalid_retry_authorizations(
 project_id uuid primary key references public.work_projects(id),
 authorization_id uuid not null unique references public.project_package_corrective_receipts(receipt_id),
 completion_authorization_id uuid not null references public.project_package_completion_receipts(authorization_id),
 package_id uuid not null references public.project_work_packages(id),
 owner_id uuid not null,
 initial_request_id uuid not null references public.project_package_paid_responses(request_id),
 cutoff timestamptz not null,
 terms jsonb not null,
 checkpoint jsonb not null,
 authorized_at timestamptz not null default clock_timestamp()
);
create table public.project_package_invalid_retry_attempts(
 source_request_id uuid primary key references public.project_package_paid_responses(request_id),
 authorization_id uuid not null references public.project_package_invalid_retry_authorizations(authorization_id),
 project_id uuid not null references public.work_projects(id),
 mission_id uuid not null references public.agent_missions(id),
 assignment_id uuid not null references public.mission_assignments(id),
 next_attempt integer not null check(next_attempt>1),
 reason text not null,
 response_hash text not null,
 rejection jsonb not null,
 recorded_at timestamptz not null default clock_timestamp(),
 unique(assignment_id,next_attempt)
);
alter table public.project_package_invalid_retry_authorizations enable row level security;
alter table public.project_package_invalid_retry_attempts enable row level security;
revoke all on public.project_package_invalid_retry_authorizations,public.project_package_invalid_retry_attempts from public,anon,authenticated,service_role;
create trigger package_invalid_retry_authorization_immutable before update or delete on public.project_package_invalid_retry_authorizations
 for each row execute function public.project_org_change_immutable();
create trigger package_invalid_retry_attempt_immutable before update or delete on public.project_package_invalid_retry_attempts
 for each row execute function public.project_org_change_immutable();

create function public.project_org_package_invalid_retry_terms() returns jsonb
language sql immutable set search_path=public,pg_temp as $$
 select jsonb_build_object('maxMissions',118,'developmentAttempts',5,'paidInferenceLimit',80,
 'maxRetriesPerAssignment',2,'maxAdditionalRetries',6,'tokenAllowance',600000,
 'retryOnly','invalid-settled-management-response','unresolvedProviderRetries',0,
 'automaticDevelopmentRepairs',0,'additionalTokens',0,'dollarCeilingMicrousd',null,'stopAt','package-acceptance')
$$;

-- Classify only a definitive, immutable response whose command is provably
-- invalid against the same saved package state. Never infer invalidity from a
-- network error, lease expiry, authorization failure or an arbitrary exception.
create function public.project_org_package_invalid_response_reason(p_job uuid,p_request uuid) returns text
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare j mission_assignments; m agent_missions; r project_package_execution_receipts;
 w project_work_packages; d project_package_paid_responses; dev mission_assignments;
 prev agent_missions; cmd jsonb; batch jsonb; expected text; body text;
begin
 select * into j from mission_assignments where id=p_job;
 select * into m from agent_missions where id=j.mission_id;
 select * into r from project_package_execution_receipts where project_id=m.project_id;
 select * into w from project_work_packages where id=r.package_id and project_id=m.project_id;
 select * into d from project_package_paid_responses where request_id=p_request;
 if j.id is null or m.id is null or r.project_id is null or w.id is null
 or j.role is distinct from 'work' or m.project_kind is distinct from 'management'
 or m.project_evidence->>'packageExecutionAuthorizationId' is distinct from r.authorization_id::text
 or m.project_evidence->>'organizationNodeId' is distinct from w.manager_id::text
 or j.payload->>'organizationNodeId' is distinct from w.manager_id::text
 or not exists(select 1 from project_organization_nodes n where n.id=w.manager_id and n.agent_id=j.agent_id and n.project_id=m.project_id)
 or exists(select 1 from project_organization_decisions z where z.assignment_id=j.id)
 or project_provider_request_pending(m.project_id)
 or project_org_package_durable_response_id(j.id) is distinct from p_request
 or d.assignment_id is distinct from j.id or d.response->>'status' is distinct from 'completed'
 then return null;end if;
 select am.* into prev from project_work_package_attempts a join agent_missions am on am.id=a.mission_id
 where a.package_id=w.id order by a.attempt desc limit 1;
 if prev.id is null or prev.id::text is distinct from m.project_evidence->>'previousMissionId' then return null;end if;
 expected:=case w.status when 'review' then 'evaluate_package' when 'rejected' then 'repair_package' end;
 if expected is null then return null;end if;
 body:=regexp_replace(btrim(d.response->>'text'),'^\x60\x60\x60(json)?[[:space:]]*','');
 body:=regexp_replace(body,'[[:space:]]*\x60\x60\x60$','');
 begin batch:=body::jsonb;exception when others then return 'invalid_json';end;
 if jsonb_typeof(batch) is distinct from 'array' then return 'invalid_command_batch';end if;
 if jsonb_array_length(batch) not between 1 and 2 then return 'invalid_command_batch';end if;
 if (select count(*) from jsonb_array_elements(batch) c where c->>'action'=expected)<>1
 or exists(select 1 from jsonb_array_elements(batch) c where jsonb_typeof(c) is distinct from 'object'
  or (c->>'action' is distinct from 'ready' and (c->>'action' is distinct from expected or c->>'packageId' is distinct from w.id::text)))
 then return 'invalid_lifecycle_action';end if;
 select c into cmd from jsonb_array_elements(batch) c where c->>'action'=expected;
 if expected='evaluate_package' then
  select * into dev from mission_assignments where mission_id=prev.id and role='development';
  if dev.id is null then return null;end if;
  if cmd->>'assignmentId' is distinct from dev.id::text then return 'invalid_attempt_identity';end if;
  if coalesce(cmd->>'accepted','') not in('true','false') then return 'invalid_evaluation_decision';end if;
  if cmd->>'accepted'='false' then
   if jsonb_typeof(cmd->'findings') is distinct from 'array' then return 'missing_rejection_findings';end if;
   if jsonb_array_length(cmd->'findings')<1 then return 'missing_rejection_findings';end if;
  else
   if dev.status is distinct from 'completed' or prev.status is distinct from 'completed' then return 'unverified_acceptance';end if;
   if jsonb_typeof(cmd->'checks') is distinct from 'array' then return 'invalid_acceptance_checks';end if;
   if jsonb_array_length(cmd->'checks')<>jsonb_array_length(w.contract->'acceptance')
   or exists(select 1 from jsonb_array_elements_text(w.contract->'acceptance') criterion
     where not exists(select 1 from jsonb_array_elements(cmd->'checks') ck where ck->>'criterion'=criterion
      and ck->>'passed'='true' and ck->>'assignmentId'=dev.id::text and length(coalesce(ck->>'evaluation',''))>0))
   then return 'invalid_acceptance_checks';end if;
  end if;
 end if;
 return null;
end $$;

create function public.project_org_package_invalid_retry_authority(p_project uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_package_invalid_retry_authorizations a
 join project_package_completion_receipts s on s.project_id=a.project_id and s.authorization_id=a.completion_authorization_id
 join project_package_execution_receipts r on r.project_id=a.project_id
 join project_package_corrective_receipts k on k.receipt_id=a.authorization_id
 join project_package_corrective_receipts root on root.receipt_id=s.root_authorization_id and root.ordinal=0
 where a.project_id=p_project and a.package_id=r.package_id and a.package_id=s.package_id
 and a.owner_id=r.owner_id and a.owner_id=s.owner_id and a.owner_id=k.owner_id
 and a.cutoff=r.cutoff and a.cutoff=s.cutoff and a.cutoff=k.cutoff and a.cutoff>clock_timestamp()
 and a.terms=project_org_package_invalid_retry_terms() and s.terms=project_org_package_completion_terms()
 and k.project_id=a.project_id and k.package_id=a.package_id and k.root_authorization_id=root.receipt_id
 and k.checkpoint=a.checkpoint and k.qualification->'invalidRetryTerms'=a.terms
 and root.project_id=a.project_id and root.package_id=a.package_id and root.owner_id=a.owner_id
 and root.corrective_terms=project_org_package_corrective_terms()
 and project_org_package_execution_live(a.project_id))
$$;

-- A slot is reserved before requeue, never inferred from a mutable error.
-- It binds the prior paid response to exactly one future lease ordinal.
create function public.project_org_package_invalid_retry_slot(p_job uuid,p_next integer) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_package_invalid_retry_attempts t
 join project_package_invalid_retry_authorizations a on a.authorization_id=t.authorization_id and a.project_id=t.project_id
 join mission_assignments j on j.id=t.assignment_id and j.mission_id=t.mission_id
 join agent_missions m on m.id=j.mission_id and m.project_id=t.project_id
 join project_package_paid_responses d on d.request_id=t.source_request_id and d.response_hash=t.response_hash
 join project_package_execution_receipts r on r.project_id=t.project_id
 where j.id=p_job and t.next_attempt=p_next and j.role='work' and m.project_kind='management'
 and project_org_package_invalid_retry_authority(t.project_id)
 and project_org_package_execution_assignment(j.id)
 and project_org_package_invalid_response_reason(j.id,t.source_request_id)=t.reason
 and (select count(*) from project_package_invalid_retry_attempts x where x.authorization_id=a.authorization_id)<=6
 and (select count(*) from project_package_invalid_retry_attempts x where x.authorization_id=a.authorization_id and x.assignment_id=j.id)<=2
 and (select count(*) from project_provider_requests q where q.project_id=t.project_id and q.operation='inference' and not q.mission_id=any(r.historical_mission_ids))<80
 and not project_provider_request_pending(t.project_id))
$$;

create function public.project_org_package_invalid_retry_claim_allowed(p_job uuid,p_release text,p_generation bigint,p_deployment text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
 join project_retest_production_release_gate g on g.project_id=m.project_id
 where j.id=p_job and j.status='queued' and j.lease is null and j.lease_until is null
 and g.state='active' and g.release_sha=p_release and g.generation=p_generation and g.deployment_id=p_deployment
 and project_org_package_invalid_retry_slot(j.id,j.attempts+1))
$$;

create function public.project_org_package_invalid_retry_lease(p_job uuid,p_attempt text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from mission_assignments j where j.id=p_job and j.status='running'
 and j.lease::text=p_attempt and j.lease_until>clock_timestamp()
 and project_org_package_invalid_retry_slot(j.id,j.attempts)
 and not exists(select 1 from project_provider_requests q where q.assignment_id=j.id and q.operation='inference' and q.execution_attempt=p_attempt))
$$;

create function public.project_org_package_invalid_retry_request_allowed(p_job uuid,p_attempt text,p_operation text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select p_operation in('model-list','inference') and project_org_package_invalid_retry_lease(p_job,p_attempt)
 and not exists(select 1 from project_provider_requests q where q.assignment_id=p_job and q.operation=p_operation and q.execution_attempt=p_attempt)
$$;

-- Each extra settled inference must correspond to a previously reserved
-- immutable invalid-response slot. The original lost-response replacement
-- remains separately counted; no old receipt is amended.
create function public.project_org_package_invalid_retry_settlement_allowed(p_job uuid,p_count integer) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
 join project_package_invalid_retry_authorizations a on a.project_id=m.project_id
 join project_package_completion_receipts s on s.authorization_id=a.completion_authorization_id
 where j.id=p_job and project_org_package_invalid_retry_authority(m.project_id)
 and p_count=(case when s.failed_assignment_id=j.id then 2 else 1 end)
    +(select count(*) from project_package_invalid_retry_attempts t where t.authorization_id=a.authorization_id and t.assignment_id=j.id)
 and exists(select 1 from project_package_invalid_retry_attempts t where t.authorization_id=a.authorization_id and t.assignment_id=j.id)
 and (select count(*) from project_package_invalid_retry_attempts t where t.authorization_id=a.authorization_id and t.assignment_id=j.id)<=2
 and (select count(*) from project_package_invalid_retry_attempts t where t.authorization_id=a.authorization_id)<=6
 and not exists(select 1 from project_package_invalid_retry_attempts t where t.assignment_id=j.id and t.source_request_id=project_org_package_durable_response_id(j.id)))
$$;

-- Exact original blocked checkpoint. A valid saved response remains eligible
-- only for nonbillable replay, never for this new authorization.
create function public.project_org_package_invalid_retry_checkpoint(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare cp jsonb; d project_package_paid_responses; s project_package_completion_receipts; reason text;
begin
 cp:=project_org_package_corrective_checkpoint(p_project);
 select * into s from project_package_completion_receipts where project_id=p_project;
 if cp is null or cp->>'mode' is distinct from 'saved-response-replay'
 or s.project_id is null or s.terms is distinct from project_org_package_completion_terms()
 or cp->>'missionId' is distinct from s.failed_mission_id::text
 or cp->>'assignmentId' is distinct from s.failed_assignment_id::text
 or cp->>'usedMissions' is distinct from '109' or cp->>'usedAttempts' is distinct from '2'
 or cp->>'paidInferences' is distinct from '4' or cp->>'priorAttempts' is distinct from '3'
 or exists(select 1 from project_package_invalid_retry_authorizations where project_id=p_project)
 then return null;end if;
 select * into d from project_package_paid_responses where request_id::text=cp->>'savedRequestId';
 reason:=project_org_package_invalid_response_reason(s.failed_assignment_id,d.request_id);
 if d.request_id is null or reason is distinct from 'invalid_lifecycle_action' then return null;end if;
 return cp||jsonb_build_object('mode','invalid-response-retry','invalidReason',reason,'responseHash',d.response_hash,
 'completionAuthorizationId',s.authorization_id,'sourceRequestId',d.request_id);
end $$;

create function public.project_org_package_invalid_retry_offer(p_owner uuid,p_project uuid,p_release text) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare cp jsonb; p work_projects; r project_package_execution_receipts; w project_work_packages;
 root project_package_corrective_receipts; prior project_package_corrective_receipts; g project_retest_production_release_gate;
begin
 cp:=project_org_package_invalid_retry_checkpoint(p_project);
 select * into p from work_projects where id=p_project;
 select * into r from project_package_execution_receipts where project_id=p_project;
 select * into w from project_work_packages where id=r.package_id;
 select * into root from project_package_corrective_receipts where project_id=p_project and ordinal=0;
 select * into prior from project_package_corrective_receipts where project_id=p_project order by ordinal desc limit 1;
 select * into g from project_retest_production_release_gate where project_id=p_project;
 if cp is null or p_owner is null or p_owner is distinct from r.owner_id
 or standalone_verify_scope(p_owner,p.actor_id,p.chat_id) is distinct from true
 or prior.ordinal>=6 or g.state is distinct from 'active' or g.alias_name is distinct from 'katie-mu.vercel.app'
 or g.release_sha is distinct from p_release or g.release_sha=prior.release_sha or g.deployment_id=prior.deployment_id
 or g.generation is distinct from prior.release_generation+2 then raise exception 'Exact authenticated invalid-response retry offer required';end if;
 return jsonb_build_object('stage','authorize','projectId',p.id,'packageId',w.id,'priorAuthorizationId',prior.receipt_id,
 'releaseSha',g.release_sha,'releaseGeneration',g.generation,'deploymentId',g.deployment_id,'scopeHash',r.scope_hash,'cutoff',r.cutoff,
 'stateHash',cp->>'stateHash','contractFingerprint',r.contract_fingerprint,'managerId',w.manager_id,'coderId',w.worker_id,'writerId',w.writer_id,'reviewerId',w.reviewer_id,
 'paths',w.paths,'developmentPaths',(select c.contract->'paths' from project_worker_contracts c where c.package_id=w.id and c.role='development'),
 'terms',r.terms,'correctiveTerms',root.corrective_terms,'invalidRetryTerms',project_org_package_invalid_retry_terms(),
 'invalidRetryCheckpoint',jsonb_build_object('missionId',cp->>'missionId','assignmentId',cp->>'assignmentId','sourceRequestId',cp->>'sourceRequestId',
 'responseHash',cp->>'responseHash','invalidReason',cp->>'invalidReason','usedMissions',109,'usedAttempts',2,'paidInferences',4,'correctiveReleasesUsed',prior.ordinal+1));
end $$;

create function public.project_org_package_invalid_retry_authorize(p_owner uuid,p_project uuid,p_package uuid,p_release text,p_generation bigint,p_deployment text,
 p_authorization uuid,p_state_hash text,p_terms jsonb,p_corrective_terms jsonb,p_context_hash text,p_context_chars integer,p_retry_terms jsonb,p_consent boolean) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare o jsonb; cp jsonb; r project_package_execution_receipts; root project_package_corrective_receipts;
 prior project_package_corrective_receipts; jid uuid; mid uuid; qid uuid; stamp timestamptz:=clock_timestamp();
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 perform 1 from work_projects where id=p_project for update;
 perform 1 from project_retest_production_release_gate where project_id=p_project for update;
 perform 1 from project_work_packages where id=p_package and project_id=p_project for update;
 perform 1 from project_worker_contracts where package_id=p_package order by id for update;
 perform 1 from project_organization_nodes where project_id=p_project order by id for update;
 o:=project_org_package_invalid_retry_offer(p_owner,p_project,p_release);
 cp:=project_org_package_invalid_retry_checkpoint(p_project);
 select * into r from project_package_execution_receipts where project_id=p_project;
 select * into root from project_package_corrective_receipts where project_id=p_project and ordinal=0;
 select * into prior from project_package_corrective_receipts where project_id=p_project order by ordinal desc limit 1;
 jid:=(cp->>'assignmentId')::uuid;mid:=(cp->>'missionId')::uuid;qid:=(cp->>'sourceRequestId')::uuid;
 if p_consent is distinct from true or p_authorization is null or p_package is distinct from r.package_id
 or p_generation is distinct from (o->>'releaseGeneration')::bigint or p_deployment is distinct from o->>'deploymentId'
 or p_state_hash is distinct from o->>'stateHash' or cp->>'stateHash' is distinct from p_state_hash
 or p_terms is distinct from o->'terms' or p_corrective_terms is distinct from o->'correctiveTerms'
 or p_retry_terms is distinct from o->'invalidRetryTerms'
 or p_context_hash is null or p_context_hash !~ '^[a-f0-9]{64}$' or p_context_chars is null or p_context_chars not between 1 and 96000
 or exists(select 1 from project_package_corrective_receipts where receipt_id=p_authorization)
 or exists(select 1 from project_package_execution_receipts where authorization_id=p_authorization)
 or exists(select 1 from project_package_execution_release_receipts where authorization_id=p_authorization)
 then raise exception 'Exact fresh bounded invalid-response retry consent required';end if;
 insert into project_package_corrective_receipts(project_id,ordinal,receipt_id,root_authorization_id,prior_receipt_id,package_id,owner_id,
 release_sha,release_generation,deployment_id,cutoff,terms,corrective_terms,checkpoint,state_hash,qualification)
 values(p_project,prior.ordinal+1,p_authorization,root.receipt_id,prior.receipt_id,r.package_id,p_owner,p_release,p_generation,p_deployment,
 r.cutoff,r.terms,root.corrective_terms,cp,p_state_hash,jsonb_build_object('kind','authenticated-owner-invalid-response-retries',
 'invalidRetryTerms',p_retry_terms,'contextHash',p_context_hash,'contextChars',p_context_chars));
 insert into project_package_invalid_retry_authorizations(project_id,authorization_id,completion_authorization_id,package_id,owner_id,initial_request_id,cutoff,terms,checkpoint)
 values(p_project,p_authorization,(cp->>'completionAuthorizationId')::uuid,r.package_id,p_owner,qid,r.cutoff,p_retry_terms,cp);
 insert into project_package_invalid_retry_attempts(source_request_id,authorization_id,project_id,mission_id,assignment_id,next_attempt,reason,response_hash,rejection)
 values(qid,p_authorization,p_project,mid,jid,(cp->>'priorAttempts')::int+1,cp->>'invalidReason',cp->>'responseHash',cp->'assignmentResult');
 update mission_assignments set status='queued',available_at=clock_timestamp(),updated_at=stamp
 where id=jid and mission_id=mid and status='failed' and attempts=(cp->>'priorAttempts')::int and lease is null and lease_until is null;
 if not found then raise exception 'Saved invalid manager assignment changed';end if;
 update agent_missions set status='running',updated_at=stamp where id=mid and project_id=p_project and status='blocked' and calls=2;
 if not found then raise exception 'Saved invalid manager mission changed';end if;
 update work_projects set status='running',progress_since=stamp,progress_signature=null,error_signature=null,repeated_errors=0,impediment=null,updated_at=stamp,
 detail='Authenticated bounded invalid-response retry authority recorded; resume the same manager assignment'
 where id=p_project and active_mission_id=mid and status='blocked' and max_missions=118 and max_cycles=5 and lease is null and lease_until is null;
 if not found then raise exception 'Saved package checkpoint changed';end if;
 if not project_org_package_invalid_retry_claim_allowed(jid,p_release,p_generation,p_deployment)
 or not project_org_retest_claim_release_authorized_epoch(p_project,p_release,p_generation,p_deployment)
 then raise exception 'Native retry assignment not eligible';end if;
 insert into project_events(project_id,event,data) values(p_project,'package_invalid_response_retries_authorized',
 o||jsonb_build_object('authorizationId',p_authorization,'contextHash',p_context_hash,'contextChars',p_context_chars));
 return o||jsonb_build_object('stage','authorized','authorizationId',p_authorization);
end $$;

-- Future retries are admitted only from a live exact lease after the paid
-- response was captured and independently classified invalid. No new owner
-- receipt or mission is created. A lost acknowledgement can be checked safely.
create function public.project_org_package_retry_invalid_response(p_job uuid,p_lease uuid,p_release text,p_generation bigint,p_deployment text,p_detail text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare j mission_assignments; m agent_missions; a project_package_invalid_retry_authorizations; g project_retest_production_release_gate;
 d project_package_paid_responses; r project_package_execution_receipts; why text;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 select * into j from mission_assignments where id=p_job for update;
 select * into m from agent_missions where id=j.mission_id;
 select * into g from project_retest_production_release_gate where project_id=m.project_id;
 select * into a from project_package_invalid_retry_authorizations where project_id=m.project_id;
 select * into r from project_package_execution_receipts where project_id=m.project_id;
 select * into d from project_package_paid_responses where request_id=project_org_package_durable_response_id(j.id);
 if a.project_id is null or p_lease is null or g.state is distinct from 'active'
 or g.release_sha is distinct from p_release or g.generation is distinct from p_generation or g.deployment_id is distinct from p_deployment
 or not project_org_package_invalid_retry_authority(m.project_id) or not project_org_package_execution_assignment(j.id)
 or d.execution_attempt is distinct from p_lease::text then return false;end if;
 if j.status='queued' and j.lease is null and exists(select 1 from project_package_invalid_retry_attempts t
 where t.source_request_id=d.request_id and t.assignment_id=j.id and t.next_attempt=j.attempts+1) then return true;end if;
 if j.status is distinct from 'running' or j.lease is distinct from p_lease or j.lease_until<=clock_timestamp()
 or exists(select 1 from project_package_invalid_retry_attempts t where t.source_request_id=d.request_id)
 or (select count(*) from project_package_invalid_retry_attempts t where t.authorization_id=a.authorization_id)>=6
 or (select count(*) from project_package_invalid_retry_attempts t where t.authorization_id=a.authorization_id and t.assignment_id=j.id)>=2
 or (select count(*) from project_provider_requests q where q.project_id=m.project_id and q.operation='inference' and not q.mission_id=any(r.historical_mission_ids))>=80
 then return false;end if;
 why:=project_org_package_invalid_response_reason(j.id,d.request_id);
 if why is null then return false;end if;
 insert into project_package_invalid_retry_attempts(source_request_id,authorization_id,project_id,mission_id,assignment_id,next_attempt,reason,response_hash,rejection)
 values(d.request_id,a.authorization_id,m.project_id,m.id,j.id,j.attempts+1,why,d.response_hash,
 jsonb_build_object('assignment',to_jsonb(j),'detail',left(coalesce(p_detail,''),600)));
 if not commit_mission_work(j.id,p_lease,jsonb_build_object('detail','Authorized invalid management response retry: '||why,'sourceRequestId',d.request_id),
 '[]'::jsonb,'queued',null,null) then raise exception 'Exact retry requeue failed';end if;
 if not project_org_package_invalid_retry_claim_allowed(j.id,p_release,p_generation,p_deployment) then raise exception 'Native bounded retry claim unavailable';end if;
 insert into project_events(project_id,event,data) values(m.project_id,'package_invalid_response_retry_queued',
 jsonb_build_object('authorizationId',a.authorization_id,'missionId',m.id,'assignmentId',j.id,'sourceRequestId',d.request_id,'reason',why,'nextAttempt',j.attempts+1));
 return true;
end $$;

-- Keep every original native guard; add only the explicitly authorized slots.
DO $patch$
declare edit record; d text;
begin
 for edit in select * from (values
 ('public.project_org_package_management_retake(uuid,text,bigint,text)',$a$or (latest.checkpoint->>'mode'='saved-response-replay' and latest.checkpoint->>'savedRequestId'=project_org_package_durable_response_id(j.id)::text)))$a$,$b$or (latest.checkpoint->>'mode'='saved-response-replay' and latest.checkpoint->>'savedRequestId'=project_org_package_durable_response_id(j.id)::text)))
 or project_org_package_invalid_retry_claim_allowed(p_job,p_release,p_generation,p_deployment)$b$),
 ('public.project_org_package_paid_retry_allowed(uuid,text,text)',$a$and not exists(select 1 from project_package_paid_responses where assignment_id=j.id))$a$,$b$and not exists(select 1 from project_package_paid_responses where assignment_id=j.id))
 or project_org_package_invalid_retry_request_allowed(p_job,p_attempt,p_operation)$b$),
 ('public.project_org_package_saved_response(uuid,uuid)',$a$if d.execution_attempt is distinct from p_lease::text$a$,$b$if d.execution_attempt is distinct from p_lease::text and project_org_package_invalid_retry_lease(p_job,p_lease::text) then return null;end if;
 if d.execution_attempt is distinct from p_lease::text$b$),
 ('public.project_org_package_execution_commands(uuid,uuid,jsonb)',$a$or inference_count>2
 or (inference_count=2 and not exists(select 1 from project_package_completion_receipts s where s.project_id=r.project_id and s.failed_assignment_id=j.id and s.failed_mission_id=m.id))$a$,$b$or ((inference_count>2
 or (inference_count=2 and not exists(select 1 from project_package_completion_receipts s where s.project_id=r.project_id and s.failed_assignment_id=j.id and s.failed_mission_id=m.id)))
 and not project_org_package_invalid_retry_settlement_allowed(j.id,inference_count))$b$),
 ('public.project_org_package_corrective_continue(uuid,text,bigint,text,text,jsonb)',$a$cp:=project_org_package_corrective_checkpoint(p_project);$a$,$b$cp:=project_org_package_corrective_checkpoint(p_project);
 if cp->>'mode'='saved-response-replay' and project_org_package_invalid_response_reason((cp->>'assignmentId')::uuid,(cp->>'savedRequestId')::uuid) is not null
 then raise exception 'Invalid saved decision requires authenticated bounded retry authority, not replay';end if;$b$)
 ) edits(signature,anchor,replacement) loop
  d:=pg_get_functiondef(edit.signature::regprocedure);
  if (length(d)-length(replace(d,edit.anchor,'')))/length(edit.anchor)<>1 then raise exception 'Unexpected invalid-retry predecessor: %',edit.signature;end if;
  execute replace(d,edit.anchor,edit.replacement);
 end loop;
end $patch$;

revoke all on function public.project_org_package_invalid_retry_terms(),public.project_org_package_invalid_response_reason(uuid,uuid),
 public.project_org_package_invalid_retry_authority(uuid),public.project_org_package_invalid_retry_slot(uuid,integer),
 public.project_org_package_invalid_retry_claim_allowed(uuid,text,bigint,text),public.project_org_package_invalid_retry_lease(uuid,text),
 public.project_org_package_invalid_retry_request_allowed(uuid,text,text),public.project_org_package_invalid_retry_settlement_allowed(uuid,integer),
 public.project_org_package_invalid_retry_checkpoint(uuid),public.project_org_package_invalid_retry_offer(uuid,uuid,text),
 public.project_org_package_invalid_retry_authorize(uuid,uuid,uuid,text,bigint,text,uuid,text,jsonb,jsonb,text,integer,jsonb,boolean),
 public.project_org_package_retry_invalid_response(uuid,uuid,text,bigint,text,text) from public,anon,authenticated,service_role;
grant execute on function public.project_org_package_invalid_retry_offer(uuid,uuid,text),
 public.project_org_package_invalid_retry_authorize(uuid,uuid,uuid,text,bigint,text,uuid,text,jsonb,jsonb,text,integer,jsonb,boolean),
 public.project_org_package_retry_invalid_response(uuid,uuid,text,bigint,text,text) to service_role;

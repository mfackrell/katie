-- One authenticated standing corrective-release authorization for the
-- existing package. Each later release is separately attested by the existing
-- release operator, not represented as a new owner signature.
-- No installation-time consent, replay, dispatch, spending or resource changes.
create table public.project_package_corrective_receipts(
 project_id uuid not null references public.work_projects(id),
 ordinal integer not null check(ordinal between 0 and 6),
 receipt_id uuid not null unique,
 root_authorization_id uuid not null,
 prior_receipt_id uuid not null,
 package_id uuid not null references public.project_work_packages(id),
 owner_id uuid not null,
 release_sha text not null check(release_sha ~ '^[a-f0-9]{40}$'),
 release_generation bigint not null,
 deployment_id text not null check(deployment_id ~ '^dpl_[A-Za-z0-9]+$'),
 cutoff timestamptz not null,
 terms jsonb not null,
 corrective_terms jsonb not null,
 checkpoint jsonb not null,
 state_hash text not null,
 qualification jsonb not null,
 recorded_at timestamptz not null default clock_timestamp(),
 primary key(project_id,ordinal),
 unique(project_id,release_generation),
 unique(project_id,release_sha),
 check((ordinal=0)=(receipt_id=root_authorization_id))
);
alter table public.project_package_corrective_receipts enable row level security;
revoke all on public.project_package_corrective_receipts from public,anon,authenticated,service_role;
create trigger package_corrective_receipt_immutable before update or delete on public.project_package_corrective_receipts
 for each row execute function public.project_org_change_immutable();

create function public.project_org_package_corrective_terms() returns jsonb
language sql immutable set search_path=public,pg_temp as $$
 select jsonb_build_object('maxCorrectiveReleases',6,'preProviderRetestsOnly',true,
 'additionalPaidRetries',0,'qualifiedReleasesOnly',true,'samePackageOnly',true)
$$;

-- A drained failure is a saved, verifiable checkpoint, not authority to
-- synthesize a decision. Resume an unbilled failed assignment in place, or
-- let the native scheduler evaluate a terminal development attempt. Never
-- replay an assignment with a provider request, charge, decision or dispatch.
create function public.project_org_package_corrective_checkpoint(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare p work_projects; r project_package_execution_receipts; s project_package_execution_release_receipts;
 root project_package_corrective_receipts; w project_work_packages; a project_provider_execution;
 m agent_missions; j mission_assignments; n project_organization_nodes;
 mission_count int; attempt_count int; paid_count int; request_count int; failed_count int; mode text; snapshot jsonb;
begin
 select * into p from work_projects where id=p_project;
 select * into r from project_package_execution_receipts where project_id=p_project;
 select * into s from project_package_execution_release_receipts where project_id=p_project;
 select * into root from project_package_corrective_receipts where project_id=p_project and ordinal=0;
 select * into a from project_provider_execution where project_id=p_project;
 select * into w from project_work_packages where id=r.package_id and project_id=p_project;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p_project;
 if p.id is distinct from 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
 or w.id is distinct from 'f88d4d10-dfe4-479e-a2cf-41b3e8209e47'::uuid
 or s.project_id is null or s.prior_authorization_id is distinct from r.authorization_id
 or s.package_id is distinct from r.package_id or s.owner_id is distinct from r.owner_id
 or p.status not in('blocked','failed') or p.phase is distinct from 'development'
 or nullif(p.detail,'') is null or p.active_mission_id is null or p.lease is not null or p.lease_until is not null
 or p.milestone_index is distinct from 0 or p.organization_version is distinct from 1
 or p.max_missions is distinct from 112 or p.max_cycles is distinct from 3 or p.token_allowance is distinct from 600000
 or p.cycles not between 1 and 3 or p.deadline is distinct from r.cutoff
 or a.deadline is distinct from r.cutoff or w.deadline is distinct from r.cutoff
 or r.cutoff<=clock_timestamp()+interval '5 minutes'
 or p.approved_hash is distinct from r.scope_hash or p.approval_hash is distinct from r.scope_hash
 or a.approved_scope is distinct from r.scope_hash or a.owner_id is distinct from r.owner_id
 or w.scope_hash is distinct from r.scope_hash or w.max_attempts is distinct from 3
 or w.status not in('running','review','rejected','repair')
 or not project_provider_continued(p.id) or project_org_package_execution_fingerprint(w.id) is distinct from r.contract_fingerprint
 or (select count(*) from agent_missions x where x.project_id=p.id and x.id=any(r.historical_mission_ids))<>104
 or (select count(*) from project_work_packages x where x.project_id=p.id)<>1
 or project_provider_request_pending(p.id)
 or exists(select 1 from agent_missions x where x.project_id=p.id and x.status in('running','awaiting_approval'))
 or exists(select 1 from mission_assignments x join agent_missions y on y.id=x.mission_id where y.project_id=p.id and (x.lease is not null or x.lease_until is not null))
 or exists(select 1 from agent_tasks t join mission_assignments x on x.id=t.id join agent_missions y on y.id=x.mission_id where y.project_id=p.id and t.status in('dispatching','submitted'))
 or m.id is null or m.id=any(r.historical_mission_ids) or m.deadline<=clock_timestamp()
 or m.project_evidence->>'packageExecutionAuthorizationId' is distinct from r.authorization_id::text
 then return null;end if;
 select count(*) into mission_count from agent_missions x where x.project_id=p.id;
 select count(*) into attempt_count from project_work_package_attempts x where x.package_id=w.id;
 select count(*),count(*) filter(where q.operation='inference') into request_count,paid_count
  from project_provider_requests q where q.project_id=p.id and not q.mission_id=any(r.historical_mission_ids);
 if mission_count not between 106 and 112 or attempt_count not between 1 and 3 or paid_count>=47 then return null;end if;
 if root.project_id is not null and (root.package_id is distinct from w.id or root.owner_id is distinct from r.owner_id
  or root.cutoff is distinct from r.cutoff or root.terms is distinct from r.terms
  or root.corrective_terms is distinct from project_org_package_corrective_terms()) then return null;end if;
 select count(*) into failed_count from mission_assignments x where x.mission_id=m.id and x.status='failed';
 if failed_count=1 then
  select * into j from mission_assignments x where x.mission_id=m.id and x.status='failed';
  select * into n from project_organization_nodes x where x.id=case j.role when 'work' then w.manager_id when 'development' then w.worker_id when 'compose' then w.writer_id when 'review' then w.reviewer_id end and x.project_id=p.id;
  if m.status in('blocked','failed') and j.attempts between 1 and 7 and nullif(j.detail,'') is not null and j.result is not null
   and n.agent_id=j.agent_id and n.status in('active','accepted') and n.deadline>clock_timestamp()
   and project_provider_continued_assignment(j.id)
   and not exists(select 1 from project_provider_requests q where q.assignment_id=j.id)
   and not exists(select 1 from mission_calls q where q.job_id=j.id)
   and not exists(select 1 from agent_tasks t where t.id=j.id)
   and not exists(select 1 from project_provider_dispatches d where d.task_id=j.id)
   and not exists(select 1 from project_organization_decisions d where d.assignment_id=j.id)
   and not exists(select 1 from unnest(j.dependencies) dep where not exists(select 1 from mission_assignments x where x.mission_id=m.id and x.job_key=dep and x.status='completed'))
   and ((m.project_kind='management' and j.role='work' and m.calls=0 and w.status in('review','rejected')
      and m.project_evidence->>'organizationNodeId'=w.manager_id::text
      and j.payload->>'organizationNodeId'=w.manager_id::text
      and (select count(*) from mission_assignments x where x.mission_id=m.id)=1
      and exists(select 1 from project_work_package_attempts x where x.package_id=w.id and x.mission_id::text=m.project_evidence->>'previousMissionId'))
    or (m.project_kind='development' and j.role in('development','compose','review') and w.status='running'
      and exists(select 1 from project_work_package_attempts x where x.package_id=w.id and x.mission_id=m.id)))
  then mode:='pre-provider-retest';end if;
 end if;
 if mode is null and root.project_id is not null and m.project_kind='development'
  and m.status in('completed','blocked','failed','stopped') and mission_count<112
  and exists(select 1 from project_work_package_attempts x where x.package_id=w.id and x.mission_id=m.id)
 then mode:='scheduler-only';end if;
 if mode is null then return null;end if;
 -- Before the owner's new standing receipt exists, permit only the actual
 -- Mission106 input-overflow checkpoint, not a general release handoff.
 if root.project_id is null and (mode<>'pre-provider-retest'
  or m.id is distinct from '06908731-09d0-4832-a53c-3f1065214c80'::uuid
  or j.id is distinct from '9afc323a-07cc-4ebf-9562-be1c208675cf'::uuid
  or p.status is distinct from 'blocked' or p.detail is distinct from 'Package management failed; no automatic retry'
  or m.detail is distinct from 'Required management decision evidence exceeds bounded context; do not omit current contracts, unresolved exceptions, or necessary assignment results.'
  or j.detail is distinct from m.detail or j.attempts<>1 or m.calls<>0 or mission_count<>106 or attempt_count<>1 or p.cycles<>1
  or w.status<>'review' or request_count<>0) then return null;end if;
 snapshot:=jsonb_build_object('mode',mode,'missionId',m.id,'assignmentId',case when mode='pre-provider-retest' then j.id else null end,
  'priorAttempts',case when mode='pre-provider-retest' then j.attempts else 0 end,
  'missionStatus',m.status,'missionDetail',m.detail,'assignmentResult',case when mode='pre-provider-retest' then to_jsonb(j) else null end,
  'projectStatus',p.status,'projectDetail',p.detail,'usedMissions',mission_count,'remainingMissions',112-mission_count,
  'usedAttempts',attempt_count,'remainingAttempts',3-attempt_count,'recordedProviderRequests',request_count,'paidInferences',paid_count);
 return snapshot||jsonb_build_object('stateHash',encode(sha256(convert_to(project_canonical(jsonb_build_object(
  'checkpoint',snapshot,'projectState',project_org_coding_capacity_state(p.id),'package',to_jsonb(w),
  'attempts',(select jsonb_agg(to_jsonb(x) order by x.attempt) from project_work_package_attempts x where x.package_id=w.id),
  'originalReceipt',to_jsonb(r),'priorReleaseReceipt',to_jsonb(s),
  'latestCorrection',(select to_jsonb(x) from project_package_corrective_receipts x where x.project_id=p.id order by ordinal desc limit 1)
 )),'UTF8')),'hex'));
end $$;

-- The original privileged gate remains in charge of closing/activating
-- releases. This adds only a drained, original-package lineage exception.
-- The new release is never executable until its receipt is recorded.
create function public.project_org_package_corrective_gate_allowed(p_project uuid,p_action text,p_release text,p_deployment text,p_generation bigint) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare g project_retest_production_release_gate; prev project_package_execution_release_receipts; last_receipt project_package_corrective_receipts;
 old_release text; old_deployment text; old_generation bigint;
begin
 if project_org_package_corrective_checkpoint(p_project) is null then return false;end if;
 select * into g from project_retest_production_release_gate where project_id=p_project;
 select * into prev from project_package_execution_release_receipts where project_id=p_project;
 select * into last_receipt from project_package_corrective_receipts where project_id=p_project order by ordinal desc limit 1;
 if last_receipt.project_id is not null and last_receipt.ordinal>=6 then return false;end if;
 old_release:=coalesce(last_receipt.release_sha,prev.release_sha);
 old_deployment:=coalesce(last_receipt.deployment_id,prev.deployment_id);
 old_generation:=coalesce(last_receipt.release_generation,prev.release_generation);
 if g.generation is distinct from p_generation or g.release_sha is distinct from old_release or g.deployment_id is distinct from old_deployment then return false;end if;
 return (p_action='closed' and g.state='active' and g.generation=old_generation and p_release=old_release and p_deployment=old_deployment)
 or (p_action='active' and g.state='closed' and g.generation=old_generation+1 and p_release<>old_release and p_deployment<>old_deployment);
end $$;

create function public.project_org_package_corrective_offer(p_owner uuid,p_project uuid,p_release text) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare p work_projects; r project_package_execution_receipts; s project_package_execution_release_receipts; w project_work_packages;
 g project_retest_production_release_gate; cp jsonb;
begin
 select * into p from work_projects where id=p_project;
 select * into r from project_package_execution_receipts where project_id=p_project;
 select * into s from project_package_execution_release_receipts where project_id=p_project;
 select * into w from project_work_packages where id=r.package_id;
 select * into g from project_retest_production_release_gate where project_id=p_project;
 cp:=project_org_package_corrective_checkpoint(p_project);
 if cp is null or p_owner is null or r.owner_id is distinct from p_owner
 or standalone_verify_scope(p_owner,p.actor_id,p.chat_id) is distinct from true
 or exists(select 1 from project_package_corrective_receipts where project_id=p_project)
 or g.state is distinct from 'active' or g.alias_name is distinct from 'katie-mu.vercel.app'
 or g.release_sha is distinct from p_release or g.release_sha=s.release_sha or g.deployment_id=s.deployment_id
 or g.generation is distinct from s.release_generation+2
 then raise exception 'Exact corrected Mission106 release and authenticated original owner required';end if;
 return jsonb_build_object('stage','authorize','projectId',p.id,'packageId',w.id,'priorAuthorizationId',s.authorization_id,
 'releaseSha',g.release_sha,'releaseGeneration',g.generation,'deploymentId',g.deployment_id,'scopeHash',r.scope_hash,'cutoff',r.cutoff,
 'stateHash',cp->>'stateHash','contractFingerprint',r.contract_fingerprint,'managerId',w.manager_id,'coderId',w.worker_id,'writerId',w.writer_id,'reviewerId',w.reviewer_id,
 'paths',w.paths,'developmentPaths',(select c.contract->'paths' from project_worker_contracts c where c.package_id=w.id and c.role='development'),
 'terms',r.terms,'correctiveTerms',project_org_package_corrective_terms(),
 'continuation',jsonb_build_object('failedMissionId',cp->>'missionId','failedAssignmentId',cp->>'assignmentId',
 'usedMissions',cp->'usedMissions','remainingMissions',cp->'remainingMissions','usedAttempts',cp->'usedAttempts','remainingAttempts',cp->'remainingAttempts','recordedProviderRequests',cp->'recordedProviderRequests'));
end $$;

-- Called only inside the two receipt transactions, after the exact checkpoint
-- has been captured. Attempts and all prior result/decision/provider rows stay.
create function public.project_org_package_corrective_resume(p_project uuid,p_checkpoint jsonb) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare mid uuid:=(p_checkpoint->>'missionId')::uuid; jid uuid:=(p_checkpoint->>'assignmentId')::uuid; stamp timestamptz:=clock_timestamp();
begin
 if p_checkpoint->>'mode'='pre-provider-retest' then
  update mission_assignments set status='queued',available_at=stamp,updated_at=stamp
   where id=jid and mission_id=mid and status='failed' and attempts=(p_checkpoint->>'priorAttempts')::int and lease is null and lease_until is null;
  if not found then raise exception 'Saved failed assignment changed';end if;
  update agent_missions set status='running',updated_at=stamp where id=mid and project_id=p_project and status in('blocked','failed');
  if not found then raise exception 'Saved failed mission changed';end if;
 elsif p_checkpoint->>'mode' is distinct from 'scheduler-only' then raise exception 'Unsupported continuation mode';end if;
 update work_projects set status='running',detail='Signed corrective package continuation; native execution resumes from the preserved checkpoint',
 progress_since=stamp,progress_signature=null,error_signature=null,repeated_errors=0,impediment=null,updated_at=stamp
 where id=p_project and active_mission_id=mid and status in('blocked','failed') and lease is null and lease_until is null and max_missions=112;
 if not found then raise exception 'Saved project checkpoint changed';end if;
end $$;

create function public.project_org_package_corrective_authorize(p_owner uuid,p_project uuid,p_package uuid,p_release text,p_generation bigint,p_deployment text,
 p_authorization uuid,p_state_hash text,p_terms jsonb,p_corrective_terms jsonb,p_context_hash text,p_context_chars integer,p_consent boolean) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare o jsonb; cp jsonb; r project_package_execution_receipts;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 perform 1 from work_projects where id=p_project for update;
 perform 1 from project_retest_production_release_gate where project_id=p_project for update;
 perform 1 from project_work_packages where id=p_package and project_id=p_project for update;
 perform 1 from project_worker_contracts where package_id=p_package order by id for update;
 perform 1 from project_organization_nodes where project_id=p_project order by id for update;
 o:=project_org_package_corrective_offer(p_owner,p_project,p_release);
 cp:=project_org_package_corrective_checkpoint(p_project);
 select * into r from project_package_execution_receipts where project_id=p_project;
 if p_consent is distinct from true or p_authorization is null or p_package is distinct from r.package_id
 or p_generation is distinct from (o->>'releaseGeneration')::bigint or p_deployment is distinct from o->>'deploymentId'
 or p_state_hash is distinct from o->>'stateHash' or cp->>'stateHash' is distinct from p_state_hash
 or p_terms is distinct from o->'terms' or p_corrective_terms is distinct from o->'correctiveTerms'
 or p_context_hash is null or p_context_hash !~ '^[a-f0-9]{64}$' or p_context_chars is null or p_context_chars not between 1 and 96000
 or exists(select 1 from project_package_execution_receipts where authorization_id=p_authorization)
 or exists(select 1 from project_package_execution_release_receipts where authorization_id=p_authorization)
 or exists(select 1 from project_coding_capacity_receipts where authorization_id=p_authorization)
 or exists(select 1 from project_coding_capacity_resume_receipts where authorization_id=p_authorization)
 then raise exception 'Exact fresh consolidated corrective consent required';end if;
 insert into project_package_corrective_receipts(project_id,ordinal,receipt_id,root_authorization_id,prior_receipt_id,package_id,owner_id,release_sha,release_generation,deployment_id,cutoff,terms,corrective_terms,checkpoint,state_hash,qualification)
 values(p_project,0,p_authorization,p_authorization,(o->>'priorAuthorizationId')::uuid,r.package_id,p_owner,p_release,p_generation,p_deployment,r.cutoff,r.terms,p_corrective_terms,cp,p_state_hash,
 jsonb_build_object('kind','authenticated-owner-corrected-context','contextHash',p_context_hash,'contextChars',p_context_chars));
 perform project_org_package_corrective_resume(p_project,cp);
 if not project_org_package_execution_live(p_project) or not project_org_retest_claim_release_authorized_epoch(p_project,p_release,p_generation,p_deployment) then raise exception 'Native corrected assignment not eligible';end if;
 insert into project_events(project_id,event,data) values(p_project,'package_corrective_owner_authorized',o||jsonb_build_object('authorizationId',p_authorization,'contextHash',p_context_hash,'contextChars',p_context_chars));
 return o||jsonb_build_object('stage','authorized','authorizationId',p_authorization);
end $$;

-- Release operator attestation, not an owner session or a new authorization.
-- Only the existing privileged release operator can call this. External CI,
-- exact source-tree and READY canonical alias checks are operator obligations;
-- the runtime independently verifies its canonical deployment identity.
create function public.project_org_package_corrective_continue(p_project uuid,p_release text,p_generation bigint,p_deployment text,p_state_hash text,p_qualification jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare root project_package_corrective_receipts; last_receipt project_package_corrective_receipts; g project_retest_production_release_gate; cp jsonb; new_id uuid:=gen_random_uuid();
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 perform 1 from work_projects where id=p_project for update;
 select * into g from project_retest_production_release_gate where project_id=p_project for update;
 select * into root from project_package_corrective_receipts where project_id=p_project and ordinal=0;
 select * into last_receipt from project_package_corrective_receipts where project_id=p_project order by ordinal desc limit 1;
 perform 1 from project_work_packages where id=root.package_id and project_id=p_project for update;
 perform 1 from project_worker_contracts where package_id=root.package_id order by id for update;
 perform 1 from project_organization_nodes where project_id=p_project order by id for update;
 cp:=project_org_package_corrective_checkpoint(p_project);
 if root.project_id is null or last_receipt.ordinal>=6 or cp is null or p_state_hash is null or p_state_hash is distinct from cp->>'stateHash'
 or g.state is distinct from 'active' or g.alias_name is distinct from 'katie-mu.vercel.app'
 or g.generation is distinct from p_generation or g.generation is distinct from last_receipt.release_generation+2
 or g.release_sha is distinct from p_release or g.deployment_id is distinct from p_deployment
 or g.release_sha=last_receipt.release_sha or g.deployment_id=last_receipt.deployment_id
 or jsonb_typeof(p_qualification) is distinct from 'object'
 or p_qualification->>'releaseSha' is distinct from p_release or p_qualification->>'deploymentId' is distinct from p_deployment
 or p_qualification->>'canonicalAlias' is distinct from 'katie-mu.vercel.app'
 or p_qualification->>'conclusion' is distinct from 'success'
 or p_qualification->>'testedTree' is null or p_qualification->>'testedTree' !~ '^[a-f0-9]{40}$'
 or p_qualification->>'pullRequest' is null or p_qualification->>'pullRequest' !~ '^[1-9][0-9]*$'
 or p_qualification->>'ciRunId' is null or p_qualification->>'ciRunId' !~ '^[1-9][0-9]*$'
 then raise exception 'Exact drained checkpoint, standing consent and qualified canonical release required';end if;
 insert into project_package_corrective_receipts(project_id,ordinal,receipt_id,root_authorization_id,prior_receipt_id,package_id,owner_id,release_sha,release_generation,deployment_id,cutoff,terms,corrective_terms,checkpoint,state_hash,qualification)
 values(p_project,last_receipt.ordinal+1,new_id,root.receipt_id,last_receipt.receipt_id,root.package_id,root.owner_id,p_release,p_generation,p_deployment,root.cutoff,root.terms,root.corrective_terms,cp,p_state_hash,p_qualification);
 perform project_org_package_corrective_resume(p_project,cp);
 if not project_org_package_execution_live(p_project) then raise exception 'Native package authority not live on qualified release';end if;
 if cp->>'mode'='pre-provider-retest' and not project_org_retest_claim_release_authorized_epoch(p_project,p_release,p_generation,p_deployment) then raise exception 'Native corrected assignment not eligible';end if;
 insert into project_events(project_id,event,data) values(p_project,'package_corrective_release_continued',
 jsonb_build_object('receiptId',new_id,'rootAuthorizationId',root.receipt_id,'priorReceiptId',last_receipt.receipt_id,'ordinal',last_receipt.ordinal+1,'releaseSha',p_release,'generation',p_generation,'deploymentId',p_deployment,'stateHash',p_state_hash,'qualification',p_qualification,'checkpoint',cp-'assignmentResult'));
 return jsonb_build_object('receiptId',new_id,'rootAuthorizationId',root.receipt_id,'ordinal',last_receipt.ordinal+1,'mode',cp->>'mode','missionId',cp->>'missionId','assignmentId',cp->>'assignmentId');
end $$;

create function public.project_org_package_corrective_retake(p_job uuid,p_release text,p_generation bigint,p_deployment text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id join work_projects p on p.id=m.project_id and p.active_mission_id=m.id
 join lateral(select x.* from project_package_corrective_receipts x where x.project_id=p.id order by ordinal desc limit 1) r on true
 where j.id=p_job and j.status='queued' and j.lease is null and j.lease_until is null
 and r.release_sha=p_release and r.release_generation=p_generation and r.deployment_id=p_deployment
 and r.checkpoint->>'mode'='pre-provider-retest' and r.checkpoint->>'missionId'=m.id::text and r.checkpoint->>'assignmentId'=j.id::text
 and j.attempts=(r.checkpoint->>'priorAttempts')::int and r.cutoff>clock_timestamp()
 and not exists(select 1 from project_provider_requests q where q.assignment_id=j.id)
 and not exists(select 1 from mission_calls q where q.job_id=j.id)
 and not exists(select 1 from agent_tasks t where t.id=j.id)
 and not exists(select 1 from project_provider_dispatches d where d.task_id=j.id))
$$;

-- Preserve the original release and lease checks, adding only the signed
-- append-only successor and exact pre-provider re-claim predicate.
DO $package_patch$
DECLARE d text; a text; b text; s regprocedure; patch record;
BEGIN
 FOR patch IN SELECT * FROM (VALUES
 ('public.project_org_retest_set_release_gate(uuid,text,text,text,bigint)',$old$and not project_org_package_release_drained(p.id))$old$,$new$and not project_org_package_release_drained(p.id) and not project_org_package_corrective_gate_allowed(p.id,p_action,p_release,p_deployment,p_expected_generation))$new$),
 ('public.project_org_package_release_matches(uuid,text,bigint,text)',$old$ select exists(select 1 from project_package_execution_receipts r$old$,$new$ select case when exists(select 1 from project_package_corrective_receipts x where x.project_id=p_project) then exists(
 select 1 from (select x.* from project_package_corrective_receipts x where x.project_id=p_project order by ordinal desc limit 1) latest
 where latest.release_sha=p_release and latest.release_generation=p_generation and latest.deployment_id=p_deployment)
 else exists(select 1 from project_package_execution_receipts r$new$),
 ('public.claim_mission_work_release_epoch(text,bigint,text)',$old$and (a.attempts=0 or (a.role='development' and a.status='waiting_external'))))$old$,$new$and (a.attempts=0 or (a.role='development' and a.status='waiting_external') or project_org_package_corrective_retake(a.id,p_release,p_epoch,p_deployment))))$new$)
 ) AS edits(signature,anchor,replacement) LOOP
  s:=patch.signature::regprocedure;d:=pg_get_functiondef(s);a:=patch.anchor;b:=patch.replacement;
  IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected corrective release predecessor: %',s;END IF;
  -- The two correlated replacements to the SQL-language matches function
  -- must be installed together to retain a valid CASE expression.
  IF patch.signature='public.project_org_package_release_matches(uuid,text,bigint,text)' AND a LIKE ' select exists%' THEN
   d:=replace(d,a,b);
   a:='and s.deployment_id=p_deployment)))';b:='and s.deployment_id=p_deployment))) end';
   IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected release matches tail';END IF;
   EXECUTE replace(d,a,b);
  ELSIF patch.signature<>'public.project_org_package_release_matches(uuid,text,bigint,text)' THEN EXECUTE replace(d,a,b);
  END IF;
 END LOOP;
END $package_patch$;

revoke all on function public.project_org_package_corrective_terms() from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_corrective_checkpoint(uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_corrective_gate_allowed(uuid,text,text,text,bigint) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_corrective_offer(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_corrective_resume(uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_corrective_authorize(uuid,uuid,uuid,text,bigint,text,uuid,text,jsonb,jsonb,text,integer,boolean) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_corrective_continue(uuid,text,bigint,text,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_corrective_retake(uuid,text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.project_org_package_corrective_offer(uuid,uuid,text) to service_role;
grant execute on function public.project_org_package_corrective_authorize(uuid,uuid,uuid,text,bigint,text,uuid,text,jsonb,jsonb,text,integer,boolean) to service_role;
-- claim_mission_work_release_epoch is security-invoker; this predicate
-- exposes only a Boolean, never the immutable checkpoint snapshot.
grant execute on function public.project_org_package_corrective_retake(uuid,text,bigint,text) to service_role;

-- Preserve the immutable SMART assignment and its approved scope. A signed
-- package's coding authority is derived from the actual saved owner receipt,
-- not an 'approved' payload mutation or a new owner approval.
create table public.project_package_coding_admission_receipts(
 assignment_id uuid primary key references public.mission_assignments(id),
 project_id uuid not null references public.work_projects(id),
 package_id uuid not null references public.project_work_packages(id),
 release_receipt_id uuid not null references public.project_package_corrective_receipts(receipt_id),
 evidence jsonb not null,
 frozen_input_hash text not null check(frozen_input_hash ~ '^[a-f0-9]{64}$'),
 recorded_at timestamptz not null default clock_timestamp()
);
alter table public.project_package_coding_admission_receipts enable row level security;
revoke all on public.project_package_coding_admission_receipts from public,anon,authenticated,service_role;
create trigger package_coding_admission_immutable before update or delete on public.project_package_coding_admission_receipts
 for each row execute function public.project_org_change_immutable();

-- Exact previously commissioned worker, saved admission, file inventory,
-- baseline, owner, deadline and package lineage. No claim/status changes.
create function public.project_org_package_coding_evidence(p_job uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('projectId',p.id,'packageId',w.id,'missionId',m.id,'assignmentId',j.id,
 'ownerAuthorizationId',r.authorization_id,'standingAuthorizationId',root.receipt_id,
 'releaseReceiptId',latest.receipt_id,'releaseSha',latest.release_sha,'releaseGeneration',latest.release_generation,'deploymentId',latest.deployment_id,
 'scopeHash',r.scope_hash,'contractFingerprint',r.contract_fingerprint,'workerContractId',c.id,'workerAdmissionFingerprint',ad.fingerprint,
 'bindingHash',encode(sha256(convert_to(project_canonical(b.binding),'UTF8')),'hex'),'packageAttempt',pa.attempt,
 'agentId',j.agent_id,'cutoff',r.cutoff)
 from mission_assignments j join agent_missions m on m.id=j.mission_id
 join work_projects p on p.id=m.project_id and p.active_mission_id=m.id
 join project_package_execution_receipts r on r.project_id=p.id
 join project_work_packages w on w.id=r.package_id and w.project_id=p.id
 join project_package_corrective_receipts root on root.project_id=p.id and root.ordinal=0
 join lateral(select x.* from project_package_corrective_receipts x where x.project_id=p.id order by ordinal desc limit 1) latest on true
 join project_work_package_attempts pa on pa.mission_id=m.id and pa.package_id=w.id
 join project_runs b on b.mission_id=m.id and b.project_id=p.id
 join project_worker_admissions ad on ad.assignment_id=j.id
 join project_worker_contracts c on c.id=ad.contract_id and c.package_id=w.id and c.project_id=p.id
 join project_organization_nodes n on n.id=w.worker_id and n.agent_id=j.agent_id and n.parent_id=w.manager_id
 join managed_agents a on a.id=j.agent_id
 where j.id=p_job and p.id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
 and w.id='f88d4d10-dfe4-479e-a2cf-41b3e8209e47'::uuid
 and p.phase='development' and p.repository_full_name='mfackrell/katie' and p.repository_id=m.repository_id
 and p.max_missions=112 and p.token_allowance=600000 and p.max_cycles=3 and p.cycles between 1 and 3
 and p.approved_hash=r.scope_hash and p.approval_hash=r.scope_hash and w.scope_hash=r.scope_hash
 and p.deadline=r.cutoff and w.deadline=r.cutoff and m.deadline=r.cutoff and r.cutoff>clock_timestamp()
 and w.status='running' and w.max_attempts=3 and pa.attempt between 1 and 3
 and root.package_id=w.id and latest.package_id=w.id and root.owner_id=r.owner_id and latest.owner_id=r.owner_id
 and root.cutoff=r.cutoff and latest.cutoff=r.cutoff and latest.root_authorization_id=root.receipt_id
 and root.terms=r.terms and latest.terms=r.terms and r.terms->>'codingDispatches'='3'
 and root.corrective_terms=project_org_package_corrective_terms() and latest.corrective_terms=root.corrective_terms
 and standalone_verify_scope(r.owner_id,p.actor_id,p.chat_id)
 and project_org_package_execution_fingerprint(w.id)=r.contract_fingerprint
 and m.project_evidence->>'packageExecutionAuthorizationId'=r.authorization_id::text
 and not m.id=any(r.historical_mission_ids) and project_provider_continued_assignment(j.id)
 and m.project_kind='development' and j.role='development' and j.payload->>'capability'='development'
 and n.kind='worker' and n.status in('active','accepted') and 'development'=any(n.tools) and n.deadline>clock_timestamp()
 and not a.archived and (a.config->>'development')::boolean and c.agent_version=a.version
 and c.role='development' and c.worker_id=n.id and c.manager_id=w.manager_id and c.scope_hash=r.scope_hash and c.deadline>clock_timestamp()
 and c.contract->>'instruction'=j.instruction and ad.fingerprint=project_smart_fingerprint(j)
 and b.kind='development' and b.milestone_index=p.milestone_index and b.binding->>'scopeHash'=r.scope_hash
 and b.binding->>'baseSha'=pa.base_sha and b.binding->'allowedPaths'=c.contract->'paths'
 and not exists(select 1 from unnest(j.dependencies) dep where not exists(select 1 from mission_assignments x where x.mission_id=m.id and x.job_key=dep and x.status='completed'))
 and not exists(select 1 from project_work_package_dependencies d join project_work_packages predecessor on predecessor.id=d.depends_on where d.package_id=w.id and predecessor.status<>'accepted')
$$;

create function public.project_org_package_coding_authorized(p_job uuid,p_lease uuid) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare j mission_assignments; e jsonb; saved project_package_coding_admission_receipts; r project_package_execution_receipts;
begin
 select * into j from mission_assignments where id=p_job;
 e:=project_org_package_coding_evidence(p_job);
 if e is null or p_lease is null or j.status is distinct from 'running' or j.lease is distinct from p_lease
 or j.lease_until is null or j.lease_until<=clock_timestamp() or not project_org_package_execution_assignment(p_job) then return false;end if;
 select * into saved from project_package_coding_admission_receipts where assignment_id=p_job;
 if saved.assignment_id is not null then
  return saved.evidence=e and saved.frozen_input_hash=encode(sha256(convert_to(j.payload->>'development_input','UTF8')),'hex');
 end if;
 select * into r from project_package_execution_receipts where project_id=(e->>'projectId')::uuid;
 return not project_provider_request_pending(r.project_id)
 and not exists(select 1 from project_provider_requests where assignment_id=j.id)
 and not exists(select 1 from mission_calls where job_id=j.id)
 and not exists(select 1 from agent_tasks where id=j.id)
 and not exists(select 1 from project_provider_dispatches where task_id=j.id)
 and (select count(*) from project_package_coding_admission_receipts where project_id=r.project_id)<3
 and (select count(*) from project_provider_dispatches d join mission_assignments x on x.id=d.task_id join agent_missions m on m.id=x.mission_id where m.project_id=r.project_id and not m.id=any(r.historical_mission_ids))<3
 and (select count(*) from project_provider_requests q where q.project_id=r.project_id and not q.mission_id=any(r.historical_mission_ids) and q.operation='inference')<47;
end $$;

-- The worker may freeze input only through the existing preparation RPC.
-- Admission and native agent-task creation share one transaction.
create function public.project_org_package_prepare_coding(p_job uuid,p_lease uuid) returns text
language plpgsql security definer set search_path=public,pg_temp as $$
declare e jsonb; frozen text; saved project_package_coding_admission_receipts;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if not project_org_package_coding_authorized(p_job,p_lease) then raise exception 'Exact signed package coding authority required';end if;
 perform project_smart_admit(p_job);
 e:=project_org_package_coding_evidence(p_job);
 if e is null then raise exception 'Approved SMART binding changed';end if;
 frozen:=prepare_mission_development(p_job,p_lease);
 if nullif(frozen,'') is null then raise exception 'Approved coding evidence unavailable';end if;
 select * into saved from project_package_coding_admission_receipts where assignment_id=p_job;
 if saved.assignment_id is not null then
  if saved.evidence is distinct from e or saved.frozen_input_hash is distinct from encode(sha256(convert_to(frozen,'UTF8')),'hex') then raise exception 'Immutable coding admission changed';end if;
 else
  insert into project_package_coding_admission_receipts(assignment_id,project_id,package_id,release_receipt_id,evidence,frozen_input_hash)
   values(p_job,(e->>'projectId')::uuid,(e->>'packageId')::uuid,(e->>'releaseReceiptId')::uuid,e,encode(sha256(convert_to(frozen,'UTF8')),'hex'));
 end if;
 return frozen;
end $$;

-- Mission108 stopped at the legacy approval metadata mutation, before any
-- provider or external action. Recognize only this exact drained checkpoint.
create function public.project_org_package_approval_pause(p_project uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from work_projects p
 join agent_missions m on m.id=p.active_mission_id and m.project_id=p.id
 join mission_assignments j on j.mission_id=m.id
 where p.id=p_project and p.status='failed' and p.lease is null and p.lease_until is null
 and position('Admitted SMART assignment is immutable' in p.detail)>0
 and m.id='a1ceb6af-6588-40e4-95c7-ca422f4701f0'::uuid and j.id='316179b0-5dcf-4a05-aad1-9a040b270d58'::uuid
 and m.status='awaiting_approval' and m.calls=0 and j.status='awaiting_approval' and j.role='development'
 and j.attempts=1 and j.lease is null and j.lease_until is null
 and j.detail='Executive delegation approval required. Project coding still requires separate Developer Orchestrator scope approval.'
 and j.payload->>'approved' is distinct from 'true' and jsonb_typeof(j.payload->'development_input')='string'
 and project_org_package_coding_evidence(j.id) is not null
 and not exists(select 1 from project_package_coding_admission_receipts where assignment_id=j.id)
 and not exists(select 1 from agent_tasks where id=j.id)
 and not exists(select 1 from project_provider_dispatches where task_id=j.id)
 and not exists(select 1 from mission_calls where job_id=j.id)
 and not exists(select 1 from project_provider_requests where assignment_id=j.id)
 and not project_provider_request_pending(p.id))
$$;

-- Patch the existing native entrypoint and exact standing continuation
-- predicates in-place, keeping all unrelated guards and legacy approvals.
do $patch$
declare d text; a text; b text; edit record; sig text;
begin
 for sig in select unnest(array[
 'public.mission_development_task(uuid,uuid)',
 'public.project_org_package_corrective_checkpoint(uuid)',
 'public.project_org_package_corrective_resume(uuid,jsonb)',
 'public.project_org_retest_set_release_gate(uuid,text,text,text,bigint)'
 ]) loop
  d:=pg_get_functiondef(sig::regprocedure);
  for edit in select * from (values
   ('public.mission_development_task(uuid,uuid)',$a$created jsonb;frozen_input text;$a$,$b$created jsonb;frozen_input text;package_authorized boolean;$b$),
   ('public.mission_development_task(uuid,uuid)',$a$ if m.status not in ('running','awaiting_approval')$a$,$b$ package_authorized:=project_org_package_coding_authorized(p_job,p_lease);
 if m.status not in ('running','awaiting_approval')$b$),
   ('public.mission_development_task(uuid,uuid)',$a$or j.payload->>'approved' is distinct from 'true' then raise exception 'Development approval unavailable'$a$,$b$or (j.payload->>'approved' is distinct from 'true' and not package_authorized) then raise exception 'Development approval unavailable'$b$),
   ('public.mission_development_task(uuid,uuid)',$a$ frozen_input:=j.payload->>'development_input';$a$,$b$ if package_authorized then frozen_input:=project_org_package_prepare_coding(p_job,p_lease);
 else frozen_input:=j.payload->>'development_input';end if;$b$),
   ('public.project_org_package_corrective_checkpoint(uuid)',$a$mode text; snapshot jsonb;$a$,$b$mode text; snapshot jsonb; approval_pause boolean;$b$),
   ('public.project_org_package_corrective_checkpoint(uuid)',$a$ select * into m from agent_missions where id=p.active_mission_id and project_id=p_project;$a$,$b$ select * into m from agent_missions where id=p.active_mission_id and project_id=p_project;
 approval_pause:=project_org_package_approval_pause(p_project);$b$),
   ('public.project_org_package_corrective_checkpoint(uuid)',$a$or exists(select 1 from agent_missions x where x.project_id=p.id and x.status in('running','awaiting_approval'))$a$,$b$or exists(select 1 from agent_missions x where x.project_id=p.id and x.status in('running','awaiting_approval') and not (approval_pause and x.id=m.id and x.status='awaiting_approval'))$b$),
   ('public.project_org_package_corrective_checkpoint(uuid)',$a$where x.mission_id=m.id and x.status='failed';$a$,$b$where x.mission_id=m.id and (x.status='failed' or (approval_pause and x.id='316179b0-5dcf-4a05-aad1-9a040b270d58'::uuid and x.status='awaiting_approval'));$b$),
   ('public.project_org_package_corrective_checkpoint(uuid)',$a$if m.status in('blocked','failed') and j.attempts between 1 and 7$a$,$b$if (m.status in('blocked','failed') or approval_pause) and j.attempts between 1 and 7$b$),
   ('public.project_org_package_corrective_resume(uuid,jsonb)',$a$and status='failed' and attempts=(p_checkpoint->>'priorAttempts')::int$a$,$b$and (status='failed' or (status='awaiting_approval' and jid='316179b0-5dcf-4a05-aad1-9a040b270d58'::uuid and mid='a1ceb6af-6588-40e4-95c7-ca422f4701f0'::uuid and p_checkpoint->>'missionStatus'='awaiting_approval' and p_checkpoint->'assignmentResult'->>'status'='awaiting_approval')) and attempts=(p_checkpoint->>'priorAttempts')::int$b$),
   ('public.project_org_package_corrective_resume(uuid,jsonb)',$a$and status in('blocked','failed');$a$,$b$and (status in('blocked','failed') or (status='awaiting_approval' and mid='a1ceb6af-6588-40e4-95c7-ca422f4701f0'::uuid and jid='316179b0-5dcf-4a05-aad1-9a040b270d58'::uuid and p_checkpoint->>'missionStatus'='awaiting_approval'));$b$),
   ('public.project_org_retest_set_release_gate(uuid,text,text,text,bigint)',$a$and (j.lease is not null or j.lease_until is not null
    or j.status not in ('completed','failed')$a$,$b$and not (j.id='316179b0-5dcf-4a05-aad1-9a040b270d58'::uuid and m.id='a1ceb6af-6588-40e4-95c7-ca422f4701f0'::uuid and project_org_package_approval_pause(p_project) and project_org_package_corrective_gate_allowed(p_project,p_action,p_release,p_deployment,p_expected_generation))
   and (j.lease is not null or j.lease_until is not null
    or j.status not in ('completed','failed')$b$)
  ) as patches(signature,anchor,replacement) where signature=sig loop
   a:=edit.anchor;b:=edit.replacement;
   if position(a in d)=0 then raise exception 'Unexpected coding-admission predecessor: %',sig;end if;
   -- The failed-assignment selector is deliberately identical for count and
   -- row read. Every other replacement must match precisely once.
   if (length(d)-length(replace(d,a,'')))/length(a)<>(case when sig='public.project_org_package_corrective_checkpoint(uuid)' and a like 'where x.mission_id=%' then 2 else 1 end) then raise exception 'Unexpected coding-admission predecessor multiplicity: %',sig;end if;
   d:=replace(d,a,b);
  end loop;
  execute d;
 end loop;
end $patch$;

revoke all on function public.project_org_package_coding_evidence(uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_coding_authorized(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_prepare_coding(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_approval_pause(uuid) from public,anon,authenticated,service_role;
grant execute on function public.project_org_package_coding_authorized(uuid,uuid) to service_role;
grant execute on function public.project_org_package_prepare_coding(uuid,uuid) to service_role;

-- Correct the observed Mission108 legacy approval collision without
-- changing the admitted SMART payload, assignment, scope or owner receipt.
create function public.project_org_package_coding_authorized(p_job uuid,p_lease uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from mission_assignments j
 join agent_missions m on m.id=j.mission_id
 join work_projects p on p.id=m.project_id and p.active_mission_id=m.id
 join project_package_execution_receipts r on r.project_id=p.id
 join project_package_corrective_receipts root on root.project_id=p.id and root.ordinal=0
 join project_work_packages w on w.id=r.package_id and w.project_id=p.id
 join project_work_package_attempts pa on pa.package_id=w.id and pa.mission_id=m.id
 join project_runs run on run.mission_id=m.id and run.project_id=p.id
 join project_worker_admissions admission on admission.assignment_id=j.id
 join project_worker_contracts c on c.id=admission.contract_id and c.package_id=w.id
 join project_organization_nodes n on n.id=w.worker_id and n.agent_id=j.agent_id and n.parent_id=w.manager_id
 join managed_agents agent on agent.id=j.agent_id
 where j.id=p_job and j.role='development' and j.payload->>'capability'='development'
 and j.status='running' and p_lease is not null and j.lease=p_lease and j.lease_until>clock_timestamp()
 and m.project_kind='development' and m.repository_id=p.repository_id
 and root.package_id=r.package_id and root.owner_id=r.owner_id and root.cutoff=r.cutoff
 and root.terms=r.terms and root.corrective_terms=project_org_package_corrective_terms()
 and project_org_package_execution_assignment(j.id)
 and c.project_id=p.id and c.role='development' and c.worker_id=n.id and c.manager_id=w.manager_id
 and c.scope_hash=r.scope_hash and c.deadline>clock_timestamp() and c.agent_version=agent.version
 and not agent.archived and (agent.config->>'development')::boolean and 'development'=any(n.tools)
 and c.contract->>'instruction'=j.instruction and admission.fingerprint=project_smart_fingerprint(j)
 and run.binding->>'scopeHash'=r.scope_hash and run.binding->'allowedPaths'=c.contract->'paths'
 and run.binding->>'baseSha'=pa.base_sha and pa.attempt between 1 and 3)
$$;

-- Recognize only the exact saved obsolete approval failure. The existing
-- standing checkpoint validator independently verifies all original limits,
-- contract fingerprint, provider settlement, and absence of active leases.
create function public.project_org_package_legacy_approval_checkpoint(p_project uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from work_projects p
 join project_package_execution_receipts r on r.project_id=p.id
 join project_package_corrective_receipts root on root.project_id=p.id and root.ordinal=0
 join project_work_packages w on w.id=r.package_id and w.project_id=p.id
 join project_work_package_attempts pa on pa.package_id=w.id and pa.attempt=2 and pa.mission_id=p.active_mission_id
 join agent_missions m on m.id=pa.mission_id and m.project_id=p.id
 join mission_assignments j on j.mission_id=m.id and j.role='development'
 join project_worker_admissions admission on admission.assignment_id=j.id
 join project_worker_contracts c on c.id=admission.contract_id and c.package_id=w.id
 join project_runs run on run.mission_id=m.id and run.project_id=p.id
 join project_organization_nodes n on n.id=w.worker_id and n.agent_id=j.agent_id
 where p.id=p_project and p.id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'
 and w.id='f88d4d10-dfe4-479e-a2cf-41b3e8209e47'
 and m.id='a1ceb6af-6588-40e4-95c7-ca422f4701f0' and j.id='316179b0-5dcf-4a05-aad1-9a040b270d58'
 and p.status='failed' and p.detail like 'Project coordination error:%Admitted SMART assignment is immutable%'
 and p.phase='development' and p.cycles=2 and p.lease is null and p.lease_until is null
 and p.deadline=r.cutoff and r.cutoff>clock_timestamp()+interval '5 minutes'
 and root.package_id=r.package_id and root.owner_id=r.owner_id and root.cutoff=r.cutoff
 and root.terms=r.terms and root.corrective_terms=project_org_package_corrective_terms()
 and m.status='awaiting_approval' and m.project_kind='development' and m.calls=0
 and m.project_evidence->>'packageExecutionAuthorizationId'=r.authorization_id::text
 and m.detail='Executive delegation approval required. Project coding still requires separate Developer Orchestrator scope approval.'
 and j.status='awaiting_approval' and j.attempts=1 and j.lease is null and j.lease_until is null
 and j.detail=m.detail and j.result->>'detail'=j.detail and j.payload->>'capability'='development'
 and not (j.payload?'approved') and jsonb_typeof(j.payload->'development_input')='string'
 and c.project_id=p.id and c.worker_id=n.id and c.manager_id=w.manager_id and c.role='development'
 and c.scope_hash=r.scope_hash and c.contract->>'instruction'=j.instruction and admission.fingerprint=project_smart_fingerprint(j)
 and run.binding->>'scopeHash'=r.scope_hash and run.binding->'allowedPaths'=c.contract->'paths'
 and run.binding->>'baseSha'=pa.base_sha and w.status='running'
 and (select count(*) from agent_missions x where x.project_id=p.id)=108
 and (select count(*) from project_work_package_attempts x where x.package_id=w.id)=2
 and not exists(select 1 from project_provider_requests q where q.mission_id=m.id)
 and not exists(select 1 from mission_calls q join mission_assignments x on x.id=q.job_id where x.mission_id=m.id)
 and not exists(select 1 from agent_tasks t join mission_assignments x on x.id=t.id where x.mission_id=m.id)
 and not exists(select 1 from project_provider_dispatches d join mission_assignments x on x.id=d.task_id where x.mission_id=m.id)
 and not exists(select 1 from project_organization_decisions d where d.assignment_id=j.id))
$$;

-- Exact predecessor substitutions. Keep original legacy approval for other
-- projects and all existing authorization, lease and dispatch checks.
DO $patch$
declare d text; target text; a text; b text; edit record;
begin
 for target in select distinct signature from (values
  ('public.mission_development_task(uuid,uuid)'),
  ('public.save_project_development_dispatch(uuid,uuid,text,text,jsonb)'),
  ('public.project_org_package_corrective_checkpoint(uuid)'),
  ('public.project_org_package_corrective_resume(uuid,jsonb)'),
  ('public.project_org_retest_set_release_gate(uuid,text,text,text,bigint)')
 ) signatures(signature) loop
 d:=pg_get_functiondef(target::regprocedure);
 for edit in select * from (values
 ('public.mission_development_task(uuid,uuid)',$a$or j.payload->>'approved' is distinct from 'true' then raise exception 'Development approval unavailable'$a$,$b$or (case when project_org_package_execution_required(m.project_id) then not project_org_package_coding_authorized(j.id,p_lease) else j.payload->>'approved' is distinct from 'true' end) then raise exception 'Development approval unavailable'$b$,1),
 ('public.mission_development_task(uuid,uuid)',$a$frozen_input:=j.payload->>'development_input';$a$,$b$if project_org_package_execution_required(m.project_id) then
  perform project_smart_admit(j.id);
  frozen_input:=prepare_mission_development(j.id,p_lease);
 else frozen_input:=j.payload->>'development_input';end if;$b$,1),
 ('public.save_project_development_dispatch(uuid,uuid,text,text,jsonb)',$a$OR j.payload->>'approved' IS DISTINCT FROM 'true' OR t.kind<>$a$,$b$OR (case when project_org_package_execution_required(p.id) then not project_org_package_coding_authorized(j.id,p_lease) else j.payload->>'approved' is distinct from 'true' end) OR t.kind<>$b$,1),
 ('public.project_org_package_corrective_checkpoint(uuid)',$a$failed_count int; mode text; snapshot jsonb;$a$,$b$failed_count int; mode text; snapshot jsonb; legacy_approval boolean;$b$,1),
 ('public.project_org_package_corrective_checkpoint(uuid)',$a$select * into m from agent_missions where id=p.active_mission_id and project_id=p_project;
 if p.id$a$,$b$select * into m from agent_missions where id=p.active_mission_id and project_id=p_project;
 legacy_approval:=project_org_package_legacy_approval_checkpoint(p_project);
 if p.id$b$,1),
 ('public.project_org_package_corrective_checkpoint(uuid)',$a$or exists(select 1 from agent_missions x where x.project_id=p.id and x.status in('running','awaiting_approval'))$a$,$b$or exists(select 1 from agent_missions x where x.project_id=p.id and x.status in('running','awaiting_approval') and not(legacy_approval and x.id=m.id and x.status='awaiting_approval'))$b$,1),
 ('public.project_org_package_corrective_checkpoint(uuid)',$a$where x.mission_id=m.id and x.status='failed';$a$,$b$where x.mission_id=m.id and (x.status='failed' or (legacy_approval and x.role='development' and x.status='awaiting_approval'));$b$,2),
 ('public.project_org_package_corrective_checkpoint(uuid)',$a$if m.status in('blocked','failed') and j.attempts$a$,$b$if (m.status in('blocked','failed') or legacy_approval) and j.attempts$b$,1),
 ('public.project_org_package_corrective_resume(uuid,jsonb)',$a$stamp timestamptz:=clock_timestamp();$a$,$b$stamp timestamptz:=clock_timestamp(); legacy_approval boolean;$b$,1),
 ('public.project_org_package_corrective_resume(uuid,jsonb)',$a$if p_checkpoint->>'mode'='pre-provider-retest' then
  update mission_assignments$a$,$b$if p_checkpoint->>'mode'='pre-provider-retest' then
  legacy_approval:=project_org_package_legacy_approval_checkpoint(p_project);
  if p_checkpoint->'assignmentResult'->>'status'='awaiting_approval' and not legacy_approval then raise exception 'Exact legacy approval checkpoint changed';end if;
  update mission_assignments$b$,1),
 ('public.project_org_package_corrective_resume(uuid,jsonb)',$a$where id=jid and mission_id=mid and status='failed' and attempts=$a$,$b$where id=jid and mission_id=mid and status=p_checkpoint->'assignmentResult'->>'status' and (status='failed' or (legacy_approval and status='awaiting_approval')) and attempts=$b$,1),
 ('public.project_org_package_corrective_resume(uuid,jsonb)',$a$where id=mid and project_id=p_project and status in('blocked','failed');$a$,$b$where id=mid and project_id=p_project and (status in('blocked','failed') or (legacy_approval and status='awaiting_approval'));$b$,1),
 ('public.project_org_retest_set_release_gate(uuid,text,text,text,bigint)',$a$   and (j.lease is not null or j.lease_until is not null
    or j.status not in ('completed','failed')$a$,$b$   and not (m.id='a1ceb6af-6588-40e4-95c7-ca422f4701f0'::uuid and j.id='316179b0-5dcf-4a05-aad1-9a040b270d58'::uuid
    and project_org_package_legacy_approval_checkpoint(p_project))
   and (j.lease is not null or j.lease_until is not null
    or j.status not in ('completed','failed')$b$,1)
 ) edits(signature,anchor,replacement,expected) where signature=target loop
  a:=edit.anchor;b:=edit.replacement;
  if (length(d)-length(replace(d,a,'')))/length(a)<>edit.expected
  then raise exception 'Unexpected Mission108 predecessor: % / %',target,a;end if;
  d:=replace(d,a,b);
 end loop;
 execute d;
 end loop;
end $patch$;

revoke all on function public.project_org_package_coding_authorized(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.project_org_package_coding_authorized(uuid,uuid) to service_role;
revoke all on function public.project_org_package_legacy_approval_checkpoint(uuid) from public,anon,authenticated,service_role;

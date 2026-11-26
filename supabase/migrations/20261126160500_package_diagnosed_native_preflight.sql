-- One diagnosed, drained continuation of the already-commissioned fourth
-- attempt. Mission111 failed before the native host ran, and the manager
-- subsequently rejected that result and commissioned the next correction.
-- Do not reopen the settled assignment or change historical attempts/decisions.
create function public.project_org_package_preflight_checkpoint(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare p work_projects; w project_work_packages; r project_package_execution_receipts;
 s project_package_completion_receipts; a project_package_invalid_retry_authorizations;
 root project_package_corrective_receipts; k project_package_corrective_receipts;
 pe project_provider_execution; m agent_missions; j mission_assignments; t agent_tasks;
 run project_runs; evaluation project_organization_decisions; repair project_organization_decisions;
 event_row project_events; snap jsonb; missions integer; attempts integer; paid integer;
begin
 select * into p from work_projects where id=p_project;
 select * into r from project_package_execution_receipts where project_id=p_project;
 select * into w from project_work_packages where id=r.package_id and project_id=p_project;
 select * into s from project_package_completion_receipts where project_id=p_project;
 select * into a from project_package_invalid_retry_authorizations where project_id=p_project;
 select * into root from project_package_corrective_receipts where project_id=p_project and ordinal=0;
 select * into k from project_package_corrective_receipts where project_id=p_project order by ordinal desc limit 1;
 select * into pe from project_provider_execution where project_id=p_project;
 if p.id is distinct from 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
 or w.id is distinct from 'f88d4d10-dfe4-479e-a2cf-41b3e8209e47'::uuid
 or p.status is distinct from 'blocked' or p.phase is distinct from 'development'
 or p.detail is distinct from 'Progress watchdog: three consecutive failed development attempts at the same milestone. Completed evidence and consumed budgets are preserved; an explicit diagnosis or revised scope is required before any further work.'
 or p.active_mission_id is not null or p.lease is not null or p.lease_until is not null
 or p.milestone_index is distinct from 0 or p.organization_version is distinct from 1
 or p.cycles is distinct from 3 or p.max_cycles is distinct from 5 or p.max_missions is distinct from 118 or p.token_allowance is distinct from 600000
 or w.status is distinct from 'queued' or w.max_attempts is distinct from 3
 or p.deadline is distinct from r.cutoff or w.deadline is distinct from r.cutoff or pe.deadline is distinct from r.cutoff
 or r.cutoff<=clock_timestamp()+interval '5 minutes'
 or p.approved_hash is distinct from r.scope_hash or p.approval_hash is distinct from r.scope_hash
 or w.scope_hash is distinct from r.scope_hash or pe.approved_scope is distinct from r.scope_hash or pe.owner_id is distinct from r.owner_id
 or root.project_id is null or root.package_id is distinct from w.id or root.owner_id is distinct from r.owner_id
 or root.cutoff is distinct from r.cutoff or root.terms is distinct from r.terms
 or root.corrective_terms is distinct from project_org_package_corrective_terms()
 or s.project_id is null or s.package_id is distinct from w.id or s.owner_id is distinct from r.owner_id
 or s.cutoff is distinct from r.cutoff or s.terms is distinct from project_org_package_completion_terms()
 or s.root_authorization_id is distinct from root.receipt_id
 or a.project_id is null or a.package_id is distinct from w.id or a.owner_id is distinct from r.owner_id
 or a.completion_authorization_id is distinct from s.authorization_id or a.cutoff is distinct from r.cutoff
 or a.terms is distinct from project_org_package_invalid_retry_terms()
 or k.ordinal is distinct from 4 or k.receipt_id is distinct from a.authorization_id
 or k.root_authorization_id is distinct from root.receipt_id or k.owner_id is distinct from r.owner_id
 or k.checkpoint is distinct from a.checkpoint or k.qualification->'invalidRetryTerms' is distinct from a.terms
 or project_org_package_execution_fingerprint(w.id) is distinct from r.contract_fingerprint
 or not project_provider_continued(p.id) or project_provider_request_pending(p.id)
 or exists(select 1 from agent_missions x where x.project_id=p.id and x.status in('running','awaiting_approval','draft'))
 or exists(select 1 from mission_assignments x join agent_missions y on y.id=x.mission_id where y.project_id=p.id and (x.lease is not null or x.lease_until is not null))
 or exists(select 1 from agent_tasks x join mission_assignments y on y.id=x.id join agent_missions z on z.id=y.mission_id where z.project_id=p.id and x.status in('dispatching','submitted'))
 or (select count(*) from agent_missions x where x.project_id=p.id and x.id=any(r.historical_mission_ids))<>104
 or (select count(*) from project_work_packages x where x.project_id=p.id)<>1
 then return null;end if;
 select count(*) into missions from agent_missions where project_id=p.id;
 select count(*) into attempts from project_work_package_attempts where package_id=w.id;
 select count(*) into paid from project_provider_requests x where x.project_id=p.id and x.operation='inference' and not x.mission_id=any(r.historical_mission_ids);
 if missions<>113 or attempts<>3 or paid>=80 then return null;end if;
 if (select count(*) from project_work_package_attempts pa join agent_missions am on am.id=pa.mission_id where pa.package_id=w.id and am.status in('blocked','stopped'))<>3 then return null;end if;
 select am.* into m from project_work_package_attempts pa join agent_missions am on am.id=pa.mission_id where pa.package_id=w.id and pa.attempt=3 and am.project_id=p.id;
 select * into j from mission_assignments where mission_id=m.id and role='development';
 select * into t from agent_tasks where id=j.id;
 select * into run from project_runs where mission_id=m.id and project_id=p.id;
 if m.id is null or m.project_kind is distinct from 'development' or m.status is distinct from 'blocked' or m.calls<>0
 or m.project_evidence->>'packageExecutionAuthorizationId' is distinct from r.authorization_id::text
 or j.id is null or j.status is distinct from 'failed' or j.attempts<>1
 or t.id is null or t.status is distinct from 'blocked' or t.repository_full_name is distinct from 'mfackrell/katie'
 or t.external is distinct from j.result->'external'
 or t.external->>'providerExecutionRelease' is distinct from k.release_sha
 or t.external->>'projectId' is distinct from p.id::text
 or t.external->>'issueNumber' is distinct from '1188'
 or t.external->>'runUrl' is distinct from 'https://github.com/mfackrell/katie/actions/runs/45853736930'
 or t.external->'receipt'->>'run_id' is distinct from '45853736930'
 or t.external->'receipt'->>'issue_number' is distinct from '1188'
 or t.external->'receipt'->>'repository' is distinct from 'mfackrell/katie'
 or t.external->'receipt'->>'outcome' is distinct from 'BLOCKED'
 or t.external->'receipt'->'checks'->>'build' is distinct from 'failure'
 or t.external->'receipt'->>'tested_head_sha' is not null or t.external->'receipt'->>'reviewed_head_sha' is not null
 or t.external->'receipt'->>'pr_url' is not null
 or run.kind is distinct from 'development' or run.milestone_index is distinct from 0
 or run.outcome->>'detail' is distinct from 'Responsible Functional Director commissioned bounded correction; all prior records retained.'
 or exists(select 1 from project_provider_requests q where q.mission_id=m.id)
 or exists(select 1 from mission_calls q where q.job_id=j.id)
 or exists(select 1 from project_provider_dispatches q where q.task_id=j.id)
 then return null;end if;
 select d.* into evaluation from project_organization_decisions d
 join mission_assignments x on x.id=d.assignment_id join agent_missions y on y.id=x.mission_id
 where d.project_id=p.id and d.node_id=w.manager_id and x.status='completed' and y.status='completed'
 and y.project_kind='management' and y.project_evidence->>'previousMissionId'=m.id::text
 and d.decision->0->>'action'='evaluate_package' and d.decision->0->>'packageId'=w.id::text
 and d.decision->0->>'assignmentId'=j.id::text and d.decision->0->'accepted'='false'::jsonb;
 select d.* into repair from project_organization_decisions d
 join mission_assignments x on x.id=d.assignment_id join agent_missions y on y.id=x.mission_id
 where d.project_id=p.id and d.node_id=w.manager_id and x.status='completed' and y.status='completed'
 and y.project_kind='management' and y.project_evidence->>'previousMissionId'=m.id::text
 and d.decision->0->>'action'='repair_package' and d.decision->0->>'packageId'=w.id::text;
 select * into event_row from project_events where project_id=p.id and event='block' and data->>'detail'=p.detail order by created_at desc limit 1;
 if evaluation.id is null or repair.id is null or event_row.id is null then return null;end if;
 snap:=jsonb_build_object('mode','diagnosed-preflight-scheduler','missionId',m.id,'assignmentId',null,
 'failedAssignmentId',j.id,'failedRunId',45853736930,'issueNumber',1188,'failedReleaseSha',k.release_sha,
 'evaluationId',evaluation.id,'repairId',repair.id,'watchdogEventId',event_row.id,
 'usedMissions',missions,'usedAttempts',attempts,'paidInferences',paid,'priorReceiptId',k.receipt_id);
 return snap||jsonb_build_object('stateHash',encode(sha256(convert_to(project_canonical(jsonb_build_object(
  'checkpoint',snap,'projectState',project_org_coding_capacity_state(p.id),'package',to_jsonb(w),
  'failedAssignment',to_jsonb(j),'task',to_jsonb(t),'run',to_jsonb(run),
  'evaluation',to_jsonb(evaluation),'repair',to_jsonb(repair),'watchdog',to_jsonb(event_row),'latestCorrection',to_jsonb(k)
 )),'UTF8')),'hex'));
end $$;

-- Only the existing qualified corrective operator may attest the independently
-- inspected CI failure and successful nonbillable dependency/diagnostic test.
create function public.project_org_package_preflight_qualification(q jsonb,cp jsonb) returns boolean
language sql immutable set search_path=public,pg_temp as $$
 select coalesce(cp->>'mode'='diagnosed-preflight-scheduler'
 and q->'diagnosis'=jsonb_build_object('failedRunId',45853736930,'buildJobId',140026547838,
 'failedStep','Install pinned native SDK for benchmark-bound engineering','setupError','E: Unable to locate package postgresql-16',
 'nativeHostOutcome','skipped','diagnosticsOutcome','failure','runner','ubuntu-24.04',
 'preflightQualification','success','diagnosticQualification','success'),false)
$$;

-- A single already-commissioned development attempt can follow the diagnosis.
-- The immutable corrective receipt is the authorization evidence, not a mutable
-- flag or a reset of the historical watchdog counters. Once the next attempt
-- has been admitted the counts no longer match and this exception is spent.
create function public.project_org_package_preflight_watchdog_pending(p_project uuid,p_lease uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from work_projects p
 join project_package_execution_receipts r on r.project_id=p.id
 join project_work_packages w on w.id=r.package_id
 join project_retest_production_release_gate g on g.project_id=p.id
 join project_package_corrective_receipts k on k.project_id=p.id and k.ordinal=5
 where p.id=p_project and p_lease is not null and p.lease=p_lease and p.lease_until>now()
 and p.active_mission_id is null and p.cycles=3 and p.milestone_index=0 and w.status='queued'
 and k.checkpoint->>'mode'='diagnosed-preflight-scheduler'
 and k.release_sha=g.release_sha and k.release_generation=g.generation and k.deployment_id=g.deployment_id
 and project_org_package_preflight_qualification(k.qualification,k.checkpoint)
 and project_org_package_execution_live(p.id) and not project_provider_request_pending(p.id)
 and (select count(*) from agent_missions m where m.project_id=p.id)=(k.checkpoint->>'usedMissions')::int
 and (select count(*) from project_work_package_attempts x where x.package_id=w.id)=(k.checkpoint->>'usedAttempts')::int
 and (select count(*) from project_provider_requests x where x.project_id=p.id and x.operation='inference' and not x.mission_id=any(r.historical_mission_ids))=(k.checkpoint->>'paidInferences')::int
 and exists(select 1 from project_organization_decisions d where d.id::text=k.checkpoint->>'repairId' and d.project_id=p.id and d.decision->0->>'action'='repair_package'))
$$;

do $patch$
declare edit record; d text;
begin
 for edit in select * from (values
 ('public.project_org_package_corrective_checkpoint(uuid)',$a$ select * into p from work_projects where id=p_project;$a$,$b$ snapshot:=project_org_package_preflight_checkpoint(p_project);
 if snapshot is not null then return snapshot;end if;
 select * into p from work_projects where id=p_project;$b$),
 ('public.project_org_package_corrective_continue(uuid,text,bigint,text,text,jsonb)',$a$ insert into project_package_corrective_receipts(project_id,ordinal,$a$,$b$ if cp->>'mode'='diagnosed-preflight-scheduler' and not project_org_package_preflight_qualification(p_qualification,cp) then
  raise exception 'Exact diagnosed native preflight qualification required';end if;
 insert into project_package_corrective_receipts(project_id,ordinal,$b$),
 ('public.project_org_package_corrective_resume(uuid,jsonb)',$a$ if p_checkpoint->>'mode' in('pre-provider-retest',$a$,$b$ if p_checkpoint->>'mode'='diagnosed-preflight-scheduler' then
  if not exists(select 1 from project_package_corrective_receipts k join project_retest_production_release_gate g on g.project_id=k.project_id
   where k.project_id=p_project and k.ordinal=5 and k.checkpoint=p_checkpoint and k.release_sha=g.release_sha
    and k.release_generation=g.generation and k.deployment_id=g.deployment_id and g.state='active'
    and project_org_package_preflight_qualification(k.qualification,p_checkpoint))
   then raise exception 'Exact qualified preflight receipt required';end if;
  update work_projects set status='running',detail='Qualified diagnosis recorded; resume the already-commissioned correction under existing limits',
   progress_since=stamp,progress_signature=null,error_signature=null,repeated_errors=0,impediment=null,updated_at=stamp
   where id=p_project and active_mission_id is null and status='blocked' and cycles=3 and lease is null and lease_until is null and max_missions=118 and max_cycles=5;
  if not found then raise exception 'Diagnosed preflight checkpoint changed';end if;
  return;
 end if;
 if p_checkpoint->>'mode' in('pre-provider-retest',$b$)
 ) edits(signature,anchor,replacement) loop
  d:=pg_get_functiondef(edit.signature::regprocedure);
  if (length(d)-length(replace(d,edit.anchor,'')))/length(edit.anchor)<>1 then raise exception 'Unexpected preflight predecessor: %',edit.signature;end if;
  execute replace(d,edit.anchor,edit.replacement);
 end loop;
end $patch$;

revoke all on function public.project_org_package_preflight_checkpoint(uuid),
 public.project_org_package_preflight_qualification(jsonb,jsonb),
 public.project_org_package_preflight_watchdog_pending(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.project_org_package_preflight_watchdog_pending(uuid,uuid) to service_role;

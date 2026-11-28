CREATE OR REPLACE FUNCTION public.project_org_package_corrective_continue(p_project uuid, p_release text, p_generation bigint, p_deployment text, p_state_hash text, p_qualification jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare root project_package_corrective_receipts; last_receipt project_package_corrective_receipts; g project_retest_production_release_gate; cp jsonb; new_id uuid:=gen_random_uuid();
begin

 -- Same dispatched workflow, before native admission. The original signed
 -- owner receipt and every paid record remain unchanged.
 IF p_qualification->>'kind'='checkpoint-pre-admission-retest' THEN
  DECLARE c project_package_checkpoint_continuations; wp work_projects; mm agent_missions;
   jj mission_assignments; tt agent_tasks; ww project_work_packages; gg project_retest_production_release_gate;
   old_receipt jsonb; failed_receipt jsonb; v_run text; ev jsonb; stamp timestamptz:=clock_timestamp();
  BEGIN
   PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
   PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
   SELECT * INTO STRICT c FROM project_package_checkpoint_continuations WHERE project_id=p_project;
   SELECT * INTO STRICT wp FROM work_projects WHERE id=c.project_id FOR UPDATE;
   SELECT * INTO STRICT gg FROM project_retest_production_release_gate WHERE project_id=c.project_id FOR UPDATE;
   SELECT * INTO STRICT ww FROM project_work_packages WHERE id=c.package_id FOR UPDATE;
   SELECT * INTO STRICT mm FROM agent_missions WHERE id=c.mission_id FOR UPDATE;
   SELECT * INTO STRICT jj FROM mission_assignments WHERE id=c.assignment_id FOR UPDATE;
   SELECT * INTO STRICT tt FROM agent_tasks WHERE id=c.assignment_id FOR UPDATE;
   v_run:=p_qualification->>'failedRunId';
   old_receipt:=c.prior_state->'task'->'external'->'receipt';
   failed_receipt:=tt.external->'receipt';
   IF NOT COALESCE((
    p_state_hash=c.state_hash AND p_release=c.release_sha AND p_generation=c.release_generation AND p_deployment=c.deployment_id
    AND gg.state='active' AND gg.release_sha=c.release_sha AND gg.generation=c.release_generation AND gg.deployment_id=c.deployment_id AND gg.alias_name='katie-mu.vercel.app'
    AND c.terms=project_org_package_checkpoint_terms() AND c.terms->>'finalReviewDispatches'='1' AND c.terms->>'automaticRetries'='0' AND c.terms->>'additionalPaidRetries'='0'
    AND standalone_verify_scope(c.owner_id,wp.actor_id,wp.chat_id)
    AND EXISTS(SELECT 1 FROM project_events e WHERE e.project_id=c.project_id AND e.event='package_checkpoint_authorized' AND e.data->>'authorizationId'=c.authorization_id::text)
    AND wp.status='blocked' AND wp.phase='development' AND wp.active_mission_id=c.mission_id AND wp.lease IS NULL AND wp.lease_until IS NULL
    AND wp.deadline=c.cutoff AND ww.deadline=c.cutoff AND mm.deadline=c.cutoff AND c.cutoff>stamp+interval '5 minutes'
    AND ww.status='running' AND wp.cycles=(c.prior_state->'project'->>'cycles')::int AND wp.max_missions=(c.terms->>'maxMissions')::int
    AND wp.token_allowance=(c.terms->>'tokenAllowance')::int AND wp.approved_hash=wp.approval_hash AND wp.approved_hash=ww.scope_hash
    AND project_org_package_execution_fingerprint(ww.id)=c.renewed_fingerprint AND project_provider_continued(wp.id)
    AND mm.status='blocked' AND mm.project_id=c.project_id AND mm.project_kind='development' AND mm.project_evidence->>'checkpointRecoveryAuthorizationId'=c.authorization_id::text
    AND jj.status='failed' AND jj.mission_id=mm.id AND jj.role='development' AND jj.attempts=(c.prior_state->'assignment'->>'attempts')::int AND jj.lease IS NULL AND jj.lease_until IS NULL
    AND tt.status='blocked' AND tt.repository_full_name='mfackrell/katie' AND tt.external->>'checkpointRecoveryAuthorizationId'=c.authorization_id::text
    AND tt.external->>'checkpointRecoveryCandidate'=c.proof->>'candidateSha' AND tt.external->>'providerExecutionRelease'=c.release_sha
    AND (tt.external->>'checkpointRecoveryDispatchClaimedAt')::timestamptz+interval '30 minutes'>stamp+interval '3 minutes'
    AND NOT (tt.external ? 'checkpointPreAdmissionFailure')
    AND old_receipt->>'run_id'=c.proof->>'priorRunId' AND old_receipt->>'outcome'='BLOCKED' AND old_receipt->'providerExecutionEvidence'->>'candidateHead'=c.proof->>'candidateSha'
    AND failed_receipt=jj.result->'external'->'receipt' AND failed_receipt->>'run_id'=v_run AND v_run ~ '^[1-9][0-9]*$' AND v_run <> (c.proof->>'priorRunId')
    AND failed_receipt->>'outcome'='BLOCKED' AND failed_receipt->>'repository'=tt.repository_full_name AND failed_receipt->>'issue_number'=tt.external->>'issueNumber'
    AND failed_receipt->>'pr_url' IS NULL AND failed_receipt->>'tested_head_sha' IS NULL AND failed_receipt->>'reviewed_head_sha' IS NULL
    AND failed_receipt->'checks'='{"build":"failure","test":"","review":"","repair":"skipped","retest":"","final_review":""}'::jsonb
    AND p_qualification->>'releaseSha'=p_release AND p_qualification->>'deploymentId'=p_deployment AND p_qualification->>'canonicalAlias'=gg.alias_name
    AND p_qualification->>'conclusion'='failure' AND p_qualification->>'runAttempt'='1' AND p_qualification->>'failedJobId' ~ '^[1-9][0-9]*$'
    AND p_qualification->>'failure'='NATIVE_HOST_DENIED: required durable project_provider_dispatches record missing' AND p_qualification->>'successorRequests'='0'
    AND has_table_privilege('service_role','public.project_provider_dispatches','SELECT') AND has_table_privilege('service_role','public.project_provider_requests','SELECT')
    AND NOT project_provider_request_pending(wp.id)
    AND NOT EXISTS(SELECT 1 FROM project_package_checkpoint_dispatches d WHERE d.authorization_id=c.authorization_id OR d.task_id=c.assignment_id)
    AND EXISTS(SELECT 1 FROM project_provider_dispatches d WHERE d.task_id=c.assignment_id AND d.run_id=c.proof->>'priorRunId')
    AND (SELECT jsonb_agg(to_jsonb(q) ORDER BY q.id) FROM project_provider_requests q WHERE q.project_id=c.project_id)=c.prior_state->'requests'
    AND NOT EXISTS(SELECT 1 FROM mission_assignments x JOIN agent_missions y ON y.id=x.mission_id WHERE y.project_id=c.project_id AND (x.lease IS NOT NULL OR x.lease_until IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM project_events e WHERE e.project_id=c.project_id AND e.event='package_checkpoint_pre_admission_resumed' AND e.data->>'authorizationId'=c.authorization_id::text)
   ),false) THEN RAISE EXCEPTION 'Exact unused signed checkpoint pre-admission evidence required'; END IF;
   ev:=jsonb_build_object('authorizationId',c.authorization_id,'runId',v_run,'receipt',failed_receipt,'assignmentResult',jj.result,'taskDetails',tt.details,'missionDetail',mm.detail,'projectDetail',wp.detail,'qualification',p_qualification,'resumedAt',stamp);
   INSERT INTO project_events(project_id,event,data) VALUES(c.project_id,'package_checkpoint_pre_admission_resumed',ev);
   PERFORM project_org_package_corrective_resume(c.project_id,jsonb_build_object('mode','pre-provider-retest','missionId',mm.id,'assignmentId',jj.id,'priorAttempts',jj.attempts,'assignmentResult',to_jsonb(jj)));
   UPDATE mission_assignments SET status='waiting_external',available_at=stamp,updated_at=stamp WHERE id=jj.id AND status='queued' AND attempts=jj.attempts;
   IF NOT FOUND THEN RAISE EXCEPTION 'Existing waiting-external transition failed'; END IF;
   UPDATE agent_tasks SET status='submitted',details='Same final-review run: verified pre-admission infrastructure correction.',
    external=external||jsonb_build_object('receipt',old_receipt,'checkpointPreAdmissionFailure',ev),updated_at=stamp WHERE id=tt.id AND status='blocked';
   IF NOT FOUND OR NOT project_org_package_checkpoint_dispatch_live(c.assignment_id,c.authorization_id,c.release_sha)
    OR NOT project_provider_dispatch_live(c.assignment_id,wp.approved_hash)
   THEN RAISE EXCEPTION 'Existing signed checkpoint fences were not restored'; END IF;
   RETURN jsonb_build_object('authorizationId',c.authorization_id,'runId',v_run,'mode','checkpoint-pre-admission-retest','successorDispatches',0,'additionalPaidRetries',0);
  END;
 END IF;
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
 if cp->>'mode'='saved-response-replay' and project_org_package_invalid_response_reason((cp->>'assignmentId')::uuid,(cp->>'savedRequestId')::uuid) is not null
 then raise exception 'Invalid saved decision requires authenticated bounded retry authority, not replay';end if;
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
 if cp->>'mode'='diagnosed-preflight-scheduler' and not project_org_package_preflight_qualification(p_qualification,cp) then
  raise exception 'Exact diagnosed native preflight qualification required';end if;
 insert into project_package_corrective_receipts(project_id,ordinal,receipt_id,root_authorization_id,prior_receipt_id,package_id,owner_id,release_sha,release_generation,deployment_id,cutoff,terms,corrective_terms,checkpoint,state_hash,qualification)
 values(p_project,last_receipt.ordinal+1,new_id,root.receipt_id,last_receipt.receipt_id,root.package_id,root.owner_id,p_release,p_generation,p_deployment,root.cutoff,root.terms,root.corrective_terms,cp,p_state_hash,p_qualification);
 perform project_org_package_corrective_resume(p_project,cp);
 if not project_org_package_execution_live(p_project) then raise exception 'Native package authority not live on qualified release';end if;
 if cp->>'mode' in('pre-provider-retest','saved-response-replay','unspent-authorized-retry') and not project_org_retest_claim_release_authorized_epoch(p_project,p_release,p_generation,p_deployment) then raise exception 'Native corrected assignment not eligible';end if;
 insert into project_events(project_id,event,data) values(p_project,'package_corrective_release_continued',
 jsonb_build_object('receiptId',new_id,'rootAuthorizationId',root.receipt_id,'priorReceiptId',last_receipt.receipt_id,'ordinal',last_receipt.ordinal+1,'releaseSha',p_release,'generation',p_generation,'deploymentId',p_deployment,'stateHash',p_state_hash,'qualification',p_qualification,'checkpoint',cp-'assignmentResult'));
 return jsonb_build_object('receiptId',new_id,'rootAuthorizationId',root.receipt_id,'ordinal',last_receipt.ordinal+1,'mode',cp->>'mode','missionId',cp->>'missionId','assignmentId',cp->>'assignmentId');
end $function$;
CREATE OR REPLACE FUNCTION public.project_provider_dispatch_start(p_task uuid, p_scope text, p_run text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if not project_provider_dispatch_live(p_task,p_scope)
 or exists(select 1 from project_provider_requests q join agent_missions m on m.project_id=q.project_id
  join mission_assignments j on j.mission_id=m.id where j.id=p_task and q.resolved_at is null)
 or not exists(select 1 from agent_tasks where id=p_task and external->>'attempted'='true') then return false;end if;
 if exists(select 1 from project_package_checkpoint_continuations c where c.assignment_id=p_task) then
 if not exists(select 1 from project_package_checkpoint_continuations c where c.assignment_id=p_task and p_run~'^[0-9]+$' and p_run<>c.proof->>'priorRunId' and project_org_package_checkpoint_dispatch_live(p_task,c.authorization_id,c.release_sha))
 or (select count(*) from project_provider_dispatches where task_id=p_task)<>1
 or exists(select 1 from project_package_checkpoint_continuations c join project_events e on e.project_id=c.project_id
  where c.assignment_id=p_task and e.event='package_checkpoint_pre_admission_resumed'
  and e.data->>'authorizationId'=c.authorization_id::text and e.data->>'runId' is distinct from p_run)
 then return false;end if;
 insert into project_package_checkpoint_dispatches(authorization_id,task_id,run_id)
 select authorization_id,p_task,p_run from project_package_checkpoint_continuations where assignment_id=p_task on conflict do nothing;
 return found;
 end if;
 insert into project_provider_dispatches(task_id,run_id) values(p_task,p_run) on conflict do nothing;
 return found;
end $function$;

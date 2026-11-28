CREATE OR REPLACE FUNCTION public.project_org_package_corrective_continue(p_project uuid, p_release text, p_generation bigint, p_deployment text, p_state_hash text, p_qualification jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare root project_package_corrective_receipts; last_receipt project_package_corrective_receipts; g project_retest_production_release_gate; cp jsonb; new_id uuid:=gen_random_uuid();
begin

 -- Settle the already completed independent final review from immutable
 -- historical evidence. This is NOT a successful workflow or a paid grant.
 IF p_qualification->>'kind'='retained-final-review-settlement' THEN
  DECLARE c project_package_checkpoint_continuations; wp work_projects;
   ww project_work_packages; mm agent_missions; jj mission_assignments;
   tt agent_tasks; dd project_package_checkpoint_dispatches; rr project_runs;
   last_correction project_package_corrective_receipts; root_correction project_package_corrective_receipts;
   proof jsonb; review_usage jsonb; new_requests jsonb; settled_receipt uuid:=gen_random_uuid();
   stamp timestamptz:=clock_timestamp(); q jsonb:=p_qualification;
  BEGIN
   PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
   PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
   SELECT * INTO STRICT c FROM project_package_checkpoint_continuations WHERE project_id=p_project;
   SELECT * INTO STRICT wp FROM work_projects WHERE id=c.project_id FOR UPDATE;
   SELECT * INTO STRICT ww FROM project_work_packages WHERE id=c.package_id FOR UPDATE;
   SELECT * INTO STRICT mm FROM agent_missions WHERE id=c.mission_id FOR UPDATE;
   SELECT * INTO STRICT jj FROM mission_assignments WHERE id=c.assignment_id FOR UPDATE;
   SELECT * INTO STRICT tt FROM agent_tasks WHERE id=c.assignment_id FOR UPDATE;
   SELECT * INTO STRICT dd FROM project_package_checkpoint_dispatches WHERE authorization_id=c.authorization_id;
   SELECT * INTO STRICT rr FROM project_runs WHERE mission_id=c.mission_id;
   SELECT * INTO STRICT root_correction FROM project_package_corrective_receipts WHERE project_id=c.project_id AND ordinal=0;
   SELECT * INTO STRICT last_correction FROM project_package_corrective_receipts WHERE project_id=c.project_id ORDER BY ordinal DESC LIMIT 1;
   SELECT jsonb_agg(to_jsonb(x) ORDER BY x.started_at,x.id) INTO new_requests FROM project_provider_requests x WHERE x.project_id=c.project_id AND x.started_at>=c.authorized_at;
   review_usage:=q->'providerUsage';
   -- Exact incident: the trusted artifact digest was independently verified
   -- against GitHub's immutable artifact metadata and the downloaded bytes.
   -- This operator-only procedure cannot mint a different verdict or admit
   -- more provider traffic; the unsuccessful workflow receipt stays intact.
   IF NOT COALESCE((
    c.project_id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
    AND c.authorization_id='bec3a442-62d6-4f16-a38b-6143b5668876'::uuid
    AND c.state_hash=p_state_hash AND c.release_sha=p_release AND c.release_generation=p_generation AND c.deployment_id=p_deployment
    AND c.cutoff>stamp AND c.terms=project_org_package_checkpoint_terms()
    AND c.terms->>'finalReviewDispatches'='1' AND c.terms->>'additionalPaidRetries'='0'
    AND c.terms->>'stopAt'='verified-protected-preview'
    AND standalone_verify_scope(c.owner_id,wp.actor_id,wp.chat_id)
    AND EXISTS(SELECT 1 FROM project_events e WHERE e.project_id=c.project_id AND e.event='package_checkpoint_authorized' AND e.data->>'authorizationId'=c.authorization_id::text)
    AND EXISTS(SELECT 1 FROM project_retest_production_release_gate g0 WHERE g0.project_id=c.project_id AND g0.state='active' AND g0.release_sha=c.release_sha AND g0.generation=c.release_generation AND g0.deployment_id=c.deployment_id)
    AND wp.status='blocked' AND wp.phase='development' AND wp.active_mission_id=c.mission_id AND wp.lease IS NULL AND wp.lease_until IS NULL
    AND wp.approved_hash=wp.approval_hash AND wp.approved_hash=ww.scope_hash AND wp.deadline=c.cutoff AND ww.deadline=c.cutoff
    AND wp.cycles=(c.prior_state->'project'->>'cycles')::int AND wp.max_missions=(c.terms->>'maxMissions')::int AND wp.token_allowance=(c.terms->>'tokenAllowance')::int
    AND wp.verified_sha IS NULL AND wp.preview IS NULL AND ww.status='running'
    AND project_org_package_execution_fingerprint(ww.id)=c.renewed_fingerprint AND project_provider_continued(wp.id)
    AND mm.status='blocked' AND mm.project_id=c.project_id AND mm.project_kind='development'
    AND jj.status='failed' AND jj.mission_id=mm.id AND jj.role='development' AND jj.attempts=(c.prior_state->'assignment'->>'attempts')::int AND jj.lease IS NULL AND jj.lease_until IS NULL
    AND tt.status='blocked' AND tt.repository_full_name='mfackrell/katie'
    AND tt.external->>'checkpointRecoveryAuthorizationId'=c.authorization_id::text
    AND tt.external->>'checkpointRecoveryCandidate'=c.proof->>'candidateSha'
    AND tt.external->'receipt'=jj.result->'external'->'receipt'
    AND tt.external->'receipt'->>'outcome'='BLOCKED'
    AND tt.external->'receipt'->>'run_id'=dd.run_id AND dd.task_id=c.assignment_id AND dd.run_id='46156403609'
    AND tt.external->'receipt'->>'pr_url' IS NULL AND tt.external->'receipt'->>'tested_head_sha' IS NULL AND tt.external->'receipt'->>'reviewed_head_sha' IS NULL
    AND tt.external->'receipt'->'providerExecutionEvidence'->>'failure'='NATIVE_HOST_DENIED: review candidate changed'
    AND tt.external->'receipt'->'providerExecutionEvidence'->>'candidateHead'=c.proof->>'candidateSha'
    AND tt.external->'receipt'->'providerExecutionEvidence'->>'responses'='3'
    AND tt.external->'receipt'->'providerExecutionEvidence'->>'observedTokens'='35856'
    AND tt.external->'receipt'->'providerExecutionEvidence'->>'unknownUsage'='0'
    AND q->>'artifactId'='15268103568' AND q->>'artifactSha256'='9a8b69b275e9fdefbc30dd92e01f9b42845050ace063ea47c6d68d5a29fdcd7d'
    AND q->>'diagnosticsSha256'='ab31dbf5373dc17857b5af400f02e587e3849b704213a7fce3f677a3b2647722'
    AND q->>'runId'=dd.run_id AND q->>'runAttempt'='2' AND q->>'workflowConclusion'='failure'
    AND q->>'candidateSha'=c.proof->>'candidateSha' AND q->>'sourceTreeSha'=c.proof->>'sourceTreeSha'
    AND q->>'checkpointSha'='4edaa9592248a90dd91cc662d20cb8a99e6a0031' AND q->>'priorCheckpointSha'=c.proof->>'checkpointSha'
    AND q->>'scopeHash'=wp.approved_hash AND q->>'contractHash'=rr.binding->>'contractHash'
    AND q->>'phase'='final-review' AND q->>'terminalEvent'='turn.completed' AND q->>'exitCode'='0'
    AND q->>'verificationDigest'='f1e330586c02503077205f9eef1b354fc0ddb4987aff0e7b3bf7edf965d462e7'
    AND q->>'initialReviewDigest'='2c12edf30f49125c9e78b1cf9f7d27edd49b8d180ef7d3149965b10f323ec447'
    AND q->>'findings' LIKE 'PASS %'
    AND encode(sha256(convert_to(q->>'findings','UTF8')),'hex')='30d8b6de1c299904980ef49f9f783cb952fbcdad1925986a3e9143ff45347429'
    AND q->'snapshots'=jsonb_build_array(
      jsonb_build_object('label','initial','head',c.proof->>'candidateSha','status',jsonb_build_array('?? AGENT_REQUEST.md')),
      jsonb_build_object('label','after-final-review','head',c.proof->>'candidateSha','status',jsonb_build_array('?? AGENT_REQUEST.md')),
      jsonb_build_object('label','final','head',c.proof->>'candidateSha','status',jsonb_build_array('?? AGENT_REQUEST.md')))
    AND review_usage='{"responses":3,"observedTokens":35856,"unknownUsage":0,"receipts":[{"providerRequestId":"resp_0978b7c69bb48120016b0aed6ae22c87d1aff0f38e86a7fd6b","actualTokens":7429},{"providerRequestId":"resp_0978b7c69bb48120016b0aed70bae887d1a689f400f6727cf8","actualTokens":12523},{"providerRequestId":"resp_0978b7c69bb48120016b0aed80bbd087d192f2531ff0827119","actualTokens":15904}]}'::jsonb
    AND NOT project_provider_request_pending(wp.id)
    AND (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM project_provider_requests x WHERE x.project_id=c.project_id AND x.started_at<c.authorized_at)=c.prior_state->'requests'
    AND jsonb_array_length(new_requests)=6
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(new_requests) WITH ORDINALITY a(v,n)
      WHERE v->>'project_id'<>c.project_id::text OR v->>'assignment_id'<>c.assignment_id::text OR v->>'mission_id'<>c.mission_id::text OR v->>'worker_id'<>jj.agent_id::text
        OR v->>'execution_attempt'<>dd.run_id OR v->>'resolved_at' IS NULL OR v->>'provider_receipt' IS NULL
        OR (v->>'resolved_at')::timestamptz<(v->>'started_at')::timestamptz
        OR (n>1 AND (v->>'started_at')::timestamptz<((new_requests->(n::int-2))->>'resolved_at')::timestamptz)
        OR (n%2=1 AND (v->>'operation'<>'input-count' OR v->>'provider_receipt'<>'input-token-count' OR v->>'request_hash' IS DISTINCT FROM (new_requests->n::int)->>'request_hash'))
        OR (n%2=0 AND (v->>'operation'<>'inference' OR v->>'provider_receipt' IS DISTINCT FROM review_usage->'receipts'->(n::int/2-1)->>'providerRequestId')))
    AND last_correction.ordinal=5 AND last_correction.root_authorization_id=root_correction.receipt_id
    AND root_correction.package_id=c.package_id AND root_correction.owner_id=c.owner_id
    AND NOT EXISTS(SELECT 1 FROM mission_assignments x JOIN agent_missions y ON y.id=x.mission_id WHERE y.project_id=c.project_id AND (x.lease IS NOT NULL OR x.lease_until IS NOT NULL))
   ),false) THEN RAISE EXCEPTION 'Exact authenticated retained final review and settled provider history required'; END IF;
   proof:=jsonb_build_object('mode','retained-final-review-settlement','authorizationId',c.authorization_id,'missionId',c.mission_id,'assignmentId',c.assignment_id,
     'candidateSha',c.proof->>'candidateSha','sourceTreeSha',c.proof->>'sourceTreeSha','scopeHash',wp.approved_hash,'contractHash',rr.binding->>'contractHash',
     'reviewVerdict','pass','providerRequests',new_requests,'nativeDispatchConsumed',true,'additionalPaidInference',0,
     'workflowReceipt',tt.external->'receipt','browserAcceptancePending',true,'independentOrganizationalAcceptancePending',true);
   INSERT INTO project_package_corrective_receipts(project_id,ordinal,receipt_id,root_authorization_id,prior_receipt_id,package_id,owner_id,release_sha,release_generation,deployment_id,cutoff,terms,corrective_terms,checkpoint,state_hash,qualification)
    VALUES(c.project_id,last_correction.ordinal+1,settled_receipt,root_correction.receipt_id,last_correction.receipt_id,c.package_id,c.owner_id,c.release_sha,c.release_generation,c.deployment_id,root_correction.cutoff,root_correction.terms,root_correction.corrective_terms,proof,c.state_hash,q);
   INSERT INTO project_events(project_id,event,data) VALUES(c.project_id,'package_checkpoint_final_review_settled',
    jsonb_build_object('receiptId',settled_receipt,'authorizationId',c.authorization_id,'candidateSha',c.proof->>'candidateSha','artifactId',q->>'artifactId','reviewVerdict','pass','additionalPaidInference',0,'deliveryPending',true));
   RETURN jsonb_build_object('receiptId',settled_receipt,'candidateSha',c.proof->>'candidateSha','mode','retained-final-review-settlement','reviewVerdict','pass','additionalPaidInference',0,'deliveryPending',true);
  END;
 END IF;

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

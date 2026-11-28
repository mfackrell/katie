-- Carry only the original checkpoint's unspent final assessment across a
-- qualified runtime release. This adds no call, mission, retry or time allowance.
-- Native coding/final review and the earlier nonbillable predicate are intact.
BEGIN;
CREATE FUNCTION public.project_org_package_final_assessment_release_live(
 p_project uuid,p_release text,p_generation bigint,p_deployment text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c project_package_checkpoint_continuations; p work_projects; w project_work_packages;
 r project_package_execution_receipts; a project_provider_execution; g project_retest_production_release_gate;
 s project_package_corrective_receipts; m agent_missions; e jsonb; consumed jsonb; completed jsonb;
 writer uuid; reviewer uuid; assessments integer;
BEGIN
 SELECT * INTO c FROM project_package_checkpoint_continuations WHERE project_id=p_project;
 IF c.project_id IS NULL THEN RETURN false; END IF;
 e:=project_development_review_settlement(c.assignment_id);
 IF e IS NULL THEN RETURN false; END IF;
 SELECT * INTO p FROM work_projects WHERE id=p_project;
 SELECT * INTO w FROM project_work_packages WHERE id=c.package_id AND project_id=p_project;
 SELECT * INTO r FROM project_package_execution_receipts WHERE project_id=p_project;
 SELECT * INTO a FROM project_provider_execution WHERE project_id=p_project;
 SELECT * INTO g FROM project_retest_production_release_gate WHERE project_id=p_project;
 SELECT * INTO s FROM project_package_corrective_receipts WHERE receipt_id=(e->>'receiptId')::uuid;
 SELECT data INTO consumed FROM project_events WHERE project_id=p_project
  AND event='development_review_settlement_consumed' AND data->>'receiptId'=e->>'receiptId';
 SELECT data INTO completed FROM project_events WHERE project_id=p_project
  AND event='single_package_development_completed' AND data->>'receiptId'=e->>'receiptId';
 SELECT agent_id INTO writer FROM project_organization_nodes WHERE id=w.writer_id;
 SELECT agent_id INTO reviewer FROM project_organization_nodes WHERE id=w.reviewer_id;
 SELECT count(*) INTO assessments FROM agent_missions WHERE project_id=p_project
  AND project_kind='assessment' AND created_at>=c.authorized_at;
 IF assessments=1 THEN SELECT * INTO m FROM agent_missions WHERE project_id=p_project
  AND project_kind='assessment' AND created_at>=c.authorized_at; END IF;
 IF NOT coalesce((
  c.cutoff>clock_timestamp() AND c.terms=project_org_package_checkpoint_terms()
  AND c.terms->>'stopAt'='verified-protected-preview' AND c.terms->>'additionalPaidRetries'='0'
  AND p.status='running' AND p.phase IN('delivery','browser_check','assessment')
  AND p.organization_version=1 AND jsonb_array_length(p.spec->'milestones')=1
  AND p.spec->'milestones'->0->'contract'=p.spec->'finalContract'
  AND p.milestone_index=1 AND p.verified_sha=e->>'candidateSha'
  AND p.deadline=c.cutoff AND w.deadline=c.cutoff AND a.deadline=c.cutoff
  AND c.owner_id=r.owner_id AND a.owner_id=c.owner_id AND a.window_id=c.authorization_id
  AND r.package_id=w.id AND w.status='accepted'
  AND p.approved_hash=r.scope_hash AND p.approval_hash=r.scope_hash
  AND w.scope_hash=r.scope_hash AND a.approved_scope=r.scope_hash
  AND p.max_missions=(c.terms->>'maxMissions')::int AND p.max_cycles=(c.terms->>'developmentAttempts')::int
  AND p.cycles=4 AND p.token_allowance=(c.terms->>'tokenAllowance')::int
  AND project_org_package_execution_fingerprint(w.id)=c.renewed_fingerprint
  AND project_provider_continued(p_project)
  AND (SELECT count(*) FROM agent_missions WHERE project_id=p_project AND id=ANY(r.historical_mission_ids))=104
  AND (SELECT count(*) FROM agent_missions WHERE project_id=p_project)<=p.max_missions
  AND (SELECT count(*) FROM project_work_packages WHERE project_id=p_project)=1
  AND (SELECT count(*) FROM project_work_package_attempts WHERE package_id=w.id)=4
  AND (SELECT count(*) FROM project_provider_requests q WHERE q.project_id=p_project
    AND q.operation='inference' AND NOT q.mission_id=ANY(r.historical_mission_ids))<=(c.terms->>'paidInferenceLimit')::int
  AND EXISTS(SELECT 1 FROM project_execution_windows x WHERE x.id=c.authorization_id
    AND x.project_id=p_project AND x.owner_id=c.owner_id AND x.cutoff=c.cutoff)
  AND EXISTS(SELECT 1 FROM agent_missions WHERE id=c.mission_id AND project_id=p_project
    AND status='completed' AND result=completed->>'summary')
  AND EXISTS(SELECT 1 FROM mission_assignments WHERE id=c.assignment_id AND mission_id=c.mission_id
    AND status='completed' AND result->'verification'=consumed->'verification'
    AND w.evidence=jsonb_build_object('source','consumed-independent-native-review-and-deployed-browser',
      'head',e->>'candidateSha','assignmentId',c.assignment_id,'result',result,
      'receiptId',e->>'receiptId','authorizationId',c.authorization_id))
  AND completed->>'authorizationId'=c.authorization_id::text AND completed->>'packageId'=w.id::text
  AND completed->>'missionId'=c.mission_id::text AND completed->>'assignmentId'=c.assignment_id::text
  AND completed->>'head'=e->>'candidateSha' AND completed->>'additionalPaidInference'='0'
  AND completed->>'source'='consumed-independent-native-review-and-deployed-browser'
  AND consumed->>'assignmentId'=c.assignment_id::text AND consumed->>'authorizationId'=c.authorization_id::text
  AND consumed->'result'->>'consumed'='true' AND consumed->'result'->>'additionalPaidInference'='0'
  AND consumed->'verification'->>'observedHeadSha'=e->>'candidateSha'
  AND consumed->'browserAcceptance'->>'passed'='true'
  AND consumed->'browserAcceptance'->>'headSha'=e->>'candidateSha'
  AND consumed->'browserAcceptance'->>'contractHash'=e->>'contractHash'
  AND p.spec->'finalContract'=e->'binding'->'contract'
  AND g.state='active' AND g.alias_name='katie-mu.vercel.app'
  AND g.release_sha=p_release AND g.generation=p_generation AND g.deployment_id=p_deployment
  AND EXISTS(SELECT 1 FROM project_events q WHERE q.project_id=p_project AND q.event='package_nonbillable_release_qualified'
    AND q.data->>'releaseSha'=p_release AND q.data->>'generation'=p_generation::text AND q.data->>'deploymentId'=p_deployment
    AND q.data->'checkpoint'->>'authorizationId'=c.authorization_id::text
    AND q.data->'checkpoint'->>'settlementId'=e->>'receiptId'
    AND q.data->'checkpoint'->>'candidateSha'=e->>'candidateSha'
    AND q.data->'checkpoint'->>'scopeHash'=r.scope_hash
    AND (q.data->'checkpoint'->>'cutoff')::timestamptz=c.cutoff
    AND q.data->'qualification'->>'conclusion'='success')
  AND writer IS NOT NULL AND reviewer IS NOT NULL AND writer<>reviewer
  AND assessments BETWEEN 0 AND 1
  AND (p.phase='assessment' OR p.active_mission_id IS NULL)
  AND (p.phase<>'assessment' OR p.preview=(consumed#>'{verification,preview}')
    ||jsonb_build_object('browserAcceptance',consumed->'browserAcceptance'))
  AND (assessments=0 AND p.active_mission_id IS NULL OR assessments=1
    AND m.project_evidence->>'checkpointRecoveryAuthorizationId'=c.authorization_id::text
    AND m.project_evidence->>'packageExecutionAuthorizationId'=r.authorization_id::text
    AND m.project_evidence->>'approvedScopeHash'=r.scope_hash
    AND m.project_evidence->'approvedFinalContract'=p.spec->'finalContract'
    AND m.project_evidence->'preview'=p.preview
    AND m.project_evidence#>>'{finalIntegratedEvidence,taskId}'=c.assignment_id::text
    AND m.project_evidence#>>'{finalIntegratedEvidence,head}'=e->>'candidateSha'
    AND m.project_evidence#>>'{finalIntegratedEvidence,verification,observedHeadSha}'=e->>'candidateSha'
    AND m.project_evidence#>>'{finalIntegratedEvidence,verification,testedHeadSha}'=e->>'candidateSha'
    AND m.project_evidence#>>'{finalIntegratedEvidence,verification,reviewedHeadSha}'=e->>'candidateSha'
    AND m.project_evidence#>'{finalIntegratedEvidence,verification,projectAcceptance}'=consumed#>'{verification,projectAcceptance}'
    AND m.status IN('running','completed') AND m.deadline<=c.cutoff AND m.deadline>clock_timestamp()
    AND (p.phase<>'assessment' OR p.active_mission_id=m.id)
    AND (SELECT count(*) FROM mission_assignments WHERE mission_id=m.id)=3
    AND (SELECT count(*) FROM mission_assignments WHERE mission_id=m.id AND role='plan' AND job_key='plan' AND status='completed')=1
    AND (SELECT count(*) FROM mission_assignments WHERE mission_id=m.id AND role='compose' AND job_key='compose' AND agent_id=writer)=1
    AND (SELECT count(*) FROM mission_assignments WHERE mission_id=m.id AND role='review' AND job_key='review' AND agent_id=reviewer)=1
    AND NOT EXISTS(SELECT 1 FROM mission_assignments j WHERE j.mission_id=m.id AND j.role IN('compose','review')
      AND NOT (j.status='queued' AND j.attempts=0 OR j.status IN('running','completed') AND j.attempts=1)))
 ),false) THEN RETURN false; END IF;
 -- The shared resolver validates the original settled run unchanged. Every
 -- later row must belong to this one assessment's first ordinary provider
 -- pass; catalog reads are not counted as paid inferences.
 IF EXISTS(SELECT 1 FROM project_provider_requests q
  LEFT JOIN mission_assignments j ON j.id=q.assignment_id
  WHERE q.project_id=p_project AND q.started_at>=c.authorized_at
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.checkpoint->'providerRequests') old WHERE old->>'id'=q.id::text)
  AND (m.id IS NULL OR q.mission_id IS DISTINCT FROM m.id OR j.mission_id IS DISTINCT FROM m.id
    OR j.role NOT IN('compose','review') OR j.job_key IS DISTINCT FROM j.role
    OR q.worker_id IS DISTINCT FROM j.agent_id OR j.attempts IS DISTINCT FROM 1
    OR q.operation NOT IN('model-list','inference') OR q.started_at<m.created_at OR j.status NOT IN('running','completed')
    OR q.execution_attempt IS NULL OR q.execution_attempt !~ '^[a-f0-9-]{36}$'
    OR (j.status='running' AND q.execution_attempt IS DISTINCT FROM j.lease::text)
    OR (j.status='completed' AND (q.resolved_at IS NULL OR q.provider_receipt IS NULL))
    OR (SELECT count(*) FROM project_provider_requests x WHERE x.assignment_id=j.id AND x.operation=q.operation)>1
    OR EXISTS(SELECT 1 FROM project_provider_requests x WHERE x.assignment_id=j.id AND x.execution_attempt IS DISTINCT FROM q.execution_attempt)))
 THEN RETURN false; END IF;
 RETURN true;
END $$;

DO $patch$
DECLARE d text; anchor text;
BEGIN
 d:=pg_get_functiondef('public.project_org_package_checkpoint_live(uuid)'::regprocedure);
 anchor:='AND g.state=''active'' AND g.alias_name=''katie-mu.vercel.app'' AND g.release_sha=c.release_sha AND g.generation=c.release_generation AND g.deployment_id=c.deployment_id';
 IF (length(d)-length(replace(d,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Unexpected checkpoint release predecessor'; END IF;
 EXECUTE replace(d,anchor,'AND g.state=''active'' AND g.alias_name=''katie-mu.vercel.app'' AND ((g.release_sha=c.release_sha AND g.generation=c.release_generation AND g.deployment_id=c.deployment_id) OR project_org_package_final_assessment_release_live(p.id,g.release_sha,g.generation,g.deployment_id))');
 d:=pg_get_functiondef('public.project_org_package_release_matches(uuid,text,bigint,text)'::regprocedure);
 anchor:='then exists(select 1 from project_package_checkpoint_continuations c where c.project_id=p_project and c.release_sha=p_release and c.release_generation=p_generation and c.deployment_id=p_deployment)';
 IF (length(d)-length(replace(d,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Unexpected release matching predecessor'; END IF;
 -- Also fence stale original runtimes: once the gate moves, passing the old
 -- signed SHA must not authorize claims on the newly qualified runtime.
 EXECUTE replace(d,anchor,'then exists(select 1 from project_package_checkpoint_continuations c join project_retest_production_release_gate g on g.project_id=c.project_id where c.project_id=p_project and g.state=''active'' and g.release_sha=p_release and g.generation=p_generation and g.deployment_id=p_deployment and ((c.release_sha=p_release and c.release_generation=p_generation and c.deployment_id=p_deployment) or project_org_package_final_assessment_release_live(p_project,p_release,p_generation,p_deployment)))');
 d:=pg_get_functiondef('public.project_org_package_execution_assignment(uuid)'::regprocedure);
 anchor:='and project_org_package_execution_live(p.id) and project_provider_continued_assignment(j.id)';
 IF (length(d)-length(replace(d,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Unexpected package assignment predecessor'; END IF;
 EXECUTE replace(d,anchor||'',anchor||$condition$
 and (not exists(select 1 from project_package_checkpoint_continuations c join project_retest_production_release_gate g on g.project_id=c.project_id
  where c.project_id=p.id and (g.release_sha is distinct from c.release_sha or g.generation is distinct from c.release_generation or g.deployment_id is distinct from c.deployment_id))
  or (m.project_kind='assessment' and p.phase='assessment' and j.role in('compose','review') and j.job_key=j.role and j.attempts between 0 and 1))
$condition$);
END $patch$;
REVOKE ALL ON FUNCTION public.project_org_package_final_assessment_release_live(uuid,text,bigint,text) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;

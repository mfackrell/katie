-- A settled review is a separate evidence source, not a successful workflow.
-- Reading it never resumes execution, changes the original receipt, renews
-- authority, or creates provider work. The accepted historical evidence stays
-- readable after its execution window closes or the application is released.
CREATE FUNCTION public.project_development_review_settlement(p_task uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $$
DECLARE
 s public.project_package_corrective_receipts;
 c public.project_package_checkpoint_continuations;
 p public.work_projects;
 w public.project_work_packages;
 m public.agent_missions;
 j public.mission_assignments;
 t public.agent_tasks;
 r public.project_runs;
 d public.project_package_checkpoint_dispatches;
 q jsonb; cp jsonb; requests jsonb; count_settlements integer;
BEGIN
 SELECT count(*) INTO count_settlements
 FROM public.project_package_corrective_receipts
 WHERE checkpoint->>'mode'='retained-final-review-settlement'
 AND checkpoint->>'assignmentId'=p_task::text;
 IF count_settlements=0 THEN RETURN NULL; END IF;
 IF count_settlements<>1 THEN RAISE EXCEPTION 'Ambiguous retained review settlement'; END IF;
 SELECT * INTO STRICT s FROM public.project_package_corrective_receipts
 WHERE checkpoint->>'mode'='retained-final-review-settlement'
 AND checkpoint->>'assignmentId'=p_task::text;
 cp:=s.checkpoint; q:=s.qualification;
 SELECT * INTO STRICT c FROM public.project_package_checkpoint_continuations
 WHERE authorization_id=(cp->>'authorizationId')::uuid;
 SELECT * INTO STRICT p FROM public.work_projects WHERE id=s.project_id;
 SELECT * INTO STRICT w FROM public.project_work_packages WHERE id=s.package_id;
 SELECT * INTO STRICT m FROM public.agent_missions WHERE id=c.mission_id;
 SELECT * INTO STRICT j FROM public.mission_assignments WHERE id=p_task;
 SELECT * INTO STRICT t FROM public.agent_tasks WHERE id=p_task;
 SELECT * INTO STRICT r FROM public.project_runs WHERE mission_id=c.mission_id;
 SELECT * INTO STRICT d FROM public.project_package_checkpoint_dispatches WHERE authorization_id=c.authorization_id;
 SELECT jsonb_agg(to_jsonb(x) ORDER BY x.started_at,x.id) INTO requests
 FROM public.project_provider_requests x
 WHERE x.project_id=s.project_id AND x.assignment_id=p_task
 AND x.execution_attempt=d.run_id;

 IF NOT COALESCE((
  s.project_id=c.project_id AND s.package_id=c.package_id AND s.owner_id=c.owner_id
  AND s.recorded_at>=c.authorized_at AND s.recorded_at<c.cutoff
  AND s.state_hash=c.state_hash
  AND public.standalone_verify_scope(c.owner_id,p.actor_id,p.chat_id)
  -- Native tasks belong to the appointed execution agent's conversation.
  -- The owner is authenticated on the project above, then bound through the
  -- original mission/assignment; a task chat is not the owner's project chat.
  AND t.agent_id=j.agent_id AND t.kind='development' AND t.repository_id=m.repository_id
  AND m.repository_id=p.repository_id AND t.initial_input=j.payload->>'development_input'
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(m.team) member
   WHERE member->>'id'=j.agent_id::text AND member->'config'=t.snapshot
    AND (member->>'version')::integer=t.definition_version)
  AND EXISTS(SELECT 1 FROM managed_agents a WHERE a.id=j.agent_id AND a.actor_id=t.actor_id)
  AND EXISTS(SELECT 1 FROM chats ch WHERE ch.id=t.chat_id AND ch.actor_id=t.actor_id)
  AND c.prior_state->'task' ?& ARRAY['id','agent_id','actor_id','chat_id','kind','repository_id','repository_full_name','initial_input','snapshot','definition_version']
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['id','agent_id','actor_id','chat_id','kind','repository_id','repository_full_name','initial_input','snapshot','definition_version']) field
   WHERE to_jsonb(t)->field IS DISTINCT FROM c.prior_state->'task'->field)
  AND w.project_id=p.id AND w.scope_hash=p.approved_hash AND p.approved_hash=p.approval_hash
  AND m.project_id=p.id AND m.project_kind='development'
  AND j.mission_id=m.id AND j.role='development' AND c.assignment_id=j.id
  AND cp->>'missionId'=m.id::text AND cp->>'assignmentId'=j.id::text
  AND cp->>'scopeHash'=p.approved_hash AND cp->>'contractHash'=r.binding->>'contractHash'
  AND r.project_id=p.id AND r.kind='development' AND r.binding->>'projectId'=p.id::text
  AND r.binding->>'scopeHash'=p.approved_hash
  AND r.binding->>'contractHash'=encode(sha256(convert_to(public.project_canonical(r.binding->'contract'),'UTF8')),'hex')
  AND r.binding->'contract'=w.contract->'milestone'->'contract'
  AND cp->>'candidateSha' ~ '^[a-f0-9]{40}$' AND cp->>'sourceTreeSha' ~ '^[a-f0-9]{40}$'
  AND cp->>'candidateSha'=c.proof->>'candidateSha' AND cp->>'sourceTreeSha'=c.proof->>'sourceTreeSha'
  AND cp->>'reviewVerdict'='pass' AND cp->>'additionalPaidInference'='0'
  AND cp->>'nativeDispatchConsumed'='true'
  AND cp->'workflowReceipt'=t.external->'receipt'
  AND cp->'workflowReceipt'->>'outcome'='BLOCKED'
  AND cp->'workflowReceipt'->>'repository'=t.repository_full_name
  AND cp->'workflowReceipt'->>'issue_number'=t.external->>'issueNumber'
  AND cp->'workflowReceipt'->>'run_id'=d.run_id AND d.task_id=t.id
  AND t.external->>'checkpointRecoveryAuthorizationId'=c.authorization_id::text
  AND t.external->>'checkpointRecoveryCandidate'=cp->>'candidateSha'
  AND q->>'kind'='retained-final-review-settlement' AND q->>'phase'='final-review'
  AND q->>'runId'=d.run_id AND q->>'workflowConclusion'='failure'
  AND q->>'candidateSha'=cp->>'candidateSha' AND q->>'sourceTreeSha'=cp->>'sourceTreeSha'
  AND q->>'scopeHash'=cp->>'scopeHash' AND q->>'contractHash'=cp->>'contractHash'
  AND q->>'terminalEvent'='turn.completed' AND q->>'exitCode'='0' AND q->>'findings' LIKE 'PASS %'
  AND q->>'artifactId' ~ '^[1-9][0-9]*$' AND q->>'artifactSha256' ~ '^[a-f0-9]{64}$'
  AND q->>'diagnosticsSha256' ~ '^[a-f0-9]{64}$' AND q->>'verificationDigest' ~ '^[a-f0-9]{64}$'
  AND jsonb_array_length(q->'snapshots')>=3
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'snapshots') v WHERE v->>'head' IS DISTINCT FROM cp->>'candidateSha')
  AND jsonb_typeof(requests)='array' AND requests=cp->'providerRequests'
  AND jsonb_array_length(requests)>0
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(requests) v
   WHERE v->>'mission_id' IS DISTINCT FROM m.id::text OR v->>'worker_id' IS DISTINCT FROM j.agent_id::text
   OR v->>'resolved_at' IS NULL OR v->>'provider_receipt' IS NULL
   OR (v->>'resolved_at')::timestamptz<(v->>'started_at')::timestamptz
   OR (v->>'started_at')::timestamptz<c.authorized_at OR (v->>'resolved_at')::timestamptz>s.recorded_at)
  AND q->'providerUsage'->>'unknownUsage'='0'
  AND (q->'providerUsage'->>'responses')::integer=(SELECT count(*) FROM jsonb_array_elements(requests) v WHERE v->>'operation'='inference')
  AND jsonb_array_length(q->'providerUsage'->'receipts')=(q->'providerUsage'->>'responses')::integer
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'providerUsage'->'receipts') v
   WHERE (SELECT count(*) FROM jsonb_array_elements(requests) x WHERE x->>'operation'='inference'
    AND x->>'provider_receipt'=v->>'providerRequestId')<>1)
  AND EXISTS(SELECT 1 FROM public.project_events e WHERE e.project_id=p.id
   AND e.event='package_checkpoint_authorized' AND e.data->>'authorizationId'=c.authorization_id::text
   AND e.created_at<=s.recorded_at)
  AND EXISTS(SELECT 1 FROM public.project_events e WHERE e.project_id=p.id
   AND e.event='package_checkpoint_final_review_settled' AND e.data->>'receiptId'=s.receipt_id::text
   AND e.data->>'authorizationId'=c.authorization_id::text AND e.data->>'candidateSha'=cp->>'candidateSha'
   AND e.data->>'reviewVerdict'='pass' AND e.data->>'additionalPaidInference'='0')
 ),false) THEN RAISE EXCEPTION 'Retained review settlement no longer matches its authenticated evidence'; END IF;
 RETURN jsonb_build_object('version',1,'receiptId',s.receipt_id,'authorizationId',c.authorization_id,
  'projectId',p.id,'packageId',w.id,'missionId',m.id,'assignmentId',j.id,
  'candidateSha',cp->>'candidateSha','sourceTreeSha',cp->>'sourceTreeSha',
  'scopeHash',cp->>'scopeHash','contractHash',cp->>'contractHash',
  'workflowReceipt',cp->'workflowReceipt','qualification',q,'binding',r.binding,
  'recordedAt',s.recorded_at,'cutoff',c.cutoff);
END $$;
REVOKE ALL ON FUNCTION public.project_development_review_settlement(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_development_review_settlement(uuid) TO service_role;

-- Reuse the existing append-only event stream and assignment checkpoint.
-- A technical acceptance is not an organizational decision or delivered project.
CREATE UNIQUE INDEX project_review_settlement_consumed_once
 ON public.project_events(project_id,(data->>'receiptId'))
 WHERE event='development_review_settlement_consumed';
CREATE FUNCTION public.project_review_settlement_consumption_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.event='development_review_settlement_consumed' AND current_user<>'postgres' THEN
   RAISE EXCEPTION 'Retained review consumption requires its authenticated definer';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.event='development_review_settlement_consumed'
  OR (TG_OP='UPDATE' AND NEW.event='development_review_settlement_consumed')
 THEN RAISE EXCEPTION 'Retained review consumption history is append-only'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER project_review_settlement_consumption_guard
 BEFORE INSERT OR UPDATE OR DELETE ON public.project_events FOR EACH ROW
 EXECUTE FUNCTION public.project_review_settlement_consumption_guard();

CREATE FUNCTION public.project_consume_development_review_settlement(
 p_task uuid,p_receipt uuid,p_release text,p_generation bigint,p_deployment text,
 p_evidence jsonb,p_browser jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 e jsonb; prior jsonb; result jsonb; v jsonb; paths jsonb; delta_paths jsonb;
 p public.work_projects; m public.agent_missions; j public.mission_assignments;
 t public.agent_tasks; c public.project_package_checkpoint_continuations;
 stamp timestamptz:=clock_timestamp();
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 e:=public.project_development_review_settlement(p_task);
 IF e IS NULL OR e->>'receiptId' IS DISTINCT FROM p_receipt::text THEN
  RAISE EXCEPTION 'Exact retained review settlement required';
 END IF;
 SELECT * INTO STRICT p FROM public.work_projects WHERE id=(e->>'projectId')::uuid FOR UPDATE;
 SELECT * INTO STRICT m FROM public.agent_missions WHERE id=(e->>'missionId')::uuid FOR UPDATE;
 SELECT * INTO STRICT j FROM public.mission_assignments WHERE id=p_task FOR UPDATE;
 SELECT * INTO STRICT t FROM public.agent_tasks WHERE id=p_task FOR UPDATE;
 SELECT * INTO STRICT c FROM public.project_package_checkpoint_continuations WHERE project_id=p.id;
 SELECT data INTO prior FROM public.project_events WHERE project_id=p.id
  AND event='development_review_settlement_consumed' AND data->>'receiptId'=p_receipt::text;
 IF prior IS NOT NULL THEN
  IF prior->'verification' IS DISTINCT FROM p_evidence OR prior->'browserAcceptance' IS DISTINCT FROM p_browser
   OR prior->>'assignmentId' IS DISTINCT FROM p_task::text
   OR j.status IS DISTINCT FROM 'completed' OR j.result->'verification' IS DISTINCT FROM p_evidence
  THEN RAISE EXCEPTION 'Retained review consumption conflicts with the saved result'; END IF;
  RETURN prior->'result';
 END IF;
 paths:=COALESCE(e->'binding'->'cumulativePaths',e->'binding'->'allowedPaths');
 delta_paths:=e->'binding'->'allowedPaths';
 v:=p_evidence->'preview';
 IF NOT COALESCE((
  public.project_org_package_nonbillable_release_live(p.id,p_release,p_generation,p_deployment)
  AND c.cutoff>stamp AND p.deadline=c.cutoff
  AND p.status='blocked' AND p.phase='development' AND p.active_mission_id=m.id
  AND p.lease IS NULL AND p.lease_until IS NULL AND p.verified_sha IS NULL AND p.preview IS NULL
  AND m.status='blocked'
  AND j.status='failed' AND j.lease IS NULL AND j.lease_until IS NULL
  AND t.status='blocked' AND j.result->'external'->'receipt'=e->'workflowReceipt'
  AND NOT public.project_provider_request_pending(p.id)
  AND NOT EXISTS(SELECT 1 FROM public.mission_assignments x JOIN public.agent_missions y ON y.id=x.mission_id
   WHERE y.project_id=p.id AND (x.lease IS NOT NULL OR x.lease_until IS NOT NULL))
  AND p_evidence->>'observedHeadSha'=e->>'candidateSha'
  AND p_evidence->>'testedHeadSha'=e->>'candidateSha' AND p_evidence->>'reviewedHeadSha'=e->>'candidateSha'
  AND p_evidence->>'sourceTreeSha'=e->>'sourceTreeSha'
  AND p_evidence->'reviewSettlement'->>'receiptId'=p_receipt::text
  AND p_evidence->'reviewSettlement'->>'authorizationId'=e->>'authorizationId'
  AND p_evidence->'reviewSettlement'->>'scopeHash'=e->>'scopeHash'
  AND p_evidence->'reviewSettlement'->>'contractHash'=e->>'contractHash'
  AND jsonb_array_length(p_evidence->'changedFiles') BETWEEN 1 AND 100
  AND jsonb_array_length(paths)>0 AND jsonb_array_length(delta_paths)>0
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence->'changedFiles') f
   WHERE f->>'path' IS NULL OR f->>'path' ~ '(^/|(^|/)\.\.(/|$)|[\\])'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(paths) a(path)
    WHERE f->>'path'=a.path OR right(a.path,1)='/' AND starts_with(f->>'path',a.path)))
  AND p_evidence->'packageDelta'->>'baseSha'=e->'binding'->>'baseSha'
  AND p_evidence->'packageDelta'->>'headSha'=e->>'candidateSha'
  AND jsonb_array_length(p_evidence->'packageDelta'->'changedFiles') BETWEEN 1 AND 100
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence->'packageDelta'->'changedFiles') f
   WHERE f->>'path' IS NULL OR f->>'path' ~ '(^/|(^|/)\.\.(/|$)|[\\])'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(delta_paths) a(path)
    WHERE f->>'path'=a.path OR right(a.path,1)='/' AND starts_with(f->>'path',a.path)))
  AND v->>'headSha'=e->>'candidateSha' AND v->>'provider'='vercel' AND v->>'immutable'='true'
  AND v->>'deploymentId' ~ '^[1-9][0-9]*$' AND v->>'statusId' ~ '^[1-9][0-9]*$'
  AND v->>'url' ~ '^https://[a-z0-9-]+-[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app/'
  AND v->>'url' !~ '[?#]' AND split_part(v->>'url','.vercel.app',2)=e->'binding'->'contract'->>'path'
  AND p_browser->>'version'='1' AND p_browser->>'passed'='true'
  AND p_browser->>'projectId'=p.id::text AND p_browser->>'contractHash'=e->>'contractHash'
  AND p_browser->>'headSha'=e->>'candidateSha'
  AND p_browser->>'deploymentId'=v->>'deploymentId' AND p_browser->>'statusId'=v->>'statusId'
  AND p_browser->>'url'=v->>'url'
  AND (p_browser->>'checkedAt')::timestamptz BETWEEN stamp-interval '10 minutes' AND stamp+interval '1 minute'
  AND jsonb_array_length(p_browser->'checks')=jsonb_array_length(e->'binding'->'contract'->'scenarios')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_browser->'checks') WITH ORDINALITY x(value,n)
   WHERE x.value->>'passed' IS DISTINCT FROM 'true'
   OR x.value->>'name' IS DISTINCT FROM e->'binding'->'contract'->'scenarios'->(x.n::int-1)->>'name')
  AND p_evidence->'projectAcceptance'=jsonb_build_object('version',p_browser->'version',
   'projectId',p_browser->'projectId','contractHash',p_browser->'contractHash',
   'headSha',p_browser->'headSha','passed',p_browser->'passed','checks',p_browser->'checks')
 ),false) THEN RAISE EXCEPTION 'Live nonbillable authority and exact source/deployed-browser acceptance required'; END IF;
 result:=jsonb_build_object('consumed',true,'receiptId',p_receipt,'assignmentId',p_task,
  'organizationAcceptancePending',true,'additionalPaidInference',0);
 INSERT INTO public.project_events(project_id,event,data) VALUES(p.id,'development_review_settlement_consumed',
  jsonb_build_object('receiptId',p_receipt,'assignmentId',p_task,'missionId',m.id,
   'authorizationId',c.authorization_id,'releaseSha',p_release,'releaseGeneration',p_generation,'deploymentId',p_deployment,
   'priorAssignment',to_jsonb(j),'workflowReceipt',e->'workflowReceipt',
   'verification',p_evidence,'browserAcceptance',p_browser,'result',result));
 UPDATE public.mission_assignments SET status='completed',result=jsonb_build_object(
  'output','Retained independent technical review and immutable deployed browser contract verified. Organizational acceptance remains pending.',
  'external',t.external,'verification',p_evidence),
  detail='Technical evidence accepted without another provider call; organizational acceptance remains pending.',updated_at=stamp
 WHERE id=p_task;
 -- Do not queue composition, review or management work here. Those stages
 -- need their genuine independent decisions and any applicable paid authority.
 UPDATE public.work_projects SET detail='Retained implementation and deployed browser contract verified. Independent organizational acceptance remains pending.',updated_at=stamp WHERE id=p.id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.project_consume_development_review_settlement(uuid,uuid,text,bigint,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_consume_development_review_settlement(uuid,uuid,text,bigint,text,jsonb,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.project_review_settlement_consumption_guard() FROM PUBLIC,anon,authenticated,service_role;

-- A single package that is the entire approved final contract does not need
-- invented component decisions. Consume real independent technical/browser
-- evidence, then retain the existing genuine whole-project assessment.
-- This private helper is reachable only through the authenticated consumer.
CREATE FUNCTION public.project_advance_consumed_single_package(
 p_task uuid,p_release text,p_generation bigint,p_deployment text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 e jsonb; consumed jsonb; summary text; lease_id uuid; outcome jsonb;
 p work_projects; m agent_missions; j mission_assignments; w project_work_packages;
 c project_package_checkpoint_continuations;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 e:=project_development_review_settlement(p_task);
 SELECT * INTO STRICT p FROM work_projects WHERE id=(e->>'projectId')::uuid FOR UPDATE;
 SELECT * INTO STRICT c FROM project_package_checkpoint_continuations WHERE project_id=p.id;
 SELECT * INTO STRICT m FROM agent_missions WHERE id=c.mission_id FOR UPDATE;
 SELECT * INTO STRICT j FROM mission_assignments WHERE id=p_task FOR UPDATE;
 SELECT * INTO STRICT w FROM project_work_packages WHERE id=c.package_id FOR UPDATE;
 SELECT data INTO STRICT consumed FROM project_events WHERE project_id=p.id
  AND event='development_review_settlement_consumed' AND data->>'receiptId'=e->>'receiptId';
 -- Idempotence does not renew authority or reset work after progression.
 IF EXISTS(SELECT 1 FROM project_events WHERE project_id=p.id
  AND event='single_package_development_completed' AND data->>'receiptId'=e->>'receiptId') THEN RETURN; END IF;
 -- Other projects keep their ordinary management path, without side effects.
 IF p.organization_version<>1 OR jsonb_array_length(p.spec->'milestones')<>1
  OR (SELECT count(*) FROM project_work_packages WHERE project_id=p.id)<>1
  OR p.spec->'milestones'->0->'contract' IS DISTINCT FROM p.spec->'finalContract'
  OR w.contract->'milestone'->'contract' IS DISTINCT FROM p.spec->'finalContract'
 THEN RETURN; END IF;
 IF NOT COALESCE((
  project_org_package_nonbillable_release_live(p.id,p_release,p_generation,p_deployment)
  AND p.status='blocked' AND p.phase='development' AND p.active_mission_id=m.id
  AND p.lease IS NULL AND p.lease_until IS NULL AND p.deadline=c.cutoff AND c.cutoff>now()
  AND p.approved_hash=p.approval_hash AND p.approved_hash=w.scope_hash
  AND p.verified_sha IS NULL AND p.preview IS NULL AND p.milestone_index=0
  AND w.status='running' AND m.status='blocked' AND m.project_kind='development'
  AND j.id=c.assignment_id AND j.mission_id=m.id AND j.role='development' AND j.status='completed'
  AND consumed->>'assignmentId'=j.id::text AND consumed->>'missionId'=m.id::text
  AND consumed->>'authorizationId'=c.authorization_id::text
  AND j.result->'verification'=consumed->'verification'
  AND consumed#>>'{verification,observedHeadSha}'=e->>'candidateSha'
  AND consumed#>>'{verification,testedHeadSha}'=e->>'candidateSha'
  AND consumed#>>'{verification,reviewedHeadSha}'=e->>'candidateSha'
  AND consumed#>>'{browserAcceptance,headSha}'=e->>'candidateSha'
  AND consumed#>>'{browserAcceptance,contractHash}'=e->>'contractHash'
  AND consumed#>>'{browserAcceptance,passed}'='true'
  AND NOT project_provider_request_pending(p.id)
  AND (SELECT count(*) FROM mission_assignments WHERE mission_id=m.id)=4
  AND (SELECT count(*) FROM mission_assignments WHERE mission_id=m.id AND role='plan' AND status='completed')=1
  AND (SELECT count(*) FROM mission_assignments WHERE mission_id=m.id AND role IN('compose','review')
   AND status='queued' AND attempts=0 AND result IS NULL AND lease IS NULL AND lease_until IS NULL)=2
  AND NOT EXISTS(SELECT 1 FROM mission_assignments a JOIN agent_missions mm ON mm.id=a.mission_id
   WHERE mm.project_id=p.id AND (a.lease IS NOT NULL OR a.lease_until IS NOT NULL))
  AND NOT EXISTS(SELECT 1 FROM mission_calls x JOIN mission_assignments a ON a.id=x.job_id
   WHERE a.mission_id=m.id AND a.role IN('compose','review'))
  AND EXISTS(SELECT 1 FROM project_work_package_attempts a WHERE a.package_id=w.id AND a.mission_id=m.id)
 ),false) THEN RAISE EXCEPTION 'Exact consumed single-package evidence and live nonbillable authority required'; END IF;
 summary:=jsonb_build_object('source','server-owned consumed independent technical review',
  'head',e->>'candidateSha','taskId',j.id,'receiptId',e->>'receiptId',
  'changedFiles',consumed#>'{verification,changedFiles}',
  'technicalReview',e#>>'{qualification,findings}',
  'browserScenariosPassed',jsonb_array_length(consumed#>'{browserAcceptance,checks}'),
  'wholeProjectAssessment','pending')::text;
 INSERT INTO project_events(project_id,event,data) VALUES(p.id,'single_package_development_completed',
  jsonb_build_object('receiptId',e->>'receiptId','authorizationId',c.authorization_id,
   'packageId',w.id,'missionId',m.id,'assignmentId',j.id,'head',e->>'candidateSha',
   'source','consumed-independent-native-review-and-deployed-browser',
   'priorMission',to_jsonb(m),'priorPackage',to_jsonb(w),
   'supersededAssignments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.role) FROM mission_assignments a
    WHERE a.mission_id=m.id AND a.role IN('compose','review')),
   'summary',summary,'additionalPaidInference',0));
 UPDATE mission_assignments SET status='stopped',
  detail='Superseded without execution: existing independent native technical review and deployed browser evidence consumed; final whole-project assessment remains required.',
  updated_at=now() WHERE mission_id=m.id AND role IN('compose','review');
 UPDATE agent_missions SET status='completed',result=summary,
  detail='Server-owned technical completion from consumed independent review; no queued agent output was fabricated.',updated_at=now() WHERE id=m.id;
 UPDATE project_work_packages SET status='accepted',evidence=jsonb_build_object(
  'source','consumed-independent-native-review-and-deployed-browser','head',e->>'candidateSha',
  'assignmentId',j.id,'result',j.result,'receiptId',e->>'receiptId','authorizationId',c.authorization_id)
 WHERE id=w.id;
 lease_id:=gen_random_uuid();
 UPDATE work_projects SET status='running',lease=lease_id,lease_until=now()+interval '1 minute' WHERE id=p.id;
 outcome:=jsonb_build_object('head',e->>'candidateSha','taskId',j.id,'verification',j.result->'verification',
  'summary',summary,'consumedSinglePackageRuntime',jsonb_build_object('release',p_release,'generation',p_generation,'deployment',p_deployment));
 IF NOT finish_work_project_lifecycle(p.id,lease_id,'advance',outcome) THEN RAISE EXCEPTION 'Consumed development progression failed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM work_projects WHERE id=p.id AND status='running' AND phase='delivery'
  AND verified_sha=e->>'candidateSha' AND active_mission_id IS NULL AND lease IS NULL AND lease_until IS NULL)
 THEN RAISE EXCEPTION 'Consumed development progression did not clear its lease'; END IF;
 -- This exact full-finalContract browser run was performed by the consumer.
 -- Reuse its immutable result; do not claim another browser run occurred.
 UPDATE work_projects SET preview=(consumed#>'{verification,preview}')||jsonb_build_object('browserAcceptance',consumed->'browserAcceptance'),
  phase='assessment',detail='Full approved source and deployed browser contract verified. Authorized independent whole-project assessment remains pending.',updated_at=now()
 WHERE id=p.id;
 PERFORM project_publish(p.id,'Full approved source and deployed browser contract verified. Independent whole-project assessment remains pending.');
END $$;
REVOKE ALL ON FUNCTION public.project_advance_consumed_single_package(uuid,text,bigint,text) FROM PUBLIC,anon,authenticated,service_role;

-- Keep the actual lifecycle implementation and all its gates. The sole added
-- authority alternative is a nonbillable advance of the completed consumed job.
DO $patch$
DECLARE src text; old text; replacement text;
BEGIN
 src:=pg_get_functiondef('public.project_development_review_settlement(uuid)'::regprocedure);
 old:='q jsonb; cp jsonb; requests jsonb; count_settlements integer;';
 IF strpos(src,old)=0 THEN RAISE EXCEPTION 'Retained review read declaration changed'; END IF;
 src:=replace(src,old,old||' consumed jsonb;');
 old:='RETURN jsonb_build_object(''version'',1,''receiptId'',s.receipt_id';
 IF strpos(src,old)=0 THEN RAISE EXCEPTION 'Retained review read result changed'; END IF;
 src:=replace(src,old,$read$SELECT data INTO consumed FROM project_events WHERE project_id=p.id
  AND event='development_review_settlement_consumed' AND data->>'receiptId'=s.receipt_id::text
  AND data->>'assignmentId'=j.id::text;
 IF consumed IS NOT NULL AND (j.status IS DISTINCT FROM 'completed'
  OR j.result->'verification' IS DISTINCT FROM consumed->'verification')
 THEN RAISE EXCEPTION 'Consumed retained review no longer matches its assignment'; END IF;
 RETURN jsonb_build_object('version',1,'receiptId',s.receipt_id$read$);
 old:='''recordedAt'',s.recorded_at,''cutoff'',c.cutoff);';
 IF strpos(src,old)=0 THEN RAISE EXCEPTION 'Retained review read checkpoint changed'; END IF;
 EXECUTE replace(src,old,$read$'recordedAt',s.recorded_at,'cutoff',c.cutoff)
  || CASE WHEN consumed IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('consumed',
   jsonb_build_object('verification',consumed->'verification','browserAcceptance',consumed->'browserAcceptance')) END;$read$);
 src:=pg_get_functiondef('public.finish_work_project_lifecycle(uuid,uuid,text,jsonb)'::regprocedure);
 old:='if p_action in(''child'',''advance'',''preview'',''browser'',''complete'') and not project_org_package_checkpoint_live(p.id) then raise exception ''Live checkpoint authority required'';end if;';
 replacement:=$new$if p_action in('child','advance','preview','browser','complete') and not project_org_package_checkpoint_live(p.id)
  and not (p_action='advance' and p.phase='development'
   and exists(select 1 from project_events e where e.project_id=p.id and e.event='single_package_development_completed'
    and e.data->>'missionId'=p.active_mission_id::text and e.data->>'head'=p_data->>'head'
    and e.data->>'assignmentId'=p_data->>'taskId')
   and project_org_package_nonbillable_release_live(p.id,p_data#>>'{consumedSinglePackageRuntime,release}',
    (p_data#>>'{consumedSinglePackageRuntime,generation}')::bigint,p_data#>>'{consumedSinglePackageRuntime,deployment}'))
  then raise exception 'Live checkpoint authority required';end if;$new$;
 IF strpos(src,old)=0 THEN RAISE EXCEPTION 'Checkpoint lifecycle authority anchor changed'; END IF;
 EXECUTE replace(src,old,replacement);
 src:=pg_get_functiondef('public.project_consume_development_review_settlement(uuid,uuid,text,bigint,text,jsonb,jsonb)'::regprocedure);
 old:='RETURN prior->''result'';';
 IF strpos(src,old)=0 THEN RAISE EXCEPTION 'Consumed settlement replay anchor changed'; END IF;
 src:=replace(src,old,'PERFORM project_advance_consumed_single_package(p_task,p_release,p_generation,p_deployment); RETURN prior->''result'';');
 old:='RETURN result;';
 IF strpos(src,old)=0 THEN RAISE EXCEPTION 'Consumed settlement completion anchor changed'; END IF;
 EXECUTE replace(src,old,'PERFORM project_advance_consumed_single_package(p_task,p_release,p_generation,p_deployment); RETURN result;');
END $patch$;

-- The ordinary source-bound completion trigger still requires the original
-- objective, approved final contract, immutable preview and all six real checks.
CREATE OR REPLACE FUNCTION public.project_org_closure_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE w project_work_packages; c project_package_checkpoint_continuations;
 m agent_missions; composer mission_assignments; reviewer mission_assignments; e jsonb; direct_event jsonb;
 composed project_package_paid_responses; reviewed project_package_paid_responses;
 compose_body jsonb; review_body jsonb;
BEGIN
 IF new.organization_version=1 AND new.status='completed' AND old.status IS DISTINCT FROM 'completed' THEN
  SELECT * INTO c FROM project_package_checkpoint_continuations WHERE project_id=new.id;
  SELECT * INTO w FROM project_work_packages WHERE id=c.package_id;
  SELECT data INTO direct_event FROM project_events WHERE project_id=new.id AND event='single_package_development_completed'
   AND data->>'assignmentId'=c.assignment_id::text AND data->>'head'=new.verified_sha;
  IF direct_event IS NOT NULL THEN
   e:=project_development_review_settlement(c.assignment_id);
   SELECT * INTO m FROM agent_missions WHERE id=new.active_mission_id;
   SELECT * INTO composer FROM mission_assignments WHERE mission_id=m.id AND role='compose';
   SELECT * INTO reviewer FROM mission_assignments WHERE mission_id=m.id AND role='review';
   SELECT * INTO composed FROM project_package_paid_responses WHERE request_id=project_org_package_durable_response_id(composer.id);
   SELECT * INTO reviewed FROM project_package_paid_responses WHERE request_id=project_org_package_durable_response_id(reviewer.id);
   BEGIN
    compose_body:=regexp_replace(regexp_replace(btrim(composed.response->>'text'),'^\x60\x60\x60(json)?[[:space:]]*',''),'[[:space:]]*\x60\x60\x60$','')::jsonb;
    review_body:=regexp_replace(regexp_replace(btrim(reviewed.response->>'text'),'^\x60\x60\x60(json)?[[:space:]]*',''),'[[:space:]]*\x60\x60\x60$','')::jsonb;
   EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Durable final assessment response is not valid JSON'; END;
   IF NOT COALESCE((
    jsonb_array_length(new.spec->'milestones')=1 AND (SELECT count(*) FROM project_work_packages WHERE project_id=new.id)=1
    AND new.spec->'milestones'->0->'contract'=new.spec->'finalContract'
    AND w.contract->'milestone'->'contract'=new.spec->'finalContract'
    AND w.status='accepted' AND w.scope_hash=new.approved_hash AND w.evidence->>'receiptId'=e->>'receiptId'
    AND w.evidence->>'source'='consumed-independent-native-review-and-deployed-browser'
    AND new.verified_sha=e->>'candidateSha' AND c.cutoff=new.deadline AND c.cutoff>now()
    AND m.project_id=new.id AND m.project_kind='assessment' AND m.status='completed'
    AND m.project_evidence->>'checkpointRecoveryAuthorizationId'=c.authorization_id::text
    AND m.created_at>=c.authorized_at
    AND (SELECT count(*) FROM agent_missions WHERE project_id=new.id AND project_kind='assessment' AND created_at>=c.authorized_at)=1
    AND composer.status='completed' AND reviewer.status='completed' AND composer.attempts=1 AND reviewer.attempts=1
    AND composed.response->>'status'='completed' AND reviewed.response->>'status'='completed'
    AND jsonb_typeof(compose_body)='object' AND (SELECT count(*) FROM jsonb_object_keys(compose_body))=2
    AND jsonb_typeof(compose_body->'deliverable')='string' AND jsonb_typeof(compose_body->'composerNotes')='string'
    AND length(compose_body->>'deliverable')>0 AND composer.result->>'text'=compose_body->>'deliverable'
    AND composer.result->>'composerNotes'=compose_body->>'composerNotes' AND m.result=composer.result->>'text'
    AND composer.result->>'model'=composed.response->>'model' AND reviewer.result->>'model'=reviewed.response->>'model'
    -- Match the existing validator: a revise verdict with all six checks true
    -- is optional advice, while an essential clarification remains blocking.
    AND review_body->>'verdict' IN('approve','revise') AND jsonb_typeof(review_body->'findings')='string'
    AND length(btrim(review_body->>'findings'))>0
    AND (NOT review_body ? 'clarification' OR review_body->'clarification'='null'::jsonb
     OR jsonb_typeof(review_body->'clarification')='object'
      AND jsonb_typeof(review_body#>'{clarification,question}')='string'
      AND length(btrim(review_body#>>'{clarification,question}'))>0
      AND jsonb_typeof(review_body#>'{clarification,missingFact}')='string'
      AND length(btrim(review_body#>>'{clarification,missingFact}'))>0
      AND review_body#>'{clarification,essential}'='false'::jsonb)
    AND review_body->'checks'=reviewer.result->'checks'
    AND composer.agent_id=(SELECT agent_id FROM project_organization_nodes WHERE id=w.writer_id)
    AND reviewer.agent_id=(SELECT agent_id FROM project_organization_nodes WHERE id=w.reviewer_id)
    AND reviewer.agent_id<>composer.agent_id
    AND reviewer.agent_id<>(SELECT agent_id FROM project_organization_nodes WHERE id=w.worker_id)
    AND reviewer.result->>'verdict'='pass' AND jsonb_array_length(reviewer.result->'checks')=6
    AND (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(reviewer.result->'checks') x)=6
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(reviewer.result->'checks') x WHERE x->'passed' IS DISTINCT FROM 'true'::jsonb
     OR x->>'id' NOT IN('requirement:assigned-outcome','criterion:1','criterion:2','overall-objective','factual-support','prior-findings')
     OR jsonb_typeof(x->'evidence') IS DISTINCT FROM 'string' OR length(btrim(coalesce(x->>'evidence','')))=0)
    AND composed.project_id=new.id AND reviewed.project_id=new.id AND composed.mission_id=m.id AND reviewed.mission_id=m.id
    AND NOT project_provider_request_pending(new.id)
   ),false) THEN RAISE EXCEPTION 'Actual independent single-package final assessment required'; END IF;
   IF EXISTS(SELECT 1 FROM mission_calls x JOIN mission_assignments j ON j.id=x.job_id JOIN agent_missions mm ON mm.id=j.mission_id WHERE mm.project_id=new.id AND x.status<>'completed')
    OR EXISTS(SELECT 1 FROM benchmark_budget_calls x JOIN benchmark_budget_accounts a ON a.id=x.account_id WHERE a.developer_project_id=new.id AND x.state<>'settled')
   THEN RAISE EXCEPTION 'Closure evidence or financial position changed'; END IF;
   INSERT INTO project_events(project_id,event,data) VALUES(new.id,'single_package_project_accepted',jsonb_build_object(
    'source','actual independent whole-project assessment of consumed source and browser evidence',
    'authorizationId',c.authorization_id,'receiptId',e->>'receiptId','packageId',w.id,
    'developmentMissionId',c.mission_id,'assignmentId',c.assignment_id,'assessmentMissionId',m.id,
    'composeAssignmentId',composer.id,'reviewAssignmentId',reviewer.id,'review',reviewer.result,
    'composeProviderRequestId',composed.request_id,'reviewProviderRequestId',reviewed.request_id,
    'approvedScopeHash',new.approved_hash,'head',new.verified_sha,'finalContract',new.spec->'finalContract',
    'browserAcceptance',new.preview->'browserAcceptance','historicalHierarchyUnchanged',true));
   RETURN new;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM project_organization_closures x JOIN project_organization_nodes n ON n.id=x.director_id
   WHERE x.project_id=new.id AND n.kind='project_director' AND x.scope_hash=new.approved_hash AND x.head_sha=new.verified_sha)
  THEN RAISE EXCEPTION 'Project Director closure authorization required'; END IF;
  IF EXISTS(SELECT 1 FROM project_organization_nodes WHERE project_id=new.id AND parent_id IS NOT NULL AND status<>'accepted')
   OR EXISTS(SELECT 1 FROM project_organization_exceptions WHERE project_id=new.id AND status<>'resolved')
   OR EXISTS(SELECT 1 FROM mission_calls x JOIN mission_assignments j ON j.id=x.job_id JOIN agent_missions mm ON mm.id=j.mission_id WHERE mm.project_id=new.id AND x.status<>'completed')
   OR EXISTS(SELECT 1 FROM benchmark_budget_calls x JOIN benchmark_budget_accounts a ON a.id=x.account_id WHERE a.developer_project_id=new.id AND x.state<>'settled')
  THEN RAISE EXCEPTION 'Closure evidence or financial position changed'; END IF;
 END IF;
 RETURN new;
END $$;

CREATE OR REPLACE FUNCTION public.project_review_settlement_consumption_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE protected_events text[]:=array['development_review_settlement_consumed','single_package_development_completed','single_package_project_accepted'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.event=ANY(protected_events) AND current_user<>'postgres' THEN
   RAISE EXCEPTION 'Retained review consumption requires its authenticated definer';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.event=ANY(protected_events) OR (TG_OP='UPDATE' AND NEW.event=ANY(protected_events))
 THEN RAISE EXCEPTION 'Retained review consumption history is append-only'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

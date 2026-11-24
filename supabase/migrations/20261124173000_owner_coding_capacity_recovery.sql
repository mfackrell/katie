-- One owner-selected, source-bound commissioning window for the exhausted
-- original project. No data mutation, new capacity or inference on install.
BEGIN;
CREATE TABLE public.project_coding_capacity_receipts(
 project_id uuid PRIMARY KEY REFERENCES public.work_projects(id),
 authorization_id uuid NOT NULL UNIQUE,
 owner_id uuid NOT NULL,
 release_sha text NOT NULL CHECK(release_sha ~ '^[a-f0-9]{40}$'),
 release_generation bigint NOT NULL CHECK(release_generation>0),
 deployment_id text NOT NULL CHECK(deployment_id ~ '^dpl_[A-Za-z0-9]+$'),
 scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 scope_paths text[] NOT NULL,
 objective_hash text NOT NULL,
 spec_hash text NOT NULL,
 cutoff timestamptz NOT NULL,
 historical_missions integer NOT NULL CHECK(historical_missions=96),
 historical_mission_ids uuid[] NOT NULL CHECK(cardinality(historical_mission_ids)=96),
 original_node_ids uuid[] NOT NULL CHECK(cardinality(original_node_ids)=13),
 director_id uuid NOT NULL,
 manager_id uuid NOT NULL,
 prior_max_missions integer NOT NULL CHECK(prior_max_missions=96),
 additional_missions integer NOT NULL CHECK(additional_missions BETWEEN 1 AND 8),
 approved_max_missions integer NOT NULL CHECK(approved_max_missions=96+additional_missions),
 paid_inference_limit integer NOT NULL CHECK(paid_inference_limit=additional_missions),
 retry_limit integer NOT NULL CHECK(retry_limit=0),
 token_allowance integer NOT NULL CHECK(token_allowance=600000),
 recorded_tokens bigint NOT NULL CHECK(recorded_tokens BETWEEN 0 AND token_allowance),
 historical_provider_requests integer NOT NULL,
 state_hash text NOT NULL CHECK(state_hash ~ '^[a-f0-9]{64}$'),
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.project_coding_capacity_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_coding_capacity_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER project_coding_capacity_receipt_immutable BEFORE UPDATE OR DELETE ON public.project_coding_capacity_receipts
 FOR EACH ROW EXECUTE FUNCTION public.project_org_change_immutable();

-- Bind owner consent to the real durable pre-approval state, not counts alone.
CREATE FUNCTION public.project_org_coding_capacity_state(p_project uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT encode(sha256(convert_to(project_canonical(jsonb_build_object(
  'project',(SELECT to_jsonb(p) FROM work_projects p WHERE p.id=p_project),
  'gate',(SELECT to_jsonb(g) FROM project_retest_production_release_gate g WHERE g.project_id=p_project),
  'provider',(SELECT to_jsonb(a) FROM project_provider_execution a WHERE a.project_id=p_project),
  'missions',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM agent_missions m WHERE m.project_id=p_project),
  'assignments',(SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM mission_assignments j JOIN agent_missions m ON m.id=j.mission_id WHERE m.project_id=p_project),
  'nodes',(SELECT jsonb_agg(to_jsonb(n) ORDER BY n.id) FROM project_organization_nodes n WHERE n.project_id=p_project),
  'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.node_id,g.scope_hash) FROM project_organization_scope_grants g JOIN project_organization_nodes n ON n.id=g.node_id WHERE n.project_id=p_project),
  'decisions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM project_organization_decisions d WHERE d.project_id=p_project),
  'exceptions',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM project_organization_exceptions e WHERE e.project_id=p_project),
  'providerRequests',(SELECT jsonb_agg(to_jsonb(q) ORDER BY q.id) FROM project_provider_requests q WHERE q.project_id=p_project),
  'followup',(SELECT to_jsonb(f) FROM project_followup_context_retest_receipts f WHERE f.project_id=p_project),
  'packages',(SELECT count(*) FROM project_work_packages w WHERE w.project_id=p_project)
 )),'UTF8')),'hex')
$$;

CREATE FUNCTION public.project_org_coding_capacity_offer(p_owner uuid,p_project uuid,p_release text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p work_projects; a project_provider_execution; g project_retest_production_release_gate;
 r project_coding_capacity_receipts; d project_organization_nodes; n project_organization_nodes;
 consumed integer; spent bigint; providers integer; paid integer;
BEGIN
 SELECT * INTO p FROM work_projects WHERE id=p_project;
 SELECT * INTO a FROM project_provider_execution WHERE project_id=p_project;
 SELECT * INTO g FROM project_retest_production_release_gate WHERE project_id=p_project;
 IF p.id IS DISTINCT FROM 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
 OR p_owner IS NULL OR a.owner_id IS DISTINCT FROM p_owner OR NOT standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 OR g.state IS DISTINCT FROM 'active' OR g.alias_name IS DISTINCT FROM 'katie-mu.vercel.app'
 OR g.release_sha IS DISTINCT FROM p_release THEN RAISE EXCEPTION 'Authenticated original owner and active release required'; END IF;
 SELECT count(*),coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0)
 INTO consumed,spent FROM agent_missions WHERE project_id=p.id;
 SELECT count(*),count(*) FILTER(WHERE operation='inference') INTO providers,paid FROM project_provider_requests WHERE project_id=p.id;
 SELECT * INTO r FROM project_coding_capacity_receipts WHERE project_id=p.id;
 IF r.project_id IS NOT NULL THEN
  RETURN jsonb_build_object('stage','authorized','projectId',p.id,'authorizationId',r.authorization_id,'authorizedAt',r.authorized_at,
   'releaseSha',r.release_sha,'releaseGeneration',r.release_generation,'deploymentId',r.deployment_id,'scopeHash',r.scope_hash,
   'paths',r.scope_paths,'cutoff',r.cutoff,'historicalMissions',96,'priorMaxMissions',96,'additionalMissions',r.additional_missions,
   'maxMissions',r.approved_max_missions,'remainingMissions',greatest(0,r.approved_max_missions-consumed),'paidInferenceLimit',r.paid_inference_limit,
   'retryLimit',0,'tokenAllowance',r.token_allowance,'recordedTokens',r.recorded_tokens,'remainingRecordedTokens',r.token_allowance-r.recorded_tokens,
   'nodeCount',13,'directorId',r.director_id,'managerId',r.manager_id,'stateHash',r.state_hash,'status',p.status,
   'providerRequestsAtApproval',r.historical_provider_requests,'providerRequestsNow',providers,
   'packageId',(SELECT id FROM project_work_packages WHERE project_id=p.id AND milestone_index=0));
 END IF;
 SELECT * INTO d FROM project_organization_nodes WHERE project_id=p.id AND area='game_delivery' AND management_level='functional_director' AND status='active';
 SELECT * INTO n FROM project_organization_nodes WHERE project_id=p.id AND area='delivery_management' AND management_level='manager' AND parent_id=d.id AND status='active';
 IF p.status<>'blocked' OR p.detail IS DISTINCT FROM 'Approved project mission limit reached' OR p.phase<>'development'
 OR p.organization_version<>1 OR p.milestone_index<>0 OR p.max_missions<>96 OR consumed<>96 OR p.token_allowance<>600000
 OR p.active_mission_id IS NOT NULL OR p.lease IS NOT NULL OR p.lease_until IS NOT NULL
 OR p.deadline<=clock_timestamp()+interval '5 minutes' OR p.deadline IS DISTINCT FROM a.deadline
 OR p.approved_hash IS DISTINCT FROM p.approval_hash OR p.approved_hash IS DISTINCT FROM a.approved_scope
 OR spent>=p.token_allowance OR NOT project_provider_mode(p.id)
 OR NOT project_provider_continued(p.id) OR NOT project_org_bounded_recovery_window_valid(p.id)
 OR NOT project_org_retest_original_owner_lineage(p.id)
 OR NOT project_org_retest_exact_scope_grants(p.id)
 OR (SELECT count(*) FROM project_organization_nodes WHERE project_id=p.id)<>13
 OR d.id IS NULL OR n.id IS NULL OR NOT d.decision_needed OR n.decision_needed
 OR NOT 'development'=ANY(d.tools) OR NOT 'development'=ANY(n.tools)
 OR NOT project_org_dependencies_ready(d.id) OR NOT project_org_dependencies_ready(n.id)
 OR EXISTS(SELECT 1 FROM project_organization_nodes x WHERE x.project_id=p.id AND x.kind='worker' AND 'development'=ANY(x.tools))
 OR EXISTS(SELECT 1 FROM project_work_packages WHERE project_id=p.id)
 OR EXISTS(SELECT 1 FROM agent_missions m WHERE m.project_id=p.id AND m.status NOT IN ('completed','blocked','stopped','failed'))
 OR EXISTS(SELECT 1 FROM mission_assignments j JOIN agent_missions m ON m.id=j.mission_id WHERE m.project_id=p.id AND (j.lease IS NOT NULL OR j.lease_until IS NOT NULL OR j.status NOT IN ('completed','failed','blocked','stopped','cancelled','canceled')))
 OR project_provider_request_pending(p.id)
 OR NOT EXISTS(SELECT 1 FROM project_followup_context_retest_receipts f JOIN agent_missions m ON m.id=f.source_mission_id AND m.project_id=p.id
    JOIN mission_assignments j ON j.id=f.source_assignment_id AND j.mission_id=m.id
    JOIN project_organization_decisions md ON md.assignment_id=j.id AND md.project_id=p.id AND md.id::text=j.result->>'decisionId'
    WHERE f.project_id=p.id AND f.owner_id=p_owner AND f.historical_missions=95 AND f.cutoff=p.deadline AND f.scope_hash=p.approved_hash
     AND m.status='completed' AND m.calls=1 AND j.status='completed' AND j.attempts=2)
 THEN RAISE EXCEPTION 'Exhausted original project or commissioning prerequisites changed'; END IF;
 RETURN jsonb_build_object('stage','authorize','projectId',p.id,'authorizationId',null,'releaseSha',g.release_sha,
  'releaseGeneration',g.generation,'deploymentId',g.deployment_id,'scopeHash',p.approved_hash,'paths',p.spec->'allowedPaths',
  'cutoff',p.deadline,'historicalMissions',96,'priorMaxMissions',96,'remainingMissions',0,
  'minAdditionalMissions',1,'recommendedAdditionalMissions',4,'maxAdditionalMissions',8,'retryLimit',0,
  'tokenAllowance',p.token_allowance,'recordedTokens',spent,'remainingRecordedTokens',p.token_allowance-spent,'nodeCount',13,
  'providerRequestsAtApproval',providers,'historicalInferenceRequests',paid,'directorId',d.id,'managerId',n.id,
  'stateHash',project_org_coding_capacity_state(p.id),'status',p.status);
END
$$;

-- Existing resource writer is reused inside the same locked transaction;
-- the receipt and watchdog transition are committed together or not at all.
CREATE FUNCTION public.project_org_coding_capacity_authorize(
 p_owner uuid,p_project uuid,p_release text,p_generation bigint,p_deployment text,
 p_authorization uuid,p_state_hash text,p_scope text,p_cutoff timestamptz,
 p_additional integer,p_max integer,p_paid_limit integer,p_retry_limit integer,p_tokens integer,p_remaining bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o jsonb; p work_projects; stamp timestamptz; r project_coding_capacity_receipts;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 SELECT * INTO p FROM work_projects WHERE id=p_project FOR UPDATE;
 PERFORM 1 FROM project_retest_production_release_gate WHERE project_id=p_project FOR UPDATE;
 PERFORM 1 FROM project_organization_nodes WHERE project_id=p_project ORDER BY id FOR UPDATE;
 o:=project_org_coding_capacity_offer(p_owner,p_project,p_release);
 IF o->>'stage' IS DISTINCT FROM 'authorize' OR p_authorization IS NULL OR p_state_hash IS DISTINCT FROM o->>'stateHash'
 OR p_scope IS DISTINCT FROM o->>'scopeHash' OR p_cutoff IS DISTINCT FROM (o->>'cutoff')::timestamptz
 OR p_generation IS DISTINCT FROM (o->>'releaseGeneration')::bigint OR p_deployment IS DISTINCT FROM o->>'deploymentId'
 OR p_additional IS NULL OR p_additional NOT BETWEEN 1 AND 8 OR p_max IS DISTINCT FROM 96+p_additional
 OR p_paid_limit IS DISTINCT FROM p_additional OR p_retry_limit IS DISTINCT FROM 0 OR p_tokens IS DISTINCT FROM 600000
 OR p_remaining IS DISTINCT FROM (o->>'remainingRecordedTokens')::bigint
 THEN RAISE EXCEPTION 'Exact selected capacity and paid-inference consent required; stale or duplicate approval'; END IF;
 stamp:=clock_timestamp();
 INSERT INTO project_coding_capacity_receipts(project_id,authorization_id,owner_id,release_sha,release_generation,deployment_id,
  scope_hash,scope_paths,objective_hash,spec_hash,cutoff,historical_missions,historical_mission_ids,original_node_ids,director_id,manager_id,
  prior_max_missions,additional_missions,approved_max_missions,paid_inference_limit,retry_limit,token_allowance,recorded_tokens,historical_provider_requests,state_hash,authorized_at)
 VALUES(p.id,p_authorization,p_owner,p_release,p_generation,p_deployment,p_scope,ARRAY(SELECT jsonb_array_elements_text(o->'paths')),
  encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex'),encode(sha256(convert_to(project_canonical(p.spec),'UTF8')),'hex'),
  p_cutoff,96,ARRAY(SELECT id FROM agent_missions WHERE project_id=p.id ORDER BY id),ARRAY(SELECT id FROM project_organization_nodes WHERE project_id=p.id ORDER BY id),
  (o->>'directorId')::uuid,(o->>'managerId')::uuid,96,p_additional,p_max,p_paid_limit,0,p_tokens,(o->>'recordedTokens')::bigint,(o->>'providerRequestsAtApproval')::integer,p_state_hash,stamp)
 RETURNING * INTO r;
 PERFORM authorize_work_project_resources(p.id,p.actor_id,p.chat_id,p_tokens,NULL,p_max,NULL,p_authorization,
  'Authenticated owner commissioning-only approval: '||p_release||' '||p_scope||'; one paid inference per new mission, zero retries; no token, deadline or scope increase.');
 UPDATE work_projects SET status='running',detail='Owner-authorized coding commissioning; awaiting normal scheduler',
  progress_since=stamp,progress_signature=NULL,error_signature=NULL,repeated_errors=0,impediment=NULL,updated_at=stamp
 WHERE id=p.id AND status='blocked' AND active_mission_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Atomic recovery transition failed'; END IF;
 INSERT INTO project_events(project_id,event,data) VALUES(p.id,'coding_capacity_authorized',jsonb_build_object(
  'authorizationId',r.authorization_id,'priorMaxMissions',96,'approvedMaxMissions',r.approved_max_missions,'paidInferenceLimit',r.paid_inference_limit,
  'releaseSha',r.release_sha,'generation',r.release_generation,'deploymentId',r.deployment_id,'cutoff',r.cutoff,'scopeHash',r.scope_hash));
 RETURN project_org_coding_capacity_offer(p_owner,p_project,p_release);
END
$$;

-- Refuse a generic resource API or a repeated approval that would increase
-- this exhausted original project's capacity outside this one receipt.
CREATE FUNCTION public.project_org_coding_capacity_resource_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
 AND ((OLD.max_missions=96 AND OLD.status='blocked' AND OLD.detail='Approved project mission limit reached')
   OR EXISTS(SELECT 1 FROM project_coding_capacity_receipts WHERE project_id=OLD.id))
 AND (NEW.max_missions IS DISTINCT FROM OLD.max_missions OR NEW.token_allowance IS DISTINCT FROM OLD.token_allowance OR NEW.deadline IS DISTINCT FROM OLD.deadline)
 AND NOT (OLD.max_missions=96 AND OLD.status='blocked' AND OLD.detail='Approved project mission limit reached'
  AND NEW.token_allowance=OLD.token_allowance AND NEW.deadline=OLD.deadline
  AND EXISTS(SELECT 1 FROM project_coding_capacity_receipts r WHERE r.project_id=OLD.id AND NEW.max_missions=r.approved_max_missions))
 THEN RAISE EXCEPTION 'Original commissioning resources require the exact one-time owner receipt'; END IF;
 RETURN NEW;
END
$$;
CREATE TRIGGER project_coding_capacity_resource_guard BEFORE UPDATE ON public.work_projects FOR EACH ROW EXECUTE FUNCTION public.project_org_coding_capacity_resource_guard();

-- The old 96-mission receipt remains untouched. New claims are authorized
-- only by this receipt and the canonical release epoch, never by old retries.
CREATE FUNCTION public.project_org_coding_capacity_live(p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM project_coding_capacity_receipts r
  JOIN work_projects p ON p.id=r.project_id
  JOIN project_provider_execution a ON a.project_id=p.id AND a.owner_id=r.owner_id AND a.approved_scope=r.scope_hash AND a.deadline=r.cutoff
  JOIN project_retest_production_release_gate g ON g.project_id=p.id AND g.state='active' AND g.alias_name='katie-mu.vercel.app'
   AND g.release_sha=r.release_sha AND g.generation=r.release_generation AND g.deployment_id=r.deployment_id
  WHERE p.id=p_project AND p.status='running' AND p.phase='development' AND p.milestone_index=0 AND p.organization_version=1
   AND p.deadline=r.cutoff AND p.deadline>clock_timestamp()
   AND p.max_missions=r.approved_max_missions AND p.token_allowance=r.token_allowance
   AND p.approved_hash=r.scope_hash AND p.approval_hash=r.scope_hash
   AND p.spec->'allowedPaths'=to_jsonb(r.scope_paths)
   AND encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')=r.objective_hash
   AND encode(sha256(convert_to(project_canonical(p.spec),'UTF8')),'hex')=r.spec_hash
   AND project_provider_continued(p.id)
   AND (SELECT count(*) FROM agent_missions m WHERE m.project_id=p.id) BETWEEN 96 AND r.approved_max_missions
   AND (SELECT coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0) FROM agent_missions WHERE project_id=p.id)<=r.token_allowance
   AND NOT EXISTS(SELECT 1 FROM project_work_packages WHERE project_id=p.id)
   AND NOT EXISTS(SELECT 1 FROM unnest(r.original_node_ids) id WHERE NOT EXISTS(SELECT 1 FROM project_organization_nodes n WHERE n.id=id AND n.project_id=p.id))
   AND NOT EXISTS(SELECT 1 FROM project_organization_nodes n WHERE n.project_id=p.id AND NOT n.id=ANY(r.original_node_ids)
      AND (n.parent_id IS DISTINCT FROM r.manager_id OR n.kind<>'worker'))
  )
$$;
CREATE FUNCTION public.project_org_coding_capacity_assignment(p_job uuid,p_queued boolean)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM mission_assignments j
  JOIN agent_missions m ON m.id=j.mission_id
  JOIN work_projects p ON p.id=m.project_id AND p.active_mission_id=m.id
  JOIN project_coding_capacity_receipts r ON r.project_id=p.id
  JOIN project_organization_nodes n ON n.project_id=p.id AND n.id::text=m.project_evidence->>'organizationNodeId' AND n.agent_id=j.agent_id
  JOIN project_organization_assignments b ON b.assignment_id=j.id AND b.node_id=n.id
  WHERE j.id=p_job AND m.status='running' AND m.project_kind='management' AND m.deadline=r.cutoff
    AND j.role='work' AND j.job_key='plan' AND n.id IN(r.director_id,r.manager_id) AND n.kind='manager' AND n.status='active'
    AND j.payload->>'organizationNodeId'=n.id::text AND NOT m.id=ANY(r.historical_mission_ids)
    AND m.project_evidence->>'codingCapacityAuthorizationId'=r.authorization_id::text
    AND project_org_coding_capacity_live(p.id) AND project_provider_continued_assignment(j.id)
    AND (SELECT count(*) FROM mission_assignments WHERE mission_id=m.id)=1
    AND b.contract_hash=encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex')
    AND (CASE WHEN p_queued THEN j.status='queued' AND j.attempts=0 AND m.calls=0 AND j.lease IS NULL AND j.lease_until IS NULL
      AND j.available_at<=clock_timestamp() AND NOT project_provider_request_pending(p.id)
      ELSE j.status='running' AND j.attempts=1 AND m.calls<=1 AND j.lease IS NOT NULL AND j.lease_until>clock_timestamp() END))
$$;
CREATE FUNCTION public.project_org_coding_capacity_claim_authorized(p_project uuid,p_release text,p_generation bigint,p_deployment text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM project_coding_capacity_receipts r JOIN work_projects p ON p.id=r.project_id
  JOIN mission_assignments j ON j.mission_id=p.active_mission_id
  WHERE r.project_id=p_project AND r.release_sha=p_release AND r.release_generation=p_generation AND r.deployment_id=p_deployment
  AND project_org_coding_capacity_assignment(j.id,true))
$$;

-- Only owner-authorized management progression through the already delegated
-- two implementation leaders. No edits to old hierarchy, no QA tasks, no
-- automatic same-assignment retries. Preserve the normal scheduler itself.
CREATE FUNCTION public.project_org_coding_capacity_commands(p_job uuid,p_lease uuid,p_commands jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r project_coding_capacity_receipts; n uuid; c jsonb; actions integer;
BEGIN
 SELECT receipt.* INTO r FROM project_coding_capacity_receipts receipt JOIN agent_missions m ON m.project_id=receipt.project_id
 JOIN mission_assignments j ON j.mission_id=m.id WHERE j.id=p_job;
 IF NOT FOUND THEN RETURN; END IF;
 IF NOT project_org_coding_capacity_assignment(p_job,false)
 OR NOT EXISTS(SELECT 1 FROM mission_assignments j JOIN agent_missions m ON m.id=j.mission_id
   JOIN project_provider_requests q ON q.assignment_id=j.id AND q.mission_id=m.id AND q.execution_attempt=p_lease::text
   WHERE j.id=p_job AND j.lease=p_lease AND m.calls=1 AND q.operation='inference' AND q.resolved_at IS NOT NULL AND q.provider_receipt IS NOT NULL)
 OR project_provider_request_pending(r.project_id) OR jsonb_typeof(p_commands) IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'Current bounded commissioning lease and settled inference required'; END IF;
 SELECT (m.project_evidence->>'organizationNodeId')::uuid INTO n FROM agent_missions m JOIN mission_assignments j ON j.mission_id=m.id WHERE j.id=p_job;
 SELECT count(*) INTO actions FROM jsonb_array_elements(p_commands) c WHERE c->>'action' IS DISTINCT FROM 'ready';
 IF actions=0 THEN RAISE EXCEPTION 'Commissioning requires a substantive implementation decision'; END IF;
 IF n=r.director_id THEN
  IF actions<>1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_commands) c WHERE c->>'action' IS DISTINCT FROM 'ready'
    AND (c->>'action' IS DISTINCT FROM 'reject' OR c->>'nodeId' IS DISTINCT FROM r.manager_id::text))
  OR EXISTS(SELECT 1 FROM project_organization_nodes WHERE id=r.manager_id AND decision_needed)
  THEN RAISE EXCEPTION 'Delivery Director must hand off to its existing authorized manager'; END IF;
 ELSIF n=r.manager_id THEN
  FOR c IN SELECT value FROM jsonb_array_elements(p_commands) LOOP
   CASE c->>'action'
    WHEN 'ready' THEN NULL;
    WHEN 'appoint' THEN
     IF c->>'kind' IS DISTINCT FROM 'worker' OR coalesce(c->>'managementLevel','worker')<>'worker'
      OR jsonb_typeof(c->'tools') IS DISTINCT FROM 'array' OR NOT (c->'tools')?'analysis'
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(c->'tools') t WHERE t NOT IN ('analysis','development','repository_review'))
     THEN RAISE EXCEPTION 'Only bounded direct implementation workers may be appointed'; END IF;
    WHEN 'grant_scope' THEN
     IF NOT EXISTS(SELECT 1 FROM project_organization_nodes x WHERE x.id::text=c->>'nodeId' AND x.project_id=r.project_id
        AND x.parent_id=n AND x.kind='worker' AND NOT x.id=ANY(r.original_node_ids))
     THEN RAISE EXCEPTION 'Grant only newly appointed direct workers their approved scope'; END IF;
    WHEN 'commission_package' THEN
     IF c->>'milestoneIndex' IS DISTINCT FROM '0' OR EXISTS(SELECT 1 FROM unnest(ARRAY[c->>'workerId',c->>'writerId',c->>'reviewerId']) wid
        WHERE NOT EXISTS(SELECT 1 FROM project_organization_nodes x WHERE x.id::text=wid AND x.project_id=r.project_id
         AND x.parent_id=n AND x.kind='worker' AND NOT x.id=ANY(r.original_node_ids)))
     THEN RAISE EXCEPTION 'Package must use newly authorized direct implementation workers'; END IF;
    ELSE RAISE EXCEPTION 'Action outside one-time commissioning purpose';
   END CASE;
  END LOOP;
 ELSE RAISE EXCEPTION 'No commissioning authority for this leader'; END IF;
END
$$;
CREATE FUNCTION public.project_org_coding_capacity_finish(p_job uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r project_coding_capacity_receipts; pkg uuid; used integer;
BEGIN
 SELECT receipt.* INTO r FROM project_coding_capacity_receipts receipt JOIN agent_missions m ON m.project_id=receipt.project_id
 JOIN mission_assignments j ON j.mission_id=m.id WHERE j.id=p_job;
 IF NOT FOUND THEN RETURN; END IF;
 IF (SELECT count(*) FROM project_organization_nodes WHERE project_id=r.project_id AND NOT id=ANY(r.original_node_ids))>3
 OR (SELECT count(*) FROM project_organization_nodes WHERE project_id=r.project_id AND NOT id=ANY(r.original_node_ids) AND 'development'=ANY(tools))>1
 THEN RAISE EXCEPTION 'Bounded commissioning worker limit exceeded'; END IF;
 SELECT id INTO pkg FROM project_work_packages WHERE project_id=r.project_id AND milestone_index=0 AND status='queued';
 SELECT count(*) INTO used FROM agent_missions WHERE project_id=r.project_id;
 IF pkg IS NOT NULL OR used>=r.approved_max_missions THEN
  UPDATE work_projects SET status=CASE WHEN pkg IS NOT NULL THEN 'paused' ELSE 'blocked' END,
   detail=CASE WHEN pkg IS NOT NULL THEN 'Owner-authorized commissioning complete; development package queued; further execution requires separate approval.'
    ELSE 'Approved commissioning mission limit reached; no package created.' END,
   lease=NULL,lease_until=NULL,updated_at=clock_timestamp()
   WHERE id=r.project_id AND active_mission_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commissioning completion could not stop atomically'; END IF;
  INSERT INTO project_events(project_id,event,data) VALUES(r.project_id,'coding_capacity_finished',jsonb_build_object(
   'authorizationId',r.authorization_id,'packageId',pkg,'usedMissions',used,'maxMissions',r.approved_max_missions));
 END IF;
END
$$;

-- Preserve all existing authority, locks, concurrency, SMART and hierarchy
-- checks. Patch only the exact installed production definitions.
DO $patch$
DECLARE b text; a text; t text; k record;
BEGIN
 FOR k IN SELECT * FROM (VALUES
  ('public.project_org_schedule(uuid,uuid)','28c3561df37876008d794bc4aad528a0'),
  ('public.project_org_schedule_hierarchy(uuid,uuid)','2fd7956c853c421dd130bf6cb90287f7'),
  ('public.project_org_decide(uuid,uuid,jsonb)','e4ea345fc5376b10d701df720cfb95bc'),
  ('public.project_provider_request(uuid,text,uuid,text,text,text,text)','7e33ed217129e75e1d007fdec9e1e176'),
  ('public.project_org_retest_claim_release_authorized_epoch(uuid,text,bigint,text)','bdd2abb4666d9ee3622b0ac73a20ff01'),
  ('public.project_org_retest_set_release_gate(uuid,text,text,text,bigint)','a2496c123684b2d350a0e031ead1f5b5')
 ) AS x(sig,expected) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=k.sig::regprocedure) IS DISTINCT FROM k.expected
  THEN RAISE EXCEPTION 'Unexpected installed commissioning recovery preimage: %',k.sig; END IF;
 END LOOP;

 b:=pg_get_functiondef('public.project_org_schedule(uuid,uuid)'::regprocedure);
 a:=$old$ r:=project_org_schedule_before_exception_recovery(p_project,p_lease);$old$;
 t:=$new$
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 IF EXISTS(SELECT 1 FROM project_coding_capacity_receipts WHERE project_id=p_project) THEN
  IF NOT EXISTS(SELECT 1 FROM work_projects WHERE id=p_project AND status='running' AND lease=p_lease AND p_lease IS NOT NULL AND lease_until>now())
   THEN RAISE EXCEPTION 'Project lease required'; END IF;
  IF NOT project_org_coding_capacity_live(p_project) THEN RETURN jsonb_build_object('blocked','One-time commissioning authority is no longer live'); END IF;
  IF EXISTS(SELECT 1 FROM work_projects p JOIN agent_missions m ON m.id=p.active_mission_id
   JOIN mission_assignments j ON j.mission_id=m.id WHERE p.id=p_project
   AND (m.status IN ('blocked','stopped','failed') OR (j.status='queued' AND j.attempts>0)))
   THEN RETURN jsonb_build_object('blocked','Commissioning assignment failed; automatic retries are not authorized'); END IF;
  IF EXISTS(SELECT 1 FROM work_projects p JOIN project_coding_capacity_receipts c ON c.project_id=p.id
    WHERE p.id=p_project AND p.active_mission_id IS NULL AND
     ((SELECT count(*) FROM agent_missions WHERE project_id=p.id)>=c.approved_max_missions
      OR NOT EXISTS(SELECT 1 FROM project_organization_nodes n WHERE n.id IN(c.director_id,c.manager_id) AND n.status='active'
       AND n.decision_needed AND n.deadline>now() AND project_org_dependencies_ready(n.id))))
   THEN RETURN jsonb_build_object('blocked','Approved commissioning capacity exhausted or no authorized implementation decision is pending'); END IF;
 END IF;
 r:=project_org_schedule_before_exception_recovery(p_project,p_lease);
 IF EXISTS(SELECT 1 FROM project_coding_capacity_receipts WHERE project_id=p_project) THEN
  IF r->>'missionId' IS NOT NULL THEN
   UPDATE agent_missions m SET project_evidence=m.project_evidence||jsonb_build_object('codingCapacityAuthorizationId',c.authorization_id)
    FROM project_coding_capacity_receipts c WHERE c.project_id=p_project AND m.id::text=r->>'missionId' AND m.project_id=c.project_id
     AND m.project_kind='management' AND NOT m.id=ANY(c.historical_mission_ids)
     AND m.project_evidence->>'organizationNodeId' IN(c.director_id::text,c.manager_id::text);
   IF NOT FOUND THEN RAISE EXCEPTION 'Scheduler proposed work outside commissioning authorization'; END IF;
  END IF;
  RETURN coalesce(r,jsonb_build_object('blocked','No authorized commissioning work remains'));
 END IF;
$new$;
 -- Only first occurrence (the inherited call also appears in recovery fallback).
 IF position(a in b)=0 THEN RAISE EXCEPTION 'Missing schedule continuation anchor'; END IF;
 b:=overlay(b placing t from position(a in b) for length(a)); EXECUTE b;

 b:=pg_get_functiondef('public.project_org_schedule_hierarchy(uuid,uuid)'::regprocedure);
 a:=$old$and decision_needed and deadline>now() and project_org_dependencies_ready(id) order by$old$;
 t:=$new$and decision_needed and deadline>now() and project_org_dependencies_ready(id)
 and (not exists(select 1 from project_coding_capacity_receipts c where c.project_id=p.id)
  or exists(select 1 from project_coding_capacity_receipts c where c.project_id=p.id and project_organization_nodes.id in(c.director_id,c.manager_id)))
 order by$new$;
 IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected scoped scheduler anchor'; END IF;
 EXECUTE replace(b,a,t);

 b:=pg_get_functiondef('public.project_org_decide(uuid,uuid,jsonb)'::regprocedure);
 a:=$old$ n:=project_org_principal(p_job,p_lease);$old$;
 t:=a||$new$
 PERFORM project_org_coding_capacity_commands(p_job,p_lease,p_commands);$new$;
 IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected decision entry anchor'; END IF;
 b:=replace(b,a,t);
 a:=$old$ return mission79_result;$old$;
 t:=$new$ PERFORM project_org_coding_capacity_finish(p_job);
 return mission79_result;$new$;
 IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected decision finish anchor'; END IF;
 EXECUTE replace(b,a,t);

 b:=pg_get_functiondef('public.project_provider_request(uuid,text,uuid,text,text,text,text)'::regprocedure);
 a:=$old$ perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));$old$;
 t:=a||$new$
 IF p_receipt IS NULL AND EXISTS(SELECT 1 FROM project_coding_capacity_receipts c JOIN agent_missions m ON m.project_id=c.project_id
  JOIN mission_assignments j ON j.mission_id=m.id WHERE j.id=p_job) THEN
  IF p_scope IS NOT NULL OR p_operation NOT IN ('model-list','inference') OR NOT project_org_coding_capacity_assignment(p_job,false)
   OR EXISTS(SELECT 1 FROM project_provider_requests WHERE assignment_id=p_job AND operation=p_operation)
   OR (p_operation='inference' AND NOT EXISTS(SELECT 1 FROM project_provider_requests WHERE assignment_id=p_job AND execution_attempt=p_attempt AND operation='model-list' AND resolved_at IS NOT NULL))
   OR (p_operation='inference' AND EXISTS(SELECT 1 FROM project_coding_capacity_receipts c JOIN agent_missions m ON m.project_id=c.project_id
       JOIN mission_assignments j ON j.mission_id=m.id WHERE j.id=p_job
       AND (SELECT count(*) FROM project_provider_requests q WHERE q.project_id=c.project_id AND q.operation='inference' AND NOT q.mission_id=ANY(c.historical_mission_ids))>=c.paid_inference_limit))
  THEN RETURN false; END IF;
 END IF;
$new$;
 IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected provider admission anchor'; END IF;
 EXECUTE replace(b,a,t);

 b:=pg_get_functiondef('public.project_org_retest_claim_release_authorized_epoch(uuid,text,bigint,text)'::regprocedure);
 a:=$old$  OR public.project_org_followup_context_retest_claim_authorized(p_project,p_release,p_generation,p_deployment)$old$;
 t:=a||$new$
  OR public.project_org_coding_capacity_claim_authorized(p_project,p_release,p_generation,p_deployment)$new$;
 IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected release claim anchor'; END IF;
 EXECUTE replace(b,a,t);

 b:=pg_get_functiondef('public.project_org_retest_set_release_gate(uuid,text,text,text,bigint)'::regprocedure);
 a:=$old$  or p.max_missions<>96 or p.token_allowance<>600000$old$;
 t:=$new$  or (p.max_missions<>96 and not exists(select 1 from project_coding_capacity_receipts c where c.project_id=p.id and c.approved_max_missions=p.max_missions))
  or p.token_allowance<>600000$new$;
 IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected release capacity anchor'; END IF;
 b:=replace(b,a,t);
 a:=$old$ if p_action='closed' and (g.project_id is null or g.state<>'active'$old$;
 t:=$new$ if p_action='closed' and p.status='running' and exists(select 1 from project_coding_capacity_receipts where project_id=p.id)
  then raise exception 'Drain the one-time commissioning window before another release';end if;
 if p_action='closed' and (g.project_id is null or g.state<>'active'$new$;
 IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected release drain anchor'; END IF;
 EXECUTE replace(b,a,t);
END
$patch$;

REVOKE ALL ON FUNCTION public.project_org_coding_capacity_state(uuid),
 public.project_org_coding_capacity_offer(uuid,uuid,text),
 public.project_org_coding_capacity_authorize(uuid,uuid,text,bigint,text,uuid,text,text,timestamptz,integer,integer,integer,integer,integer,bigint),
 public.project_org_coding_capacity_live(uuid), public.project_org_coding_capacity_assignment(uuid,boolean),
 public.project_org_coding_capacity_claim_authorized(uuid,text,bigint,text), public.project_org_coding_capacity_commands(uuid,uuid,jsonb),
 public.project_org_coding_capacity_finish(uuid), public.project_org_coding_capacity_resource_guard()
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_coding_capacity_offer(uuid,uuid,text),
 public.project_org_coding_capacity_authorize(uuid,uuid,text,bigint,text,uuid,text,text,timestamptz,integer,integer,integer,integer,integer,bigint)
 TO service_role;
COMMIT;

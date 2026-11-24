-- Exact one-time continuation of the existing signed commissioning window.
-- Owner accepted the exhaustive-target M98 regression, NOT new execution.
-- Installation changes no project, mission, assignment, node, grant or receipt.
BEGIN;
CREATE TABLE public.project_coding_capacity_resume_receipts(
 project_id uuid PRIMARY KEY REFERENCES public.project_coding_capacity_receipts(project_id),
 authorization_id uuid NOT NULL UNIQUE,
 prior_authorization_id uuid NOT NULL UNIQUE REFERENCES public.project_coding_capacity_receipts(authorization_id),
 owner_id uuid NOT NULL,
 source_mission_id uuid NOT NULL REFERENCES public.agent_missions(id),
 source_assignment_id uuid NOT NULL REFERENCES public.mission_assignments(id),
 release_sha text NOT NULL CHECK(release_sha ~ '^[a-f0-9]{40}$'),
 release_generation bigint NOT NULL CHECK(release_generation>0),
 deployment_id text NOT NULL CHECK(deployment_id ~ '^dpl_[A-Za-z0-9]+$'),
 scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 cutoff timestamptz NOT NULL,
 historical_missions integer NOT NULL CHECK(historical_missions=98),
 historical_mission_ids uuid[] NOT NULL CHECK(cardinality(historical_mission_ids)=98),
 prior_max_missions integer NOT NULL CHECK(prior_max_missions=100),
 additional_missions integer NOT NULL CHECK(additional_missions=3),
 approved_max_missions integer NOT NULL CHECK(approved_max_missions=101),
 paid_inference_limit integer NOT NULL CHECK(paid_inference_limit=3),
 retry_limit integer NOT NULL CHECK(retry_limit=0),
 token_allowance integer NOT NULL CHECK(token_allowance=600000),
 recorded_tokens bigint NOT NULL CHECK(recorded_tokens BETWEEN 0 AND token_allowance),
 historical_provider_requests integer NOT NULL,
 state_hash text NOT NULL CHECK(state_hash ~ '^[a-f0-9]{64}$'),
 authorization_txid bigint NOT NULL DEFAULT txid_current(),
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.project_coding_capacity_resume_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_coding_capacity_resume_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER project_coding_capacity_resume_immutable BEFORE UPDATE OR DELETE
 ON public.project_coding_capacity_resume_receipts FOR EACH ROW EXECUTE FUNCTION public.project_org_change_immutable();

-- Project exactly ONE effective receipt. A successor uses its own ID, release,
-- 98-mission history and three-call limit. Original scope, hierarchy and objective
-- remain inherited from the immutable initial receipt; no spent authority is reused.
CREATE VIEW public.project_coding_capacity_authority WITH (security_invoker=true) AS
 SELECT r.project_id,coalesce(s.authorization_id,r.authorization_id) authorization_id,r.owner_id,
  coalesce(s.release_sha,r.release_sha) release_sha,coalesce(s.release_generation,r.release_generation) release_generation,
  coalesce(s.deployment_id,r.deployment_id) deployment_id,r.scope_hash,r.scope_paths,r.objective_hash,r.spec_hash,r.cutoff,
  coalesce(s.historical_missions,r.historical_missions) historical_missions,
  coalesce(s.historical_mission_ids,r.historical_mission_ids) historical_mission_ids,r.original_node_ids,r.director_id,r.manager_id,
  coalesce(s.prior_max_missions,r.prior_max_missions) prior_max_missions,coalesce(s.additional_missions,r.additional_missions) additional_missions,
  coalesce(s.approved_max_missions,r.approved_max_missions) approved_max_missions,
  coalesce(s.paid_inference_limit,r.paid_inference_limit) paid_inference_limit,r.retry_limit,r.token_allowance,
  coalesce(s.recorded_tokens,r.recorded_tokens) recorded_tokens,coalesce(s.historical_provider_requests,r.historical_provider_requests) historical_provider_requests,
  coalesce(s.state_hash,r.state_hash) state_hash,coalesce(s.authorized_at,r.authorized_at) authorized_at
 FROM public.project_coding_capacity_receipts r LEFT JOIN public.project_coding_capacity_resume_receipts s
 ON s.project_id=r.project_id AND s.prior_authorization_id=r.authorization_id AND s.owner_id=r.owner_id
 AND s.scope_hash=r.scope_hash AND s.cutoff=r.cutoff AND s.token_allowance=r.token_allowance;
REVOKE ALL ON public.project_coding_capacity_authority FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.project_org_coding_capacity_resume_offer(p_owner uuid,p_project uuid,p_release text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p work_projects; a project_provider_execution; g project_retest_production_release_gate;
 r project_coding_capacity_receipts; s project_coding_capacity_resume_receipts;
 m agent_missions; j mission_assignments; used integer; spent bigint; providers integer; paid integer; state_hash text;
BEGIN
 SELECT * INTO p FROM work_projects WHERE id=p_project;
 SELECT * INTO a FROM project_provider_execution WHERE project_id=p_project;
 SELECT * INTO g FROM project_retest_production_release_gate WHERE project_id=p_project;
 SELECT * INTO r FROM project_coding_capacity_receipts WHERE project_id=p_project;
 SELECT * INTO s FROM project_coding_capacity_resume_receipts WHERE project_id=p_project;
 IF p.id IS DISTINCT FROM 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
 OR p_owner IS NULL OR a.owner_id IS DISTINCT FROM p_owner OR r.owner_id IS DISTINCT FROM p_owner
 OR standalone_verify_scope(p_owner,p.actor_id,p.chat_id) IS DISTINCT FROM true
 OR r.authorization_id IS DISTINCT FROM '99788be7-2c41-4145-b1a7-a96e6635a667'::uuid
 OR r.release_sha IS DISTINCT FROM '4bb4e90717064f07f0d0ef8424d48b38f044a4ab'
 OR r.deployment_id IS DISTINCT FROM 'dpl_83d7Wz9ArXqiwyJCGKQyoybNmbzx'
 OR r.release_generation<>41 OR r.historical_missions<>96 OR r.approved_max_missions<>100
 OR r.additional_missions<>4 OR r.paid_inference_limit<>4 OR r.retry_limit<>0
 OR g.state IS DISTINCT FROM 'active' OR g.alias_name IS DISTINCT FROM 'katie-mu.vercel.app'
 OR g.release_sha IS DISTINCT FROM p_release OR g.release_sha=r.release_sha OR g.deployment_id=r.deployment_id
 OR g.generation IS DISTINCT FROM r.release_generation+2
 THEN RAISE EXCEPTION 'Exact authenticated owner and corrected commissioning release required'; END IF;
 SELECT count(*),coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0) INTO used,spent FROM agent_missions WHERE project_id=p.id;
 SELECT count(*),count(*) FILTER(WHERE operation='inference') INTO providers,paid FROM project_provider_requests WHERE project_id=p.id;
 IF s.project_id IS NOT NULL THEN
  IF s.release_sha IS DISTINCT FROM g.release_sha OR s.release_generation IS DISTINCT FROM g.generation OR s.deployment_id IS DISTINCT FROM g.deployment_id
  THEN RAISE EXCEPTION 'Prior recovery receipt belongs to a different release'; END IF;
  RETURN jsonb_build_object('stage','authorized','projectId',p.id,'authorizationId',s.authorization_id,'authorizedAt',s.authorized_at,
   'priorAuthorizationId',s.prior_authorization_id,'sourceMissionId',s.source_mission_id,'sourceAssignmentId',s.source_assignment_id,
   'releaseSha',s.release_sha,'releaseGeneration',s.release_generation,'deploymentId',s.deployment_id,'scopeHash',s.scope_hash,
   'paths',r.scope_paths,'cutoff',s.cutoff,'historicalMissions',98,'priorMaxMissions',100,'additionalMissions',3,'maxMissions',101,
   'remainingMissions',greatest(0,101-used),'paidInferenceLimit',3,'retryLimit',0,'tokenAllowance',600000,
   'recordedTokens',s.recorded_tokens,'remainingRecordedTokens',600000-s.recorded_tokens,'nodeCount',13,
   'directorId',r.director_id,'managerId',r.manager_id,'stateHash',s.state_hash,'status',p.status,
   'providerRequestsAtApproval',s.historical_provider_requests,'providerRequestsNow',providers,
   'packageId',(SELECT id FROM project_work_packages WHERE project_id=p.id AND milestone_index=0));
 END IF;
 SELECT * INTO m FROM agent_missions WHERE id='5bd4b72d-cd8b-4425-a6dd-16fdcfd346d7'::uuid AND project_id=p.id;
 SELECT * INTO j FROM mission_assignments WHERE id='3cf41309-6f35-4c68-8e75-7da55d5669c6'::uuid AND mission_id=m.id;
 IF p.status IS DISTINCT FROM 'blocked' OR p.detail IS DISTINCT FROM 'Commissioning assignment failed; automatic retries are not authorized'
 OR p.phase<>'development' OR p.organization_version<>1 OR p.milestone_index<>0
 OR p.max_missions<>100 OR used<>98 OR p.token_allowance<>600000 OR spent>=600000
 OR p.active_mission_id IS DISTINCT FROM m.id OR p.lease IS NOT NULL OR p.lease_until IS NOT NULL
 OR p.deadline IS DISTINCT FROM r.cutoff OR p.deadline IS DISTINCT FROM a.deadline OR p.deadline<=clock_timestamp()+interval '5 minutes'
 OR p.approved_hash IS DISTINCT FROM r.scope_hash OR p.approval_hash IS DISTINCT FROM r.scope_hash OR a.approved_scope IS DISTINCT FROM r.scope_hash
 OR p.spec->'allowedPaths' IS DISTINCT FROM to_jsonb(r.scope_paths)
 OR encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex') IS DISTINCT FROM r.objective_hash
 OR encode(sha256(convert_to(project_canonical(p.spec),'UTF8')),'hex') IS DISTINCT FROM r.spec_hash
 OR NOT project_provider_continued(p.id) OR NOT project_org_bounded_recovery_window_valid(p.id)
 OR NOT project_org_retest_original_owner_lineage(p.id) OR NOT project_org_retest_exact_scope_grants(p.id)
 OR (SELECT array_agg(id ORDER BY id) FROM project_organization_nodes WHERE project_id=p.id) IS DISTINCT FROM r.original_node_ids
 OR EXISTS(SELECT 1 FROM project_organization_nodes WHERE project_id=p.id AND kind='worker' AND 'development'=ANY(tools))
 OR EXISTS(SELECT 1 FROM project_work_packages WHERE project_id=p.id)
 OR NOT EXISTS(SELECT 1 FROM project_organization_nodes n JOIN project_organization_nodes d ON d.id=n.parent_id
  WHERE n.id=r.manager_id AND d.id=r.director_id AND n.project_id=p.id AND d.project_id=p.id
   AND n.kind='manager' AND n.management_level='manager' AND n.status='active' AND n.decision_needed
   AND 'development'=ANY(n.tools) AND d.status='active' AND NOT d.decision_needed AND 'development'=ANY(d.tools)
   AND project_org_dependencies_ready(n.id))
 OR EXISTS(SELECT 1 FROM unnest(r.historical_mission_ids) saved(id) WHERE NOT EXISTS(SELECT 1 FROM agent_missions x WHERE x.id=saved.id AND x.project_id=p.id))
 OR EXISTS(SELECT 1 FROM agent_missions x WHERE x.project_id=p.id AND x.status NOT IN ('completed','blocked','stopped','failed'))
 OR EXISTS(SELECT 1 FROM mission_assignments y JOIN agent_missions x ON x.id=y.mission_id WHERE x.project_id=p.id
  AND (y.lease IS NOT NULL OR y.lease_until IS NOT NULL OR y.status NOT IN ('completed','failed','blocked','stopped','cancelled','canceled')))
 OR project_provider_request_pending(p.id)
 OR (SELECT count(*) FROM project_provider_requests q WHERE q.project_id=p.id AND q.operation='inference' AND NOT q.mission_id=ANY(r.historical_mission_ids))<>2
 OR m.id IS NULL OR j.id IS NULL OR m.status<>'blocked' OR m.calls<>1 OR m.project_kind<>'management'
 OR m.project_evidence->>'organizationNodeId' IS DISTINCT FROM r.manager_id::text
 OR m.project_evidence->>'codingCapacityAuthorizationId' IS DISTINCT FROM r.authorization_id::text
 OR m.project_evidence->>'previousMissionId' IS NOT NULL OR m.deadline IS DISTINCT FROM r.cutoff
 OR j.status<>'failed' OR j.attempts<>1 OR j.role<>'work' OR j.job_key<>'plan'
 OR j.payload->>'organizationNodeId' IS DISTINCT FROM r.manager_id::text
 OR j.detail IS DISTINCT FROM 'Mission state operation failed: {"code":"P0001","details":null,"hint":null,"message":"Grant only newly appointed direct workers their approved scope"}'
 OR j.result->>'detail' IS DISTINCT FROM j.detail OR m.detail IS DISTINCT FROM j.detail
 OR EXISTS(SELECT 1 FROM project_organization_decisions WHERE assignment_id=j.id)
 OR (SELECT count(*) FROM mission_assignments WHERE mission_id=m.id)<>1
 OR NOT EXISTS(SELECT 1 FROM project_organization_assignments b JOIN project_organization_nodes n ON n.id=b.node_id
   WHERE b.assignment_id=j.id AND b.node_id=r.manager_id AND n.agent_id=j.agent_id
    AND b.contract_hash=encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex'))
 OR NOT EXISTS(SELECT 1 FROM project_provider_requests q WHERE q.project_id=p.id AND q.mission_id=m.id AND q.assignment_id=j.id
   AND q.operation='inference' AND q.resolved_at IS NOT NULL AND q.provider_receipt IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM agent_missions x JOIN mission_assignments y ON y.mission_id=x.id
   JOIN project_organization_decisions d ON d.assignment_id=y.id AND d.project_id=p.id AND d.node_id=r.director_id AND d.id::text=y.result->>'decisionId'
   WHERE x.id='780f3dd3-20d1-46a5-966a-53ff600863c1'::uuid AND x.project_id=p.id AND x.status='completed' AND x.calls=1
    AND x.project_evidence->>'codingCapacityAuthorizationId'=r.authorization_id::text
    AND x.project_evidence->>'organizationNodeId'=r.director_id::text AND y.status='completed' AND y.attempts=1
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.decision) c WHERE c->>'action'='reject' AND c->>'nodeId'=r.manager_id::text)
    AND EXISTS(SELECT 1 FROM project_provider_requests q WHERE q.project_id=p.id AND q.mission_id=x.id AND q.assignment_id=y.id
      AND q.operation='inference' AND q.resolved_at IS NOT NULL AND q.provider_receipt IS NOT NULL))
 OR EXISTS(SELECT 1 FROM agent_missions x WHERE x.project_id=p.id AND NOT x.id=ANY(r.historical_mission_ids)
   AND x.id NOT IN(m.id,'780f3dd3-20d1-46a5-966a-53ff600863c1'::uuid))
 THEN RAISE EXCEPTION 'Exact failed M98 commissioning baseline no longer eligible'; END IF;
 state_hash:=encode(sha256(convert_to(project_canonical(jsonb_build_object('priorReceipt',to_jsonb(r),'state',project_org_coding_capacity_state(p.id))),'UTF8')),'hex');
 RETURN jsonb_build_object('stage','authorize','projectId',p.id,'authorizationId',null,
  'priorAuthorizationId',r.authorization_id,'sourceMissionId',m.id,'sourceAssignmentId',j.id,'failure',j.detail,
  'releaseSha',g.release_sha,'releaseGeneration',g.generation,'deploymentId',g.deployment_id,'scopeHash',r.scope_hash,
  'paths',r.scope_paths,'cutoff',r.cutoff,'historicalMissions',98,'priorMaxMissions',100,'remainingMissions',2,
  'minAdditionalMissions',3,'recommendedAdditionalMissions',3,'maxAdditionalMissions',3,
  'additionalMissions',3,'maxMissions',101,'paidInferenceLimit',3,'retryLimit',0,'tokenAllowance',600000,
  'recordedTokens',spent,'remainingRecordedTokens',600000-spent,'nodeCount',13,'directorId',r.director_id,'managerId',r.manager_id,
  'providerRequestsAtApproval',providers,'historicalInferenceRequests',paid,'stateHash',state_hash,'status',p.status);
END
$$;

CREATE FUNCTION public.project_org_coding_capacity_resume_authorize(
 p_owner uuid,p_project uuid,p_release text,p_generation bigint,p_deployment text,p_authorization uuid,
 p_state_hash text,p_scope text,p_cutoff timestamptz,p_additional integer,p_max integer,p_paid_limit integer,
 p_retry_limit integer,p_tokens integer,p_remaining bigint,p_prior_authorization uuid,p_source_mission uuid,p_source_assignment uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o jsonb; p work_projects; stamp timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 SELECT * INTO p FROM work_projects WHERE id=p_project FOR UPDATE;
 PERFORM 1 FROM project_retest_production_release_gate WHERE project_id=p_project FOR UPDATE;
 PERFORM 1 FROM project_organization_nodes WHERE project_id=p_project ORDER BY id FOR UPDATE;
 o:=project_org_coding_capacity_resume_offer(p_owner,p_project,p_release);
 IF o->>'stage' IS DISTINCT FROM 'authorize' OR p_authorization IS NULL OR p_authorization=p_prior_authorization
 OR p_prior_authorization IS DISTINCT FROM (o->>'priorAuthorizationId')::uuid
 OR p_source_mission IS DISTINCT FROM (o->>'sourceMissionId')::uuid OR p_source_assignment IS DISTINCT FROM (o->>'sourceAssignmentId')::uuid
 OR p_state_hash IS DISTINCT FROM o->>'stateHash' OR p_scope IS DISTINCT FROM o->>'scopeHash' OR p_cutoff IS DISTINCT FROM (o->>'cutoff')::timestamptz
 OR p_generation IS DISTINCT FROM (o->>'releaseGeneration')::bigint OR p_deployment IS DISTINCT FROM o->>'deploymentId'
 OR p_additional IS DISTINCT FROM 3 OR p_max IS DISTINCT FROM 101 OR p_paid_limit IS DISTINCT FROM 3
 OR p_retry_limit IS DISTINCT FROM 0 OR p_tokens IS DISTINCT FROM 600000 OR p_remaining IS DISTINCT FROM (o->>'remainingRecordedTokens')::bigint
 THEN RAISE EXCEPTION 'Exact fresh three-mission owner consent required; stale or duplicate approval'; END IF;
 stamp:=clock_timestamp();
 INSERT INTO project_coding_capacity_resume_receipts(project_id,authorization_id,prior_authorization_id,owner_id,source_mission_id,source_assignment_id,
  release_sha,release_generation,deployment_id,scope_hash,cutoff,historical_missions,historical_mission_ids,prior_max_missions,additional_missions,
  approved_max_missions,paid_inference_limit,retry_limit,token_allowance,recorded_tokens,historical_provider_requests,state_hash,authorized_at)
 VALUES(p.id,p_authorization,p_prior_authorization,p_owner,p_source_mission,p_source_assignment,p_release,p_generation,p_deployment,
  p_scope,p_cutoff,98,ARRAY(SELECT id FROM agent_missions WHERE project_id=p.id ORDER BY id),100,3,101,3,0,600000,
  (o->>'recordedTokens')::bigint,(o->>'providerRequestsAtApproval')::integer,p_state_hash,stamp);
 PERFORM authorize_work_project_resources(p.id,p.actor_id,p.chat_id,600000,NULL,101,NULL,p_authorization,
  'Authenticated owner Mission98 commissioning continuation on '||p_release||'; 98 preserved missions, ceiling 101, exactly three fresh paid management calls at most, zero retries and no token, scope or deadline increase.');
 UPDATE work_projects SET status='running',active_mission_id=NULL,detail='Owner-authorized Mission98 continuation; awaiting normal scheduler',
  progress_since=stamp,progress_signature=NULL,error_signature=NULL,repeated_errors=0,impediment=NULL,updated_at=stamp
 WHERE id=p.id AND status='blocked' AND active_mission_id=p_source_mission AND max_missions=101;
 IF NOT FOUND THEN RAISE EXCEPTION 'Atomic Mission98 continuation failed'; END IF;
 INSERT INTO project_events(project_id,event,data) VALUES(p.id,'coding_capacity_resumed',jsonb_build_object('authorizationId',p_authorization,
  'priorAuthorizationId',p_prior_authorization,'sourceMissionId',p_source_mission,'sourceAssignmentId',p_source_assignment,
  'historicalMissions',98,'priorMaxMissions',100,'maxMissions',101,'paidInferenceLimit',3,'retryLimit',0,
  'releaseSha',p_release,'generation',p_generation,'deploymentId',p_deployment,'scopeHash',p_scope,'cutoff',p_cutoff));
 RETURN project_org_coding_capacity_resume_offer(p_owner,p_project,p_release);
END
$$;

-- Existing management, claim, provider and finish functions retain every
-- authority predicate and all locks. Change only the receipt lookup, and
-- narrow the successor window to the already-pending Delivery Manager.
DO $patch$
DECLARE k record; b text; a text; t text;
BEGIN
 FOR k IN SELECT * FROM (VALUES
 ('public.project_org_coding_capacity_live(uuid)','e7b53559d930af2cad31bbcfc17f9076'),
 ('public.project_org_coding_capacity_assignment(uuid,boolean)','ad5c613771cd02bdc3064810e50c3892'),
 ('public.project_org_coding_capacity_claim_authorized(uuid,text,bigint,text)','11d20957aa6ef41299c2d851e01a4464'),
 ('public.project_org_coding_capacity_commands(uuid,uuid,jsonb)','f8143f6c9a53104cbb413741c0825bec'),
 ('public.project_org_coding_capacity_finish(uuid)','64f950dc2c79675e413012d7a8a9c838'),
 ('public.project_org_schedule(uuid,uuid)','453fe7b33ec218a8fc41aa46452c63ef'),
 ('public.project_org_schedule_hierarchy(uuid,uuid)','014b6e02ba3dfa87ddbc65bfd449a8db'),
 ('public.project_provider_request(uuid,text,uuid,text,text,text,text)','49db88df322f02b577830860afc118f5'),
 ('public.project_org_retest_set_release_gate(uuid,text,text,text,bigint)','bca4d845e09b291074f7f052633406b9'),
 ('public.project_org_coding_capacity_offer(uuid,uuid,text)','7bd7b8682e18af094d2e3cb492950be1'),
 ('public.project_org_coding_capacity_resource_guard()','ca65c46d481adc0416ab4e2cc067f097')
 ) x(sig,expected) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=k.sig::regprocedure) IS DISTINCT FROM k.expected
  THEN RAISE EXCEPTION 'Unexpected installed Mission98 continuation preimage: %',k.sig; END IF;
  b:=pg_get_functiondef(k.sig::regprocedure);
  IF k.sig LIKE 'public.project_org_coding_capacity_offer(%' THEN
   a:=$old$ IF r.project_id IS NOT NULL THEN$old$;
   t:=$new$ IF r.project_id IS NOT NULL AND (r.release_sha IS DISTINCT FROM p_release OR EXISTS(SELECT 1 FROM project_coding_capacity_resume_receipts WHERE project_id=p_project)) THEN
  RETURN project_org_coding_capacity_resume_offer(p_owner,p_project,p_release);
 END IF;
 IF r.project_id IS NOT NULL THEN$new$;
   IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected offer anchor'; END IF;
   b:=replace(b,a,t);
  ELSIF k.sig='public.project_org_coding_capacity_resource_guard()' THEN
   a:=$old$  AND EXISTS(SELECT 1 FROM project_coding_capacity_receipts r WHERE r.project_id=OLD.id AND NEW.max_missions=r.approved_max_missions))$old$;
   t:=a||$new$
 AND NOT (OLD.max_missions=100 AND NEW.max_missions=101 AND OLD.status='blocked'
  AND NEW.token_allowance=OLD.token_allowance AND NEW.deadline=OLD.deadline
  AND EXISTS(SELECT 1 FROM project_coding_capacity_resume_receipts s WHERE s.project_id=OLD.id
   AND s.authorization_txid=txid_current() AND s.source_mission_id=OLD.active_mission_id
   AND s.prior_max_missions=OLD.max_missions AND s.approved_max_missions=NEW.max_missions))$new$;
   IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected resource guard anchor'; END IF;
   b:=replace(b,a,t);
  ELSE
   b:=replace(b,'FROM project_coding_capacity_receipts','FROM project_coding_capacity_authority');
   b:=replace(b,'JOIN project_coding_capacity_receipts','JOIN project_coding_capacity_authority');
   IF k.sig='public.project_org_coding_capacity_live(uuid)' THEN
    b:=replace(b,'BETWEEN 96 AND r.approved_max_missions','BETWEEN r.historical_missions AND r.approved_max_missions');
   ELSIF k.sig='public.project_org_coding_capacity_assignment(uuid,boolean)' THEN
    b:=replace(b,'n.id IN(r.director_id,r.manager_id)','n.id IN(r.director_id,r.manager_id) AND (r.historical_missions=96 OR n.id=r.manager_id)');
   ELSIF k.sig='public.project_org_schedule(uuid,uuid)' THEN
    b:=replace(b,'n.id IN(c.director_id,c.manager_id) AND n.status','n.id IN(c.director_id,c.manager_id) AND (c.historical_missions=96 OR n.id=c.manager_id) AND n.status');
    b:=replace(b,'m.project_evidence->>''organizationNodeId'' IN(c.director_id::text,c.manager_id::text);','m.project_evidence->>''organizationNodeId'' IN(c.director_id::text,c.manager_id::text) AND (c.historical_missions=96 OR m.project_evidence->>''organizationNodeId''=c.manager_id::text);');
   ELSIF k.sig='public.project_org_schedule_hierarchy(uuid,uuid)' THEN
    b:=replace(b,'project_organization_nodes.id in(c.director_id,c.manager_id)','project_organization_nodes.id in(c.director_id,c.manager_id) AND (c.historical_missions=96 OR project_organization_nodes.id=c.manager_id)');
   END IF;
  END IF;
  EXECUTE b;
 END LOOP;
END
$patch$;

REVOKE ALL ON FUNCTION public.project_org_coding_capacity_resume_offer(uuid,uuid,text),
 public.project_org_coding_capacity_resume_authorize(uuid,uuid,text,bigint,text,uuid,text,text,timestamptz,integer,integer,integer,integer,integer,bigint,uuid,uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_coding_capacity_resume_authorize(uuid,uuid,text,bigint,text,uuid,text,text,timestamptz,integer,integer,integer,integer,integer,bigint,uuid,uuid,uuid)
 TO service_role;
COMMIT;

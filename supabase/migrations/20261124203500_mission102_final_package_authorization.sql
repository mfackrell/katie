-- One final owner-authorized package-only successor of the existing receipt
-- chain. Mission 100 appointments and Mission 101 scope grant are retained.
-- Installation grants no capacity, creates no mission and performs no inference.
BEGIN;
ALTER TABLE public.project_coding_capacity_resume_receipts
 DROP CONSTRAINT project_coding_capacity_resume_recei_paid_inference_limit_check,
 DROP CONSTRAINT project_coding_capacity_resume_receip_additional_missions_check,
 DROP CONSTRAINT project_coding_capacity_resume_receipts_check1,
 DROP CONSTRAINT project_coding_capacity_resume_receipts_check2,
 DROP CONSTRAINT project_coding_capacity_resume_receipts_check3,
 ADD CHECK(historical_missions IN (98,99,102) AND cardinality(historical_mission_ids)=historical_missions),
 ADD CHECK(approved_max_missions=historical_missions+additional_missions),
 ADD CHECK(paid_inference_limit=additional_missions),
 ADD CHECK((historical_missions=98 AND prior_max_missions=100 AND additional_missions=3 AND supersedes_authorization_id IS NULL)
 OR (historical_missions=99 AND prior_max_missions=101 AND additional_missions=3 AND supersedes_authorization_id IS NOT NULL AND supersedes_authorization_id<>authorization_id)
 OR (historical_missions=102 AND prior_max_missions=102 AND additional_missions=1 AND supersedes_authorization_id IS NOT NULL AND supersedes_authorization_id<>authorization_id));
CREATE OR REPLACE VIEW public.project_coding_capacity_authority WITH (security_invoker=true) AS
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
 FROM public.project_coding_capacity_receipts r LEFT JOIN LATERAL (
 SELECT s.* FROM public.project_coding_capacity_resume_receipts s
 WHERE s.project_id=r.project_id AND s.prior_authorization_id=r.authorization_id AND s.owner_id=r.owner_id
 AND s.scope_hash=r.scope_hash AND s.cutoff=r.cutoff AND s.token_allowance=r.token_allowance
 AND (s.historical_missions=98 OR (s.historical_missions=99 AND EXISTS(
  SELECT 1 FROM public.project_coding_capacity_resume_receipts predecessor
  WHERE predecessor.project_id=s.project_id AND predecessor.historical_missions=98
   AND predecessor.authorization_id=s.supersedes_authorization_id AND predecessor.prior_authorization_id=r.authorization_id
   AND predecessor.owner_id=s.owner_id AND predecessor.scope_hash=s.scope_hash AND predecessor.cutoff=s.cutoff
   AND predecessor.approved_max_missions=s.prior_max_missions AND predecessor.release_generation+2=s.release_generation))
 OR (s.historical_missions=102 AND EXISTS(
  SELECT 1 FROM public.project_coding_capacity_resume_receipts predecessor
  JOIN public.project_coding_capacity_resume_receipts older ON older.project_id=predecessor.project_id
   AND older.historical_missions=98 AND older.authorization_id=predecessor.supersedes_authorization_id
  WHERE predecessor.project_id=s.project_id AND predecessor.historical_missions=99
   AND predecessor.authorization_id=s.supersedes_authorization_id AND predecessor.prior_authorization_id=r.authorization_id
   AND predecessor.owner_id=s.owner_id AND predecessor.scope_hash=s.scope_hash AND predecessor.cutoff=s.cutoff
   AND predecessor.approved_max_missions=s.prior_max_missions AND predecessor.release_generation+2=s.release_generation)))
 ORDER BY s.historical_missions DESC LIMIT 1
 ) s ON true;


REVOKE ALL ON public.project_coding_capacity_authority FROM PUBLIC,anon,authenticated,service_role;

-- Preserve the exact actual accepted appointments, their registry bindings,
-- and the four existing scope grants. This is NOT a new grant or appointment.
CREATE FUNCTION public.project_org_coding_capacity_final_roles_valid(p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT EXISTS(
  SELECT 1 FROM work_projects p
  JOIN project_coding_capacity_receipts r ON r.project_id=p.id
  JOIN project_coding_capacity_resume_receipts s ON s.project_id=p.id AND s.historical_missions=99
  JOIN project_organization_nodes mgr ON mgr.id=r.manager_id AND mgr.project_id=p.id AND mgr.kind='manager' AND mgr.status='active' AND mgr.parent_id=r.director_id
  JOIN project_organization_nodes coder ON coder.id='08e792df-1046-4282-89dc-83994a8a6b7e'::uuid AND coder.project_id=p.id AND coder.parent_id=mgr.id
  JOIN project_organization_nodes reviewer ON reviewer.id='1cf12044-d9ba-4e8b-9ef4-8b7e5aa004a5'::uuid AND reviewer.project_id=p.id AND reviewer.parent_id=mgr.id
  JOIN managed_agents ca ON ca.id=coder.agent_id AND ca.id='8421786a-0874-4d86-992e-f0f087d8018e'::uuid AND NOT ca.archived AND ca.config->'development'='true'::jsonb
  JOIN managed_agents ra ON ra.id=reviewer.agent_id AND ra.id='e7d25ada-a761-41bf-8f65-f87056f175fa'::uuid AND NOT ra.archived AND ra.config->'development'='false'::jsonb
  JOIN agent_missions m100 ON m100.id='32cde957-b859-414d-88f0-ab726a238808'::uuid AND m100.project_id=p.id
  JOIN mission_assignments j100 ON j100.id='1e6d47e0-1515-4cd7-997a-47148d6d52f4'::uuid AND j100.mission_id=m100.id
  JOIN project_organization_decisions d100 ON d100.assignment_id=j100.id AND d100.node_id=mgr.id AND d100.project_id=p.id AND d100.id::text=j100.result->>'decisionId'
  JOIN agent_missions m101 ON m101.id='06be0829-baf2-4205-8ccd-42def3345c5a'::uuid AND m101.project_id=p.id
  JOIN mission_assignments j101 ON j101.id='00af04ad-d161-4e61-be80-101415028396'::uuid AND j101.mission_id=m101.id
  JOIN project_organization_decisions d101 ON d101.assignment_id=j101.id AND d101.node_id=mgr.id AND d101.project_id=p.id AND d101.id::text=j101.result->>'decisionId'
 WHERE p.id=p_project AND p.id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
 AND p.approved_hash=r.scope_hash AND p.approval_hash=r.scope_hash AND p.deadline=r.cutoff
 AND 'development'=ANY(mgr.tools) AND project_org_dependencies_ready(mgr.id)
 AND coder.kind='worker' AND coder.status='active' AND coder.management_level='worker' AND coder.scope_hash=r.scope_hash
 AND coder.deadline=r.cutoff AND cardinality(coder.scope_paths)=0 AND coder.tools @> ARRAY['development','analysis'] AND cardinality(coder.tools)=2
 AND reviewer.kind='worker' AND reviewer.status='active' AND reviewer.management_level='worker' AND reviewer.scope_hash=r.scope_hash
 AND reviewer.deadline=r.cutoff AND reviewer.tools=ARRAY['analysis'] AND cardinality(reviewer.scope_paths)=0
 AND coder.id<>reviewer.id AND ca.id<>ra.id AND ca.id=ANY(p.team) AND ra.id=ANY(p.team)
 AND NOT coder.id=ANY(r.original_node_ids) AND NOT reviewer.id=ANY(r.original_node_ids)
 AND (SELECT array_agg(n.id ORDER BY n.id) FROM project_organization_nodes n WHERE n.project_id=p.id AND n.id<>ALL(ARRAY[coder.id,reviewer.id]))=r.original_node_ids
 AND (SELECT count(*) FROM project_organization_nodes WHERE project_id=p.id)=15
 AND (SELECT count(*) FROM project_organization_nodes WHERE project_id=p.id AND kind='worker' AND 'development'=ANY(tools))=1
 AND (SELECT count(*) FROM project_organization_scope_grants g JOIN project_organization_nodes n ON n.id=g.node_id WHERE n.project_id=p.id)=4
 AND (SELECT count(*) FROM project_organization_scope_grants g JOIN project_organization_nodes n ON n.id=g.node_id
      WHERE n.project_id=p.id AND (n.id IN(r.director_id,mgr.id,coder.id) OR n.kind='project_director' AND n.parent_id IS NULL)
      AND g.scope_hash=r.scope_hash AND g.paths=r.scope_paths AND g.parent_id IS NOT DISTINCT FROM n.parent_id)=4
 AND m100.created_at<m101.created_at AND m100.status='completed' AND m101.status='completed' AND m100.calls=1 AND m101.calls=1
 AND m100.project_kind='management' AND m101.project_kind='management' AND m100.deadline=r.cutoff AND m101.deadline=r.cutoff
 AND m100.project_evidence->>'organizationNodeId'=mgr.id::text AND m101.project_evidence->>'organizationNodeId'=mgr.id::text
 AND m100.project_evidence->>'codingCapacityAuthorizationId'=s.authorization_id::text AND m101.project_evidence->>'codingCapacityAuthorizationId'=s.authorization_id::text
 AND j100.status='completed' AND j101.status='completed' AND j100.attempts=1 AND j101.attempts=1
 AND j100.lease IS NULL AND j101.lease IS NULL AND j100.lease_until IS NULL AND j101.lease_until IS NULL
 AND j100.agent_id=mgr.agent_id AND j101.agent_id=mgr.agent_id AND j100.role='work' AND j101.role='work'
 AND (SELECT count(*) FROM mission_assignments WHERE mission_id=m100.id)=1 AND (SELECT count(*) FROM mission_assignments WHERE mission_id=m101.id)=1
 AND (SELECT count(*) FROM project_provider_requests q WHERE q.project_id=p.id AND q.mission_id=m100.id AND q.assignment_id=j100.id AND q.operation='inference' AND q.resolved_at IS NOT NULL AND q.provider_receipt IS NOT NULL)=1
 AND (SELECT count(*) FROM project_provider_requests q WHERE q.project_id=p.id AND q.mission_id=m101.id AND q.assignment_id=j101.id AND q.operation='inference' AND q.resolved_at IS NOT NULL AND q.provider_receipt IS NOT NULL)=1
 AND (SELECT count(*) FROM jsonb_array_elements(d100.decision) c WHERE c->>'action'='appoint')=2
 AND (SELECT count(*) FROM jsonb_array_elements(d100.decision) c JOIN project_organization_nodes w ON w.id IN(coder.id,reviewer.id)
  AND c->>'action'='appoint' AND c->>'kind'='worker' AND c->>'reuseAgentId'=w.agent_id::text
  AND c->>'name'=w.name AND c->>'area'=w.area AND c->>'objective'=w.objective AND c->'acceptance'=w.acceptance
  AND c->'tools'=to_jsonb(w.tools) AND c->'paths'='[]'::jsonb AND (c->>'deadline')::timestamptz=w.deadline
  AND (c->>'tokens')::bigint=w.token_limit)=2
 AND (SELECT count(*) FROM jsonb_array_elements(d101.decision) c WHERE c->>'action'='grant_scope' AND c->>'nodeId'=coder.id::text AND c->'paths'=to_jsonb(r.scope_paths))=1
 );
$$;
REVOKE ALL ON FUNCTION public.project_org_coding_capacity_final_roles_valid(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.project_org_coding_capacity_final_offer(p_owner uuid,p_project uuid,p_release text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p work_projects; a project_provider_execution; g project_retest_production_release_gate;
 r project_coding_capacity_receipts; s project_coding_capacity_resume_receipts; f project_coding_capacity_resume_receipts;
 m agent_missions; j mission_assignments; used integer; spent bigint; providers integer; paid integer; state_hash text; registry jsonb;
BEGIN
 SELECT * INTO p FROM work_projects WHERE id=p_project;
 SELECT * INTO a FROM project_provider_execution WHERE project_id=p_project;
 SELECT * INTO g FROM project_retest_production_release_gate WHERE project_id=p_project;
 SELECT * INTO r FROM project_coding_capacity_receipts WHERE project_id=p_project;
 SELECT * INTO s FROM project_coding_capacity_resume_receipts WHERE project_id=p_project AND historical_missions=99;
 SELECT * INTO f FROM project_coding_capacity_resume_receipts WHERE project_id=p_project AND historical_missions=102;
 IF p.id IS DISTINCT FROM 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
 OR p_owner IS NULL OR a.owner_id IS DISTINCT FROM p_owner OR r.owner_id IS DISTINCT FROM p_owner
 OR s.owner_id IS DISTINCT FROM p_owner OR standalone_verify_scope(p_owner,p.actor_id,p.chat_id) IS DISTINCT FROM true
 OR s.authorization_id IS DISTINCT FROM '0597487f-326d-4951-a727-612be9d772f1'::uuid
 OR s.prior_authorization_id IS DISTINCT FROM r.authorization_id
 OR NOT EXISTS(SELECT 1 FROM project_coding_capacity_resume_receipts predecessor WHERE predecessor.project_id=p.id AND predecessor.historical_missions=98
  AND predecessor.authorization_id=s.supersedes_authorization_id AND predecessor.owner_id=p_owner AND predecessor.scope_hash=s.scope_hash AND predecessor.cutoff=s.cutoff)
 OR s.release_sha IS DISTINCT FROM 'ea3d02049744c56e080c25ef98182dba6f9ebb07'
 OR s.deployment_id IS DISTINCT FROM 'dpl_7mXNM9TW1dSVb7gwiYmuywE2KZaF'
 OR s.release_generation<>45 OR s.approved_max_missions<>102 OR s.prior_max_missions<>101
 OR s.paid_inference_limit<>3 OR s.retry_limit<>0 OR s.scope_hash IS DISTINCT FROM r.scope_hash OR s.cutoff IS DISTINCT FROM r.cutoff OR s.token_allowance<>600000
 OR g.state IS DISTINCT FROM 'active' OR g.alias_name IS DISTINCT FROM 'katie-mu.vercel.app'
 OR g.release_sha IS DISTINCT FROM p_release OR g.release_sha=s.release_sha OR g.deployment_id=s.deployment_id
 OR g.generation IS DISTINCT FROM s.release_generation+2
 THEN RAISE EXCEPTION 'Exact authenticated original owner and corrected Mission102 release required'; END IF;
 SELECT count(*),coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0) INTO used,spent FROM agent_missions WHERE project_id=p.id;
 SELECT count(*),count(*) FILTER(WHERE operation='inference') INTO providers,paid FROM project_provider_requests WHERE project_id=p.id;
 IF f.project_id IS NOT NULL THEN
  IF f.supersedes_authorization_id IS DISTINCT FROM s.authorization_id OR f.release_sha IS DISTINCT FROM g.release_sha
   OR f.release_generation IS DISTINCT FROM g.generation OR f.deployment_id IS DISTINCT FROM g.deployment_id
  THEN RAISE EXCEPTION 'Mission102 receipt belongs to a different release'; END IF;
  RETURN jsonb_build_object('stage','authorized','projectId',p.id,'authorizationId',f.authorization_id,'authorizedAt',f.authorized_at,
   'priorAuthorizationId',f.supersedes_authorization_id,'sourceMissionId',f.source_mission_id,'sourceAssignmentId',f.source_assignment_id,
   'releaseSha',f.release_sha,'releaseGeneration',f.release_generation,'deploymentId',f.deployment_id,'scopeHash',f.scope_hash,
   'paths',r.scope_paths,'cutoff',f.cutoff,'historicalMissions',102,'priorMaxMissions',102,'additionalMissions',1,'maxMissions',103,
   'remainingMissions',greatest(0,103-used),'paidInferenceLimit',1,'retryLimit',0,'tokenAllowance',600000,
   'recordedTokens',f.recorded_tokens,'remainingRecordedTokens',600000-f.recorded_tokens,'nodeCount',15,
   'coderId','08e792df-1046-4282-89dc-83994a8a6b7e','writerId','08e792df-1046-4282-89dc-83994a8a6b7e','reviewerId','1cf12044-d9ba-4e8b-9ef4-8b7e5aa004a5',
   'directorId',r.director_id,'managerId',r.manager_id,'stateHash',f.state_hash,'status',p.status,
   'providerRequestsAtApproval',f.historical_provider_requests,'providerRequestsNow',providers,
   'packageId',(SELECT id FROM project_work_packages WHERE project_id=p.id AND milestone_index=0));
 END IF;
 SELECT * INTO m FROM agent_missions WHERE id='3094d990-a16e-498b-bfb3-1a37245069c7'::uuid AND project_id=p.id;
 SELECT * INTO j FROM mission_assignments WHERE id='51274624-c601-4d66-826e-c635bb026e65'::uuid AND mission_id=m.id;
 IF p.status IS DISTINCT FROM 'blocked' OR p.detail IS DISTINCT FROM 'Commissioning assignment failed; automatic retries are not authorized'
 OR p.phase<>'development' OR p.organization_version<>1 OR p.milestone_index<>0 OR p.max_missions<>102 OR used<>102
 OR p.token_allowance<>600000 OR spent>=600000 OR p.active_mission_id IS DISTINCT FROM m.id
 OR p.lease IS NOT NULL OR p.lease_until IS NOT NULL
 OR p.deadline IS DISTINCT FROM r.cutoff OR p.deadline IS DISTINCT FROM a.deadline OR p.deadline<=clock_timestamp()+interval '5 minutes'
 OR p.approved_hash IS DISTINCT FROM r.scope_hash OR p.approval_hash IS DISTINCT FROM r.scope_hash OR a.approved_scope IS DISTINCT FROM r.scope_hash
 OR p.spec->'allowedPaths' IS DISTINCT FROM to_jsonb(r.scope_paths)
 OR encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex') IS DISTINCT FROM r.objective_hash
 OR encode(sha256(convert_to(project_canonical(p.spec),'UTF8')),'hex') IS DISTINCT FROM r.spec_hash
 OR NOT project_provider_continued(p.id) OR NOT project_org_coding_capacity_final_roles_valid(p.id)
 OR EXISTS(SELECT 1 FROM project_work_packages WHERE project_id=p.id)
 OR NOT EXISTS(SELECT 1 FROM project_organization_nodes WHERE id=r.manager_id AND project_id=p.id AND decision_needed)
 OR EXISTS(SELECT 1 FROM unnest(s.historical_mission_ids) saved(id) WHERE NOT EXISTS(SELECT 1 FROM agent_missions x WHERE x.id=saved.id AND x.project_id=p.id))
 OR EXISTS(SELECT 1 FROM agent_missions x WHERE x.project_id=p.id AND NOT x.id=ANY(s.historical_mission_ids)
  AND x.id NOT IN(m.id,'32cde957-b859-414d-88f0-ab726a238808'::uuid,'06be0829-baf2-4205-8ccd-42def3345c5a'::uuid))
 OR EXISTS(SELECT 1 FROM agent_missions x WHERE x.project_id=p.id AND x.status NOT IN ('completed','blocked','stopped','failed'))
 OR EXISTS(SELECT 1 FROM mission_assignments y JOIN agent_missions x ON x.id=y.mission_id WHERE x.project_id=p.id
  AND (y.lease IS NOT NULL OR y.lease_until IS NOT NULL OR y.status NOT IN ('completed','failed','blocked','stopped','cancelled','canceled')))
 OR project_provider_request_pending(p.id)
 OR (SELECT count(*) FROM project_provider_requests q WHERE q.project_id=p.id AND q.operation='inference' AND NOT q.mission_id=ANY(s.historical_mission_ids))<>3
 OR m.id IS NULL OR j.id IS NULL OR m.status<>'blocked' OR m.calls<>1 OR m.project_kind<>'management'
 OR m.project_evidence->>'organizationNodeId' IS DISTINCT FROM r.manager_id::text
 OR m.project_evidence->>'codingCapacityAuthorizationId' IS DISTINCT FROM s.authorization_id::text
 OR m.project_evidence->>'previousMissionId' IS NOT NULL OR m.deadline IS DISTINCT FROM r.cutoff
 OR j.status<>'failed' OR j.attempts<>1 OR j.role<>'work' OR j.job_key<>'plan'
 OR j.payload->>'organizationNodeId' IS DISTINCT FROM r.manager_id::text
 OR j.detail IS DISTINCT FROM 'Mission state operation failed: {"code":"P0001","details":null,"hint":null,"message":"Package must use newly authorized direct implementation workers"}'
 OR j.result->>'detail' IS DISTINCT FROM j.detail OR m.detail IS DISTINCT FROM j.detail
 OR EXISTS(SELECT 1 FROM project_organization_decisions WHERE assignment_id=j.id)
 OR (SELECT count(*) FROM mission_assignments WHERE mission_id=m.id)<>1
 OR NOT EXISTS(SELECT 1 FROM project_organization_assignments b JOIN project_organization_nodes n ON n.id=b.node_id
   WHERE b.assignment_id=j.id AND b.node_id=r.manager_id AND n.agent_id=j.agent_id
    AND b.contract_hash=encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex'))
 OR NOT EXISTS(SELECT 1 FROM project_provider_requests q WHERE q.project_id=p.id AND q.mission_id=m.id AND q.assignment_id=j.id
   AND q.operation='inference' AND q.resolved_at IS NOT NULL AND q.provider_receipt IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM project_events closed
  JOIN project_events opened ON opened.project_id=closed.project_id AND opened.event='mission79_release_gate_transition'
  WHERE closed.project_id=p.id AND closed.event='mission79_release_gate_transition'
   AND closed.data->>'action'='closed' AND closed.data->>'releaseSha'=s.release_sha AND closed.data->>'deploymentId'=s.deployment_id
   AND closed.data->>'alias'='katie-mu.vercel.app' AND closed.data->>'priorGeneration'=s.release_generation::text
   AND (closed.data->>'recordedAt')::timestamptz>=s.authorized_at
   AND opened.data->>'action'='active' AND opened.data->>'releaseSha'=g.release_sha AND opened.data->>'deploymentId'=g.deployment_id
   AND opened.data->>'alias'='katie-mu.vercel.app' AND opened.data->>'priorGeneration'=(s.release_generation+1)::text
   AND (opened.data->>'recordedAt')::timestamptz=g.updated_at
   AND (opened.data->>'recordedAt')::timestamptz>(closed.data->>'recordedAt')::timestamptz)
 THEN RAISE EXCEPTION 'Exact failed Mission102 package baseline no longer eligible'; END IF;
 SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) INTO registry FROM managed_agents x WHERE x.id=ANY(p.team);
 state_hash:=encode(sha256(convert_to(project_canonical(jsonb_build_object(
 'initialReceipt',to_jsonb(r),'priorReceipt',to_jsonb(s),'state',project_org_coding_capacity_state(p.id),'executionTeam',registry)),'UTF8')),'hex');
 RETURN jsonb_build_object('stage','authorize','projectId',p.id,'authorizationId',null,
  'priorAuthorizationId',s.authorization_id,'sourceMissionId',m.id,'sourceAssignmentId',j.id,'failure',j.detail,
  'releaseSha',g.release_sha,'releaseGeneration',g.generation,'deploymentId',g.deployment_id,'scopeHash',r.scope_hash,
  'paths',r.scope_paths,'cutoff',r.cutoff,'historicalMissions',102,'priorMaxMissions',102,'remainingMissions',0,
  'minAdditionalMissions',1,'recommendedAdditionalMissions',1,'maxAdditionalMissions',1,
  'additionalMissions',1,'maxMissions',103,'paidInferenceLimit',1,'retryLimit',0,'tokenAllowance',600000,
  'recordedTokens',spent,'remainingRecordedTokens',600000-spent,'nodeCount',15,
  'coderId','08e792df-1046-4282-89dc-83994a8a6b7e','writerId','08e792df-1046-4282-89dc-83994a8a6b7e','reviewerId','1cf12044-d9ba-4e8b-9ef4-8b7e5aa004a5',
  'directorId',r.director_id,'managerId',r.manager_id,'providerRequestsAtApproval',providers,'historicalInferenceRequests',paid,'stateHash',state_hash,'status',p.status);
END
$$;
REVOKE ALL ON FUNCTION public.project_org_coding_capacity_final_offer(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

-- Reuse the existing owner writer and effective release-bound authority.
-- The only command guard change tightens the FINAL receipt to one package,
-- with the exact persisted roles. All prior validators remain in place.
DO $patch$
DECLARE k record; b text; a text; t text;
BEGIN
 FOR k IN SELECT * FROM (VALUES
 ('public.project_org_coding_capacity_identity_offer(uuid,uuid,text)','d7cdfe16119c3717c643c4d8ee6e988d'),
 ('public.project_org_coding_capacity_resume_authorize(uuid,uuid,text,bigint,text,uuid,text,text,timestamptz,integer,integer,integer,integer,integer,bigint,uuid,uuid,uuid)','6f2f46b82c1cbd2aaf18849d3504bac8'),
 ('public.project_org_coding_capacity_resource_guard()','977ea9b2501e1b45969d02da828968bd'),
 ('public.project_org_coding_capacity_commands(uuid,uuid,jsonb)','8bafe719d4a9005451ebf05314d570ff'),
 ('public.project_org_coding_capacity_live(uuid)','1649593959cf00f7918e977ae499144e')
 ) x(sig,expected) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=k.sig::regprocedure) IS DISTINCT FROM k.expected
  THEN RAISE EXCEPTION 'Unexpected installed Mission102 continuation preimage: %',k.sig; END IF;
  b:=pg_get_functiondef(k.sig::regprocedure);
  IF k.sig LIKE 'public.project_org_coding_capacity_identity_offer(%' THEN
   a:=$old$ SELECT * INTO f FROM project_coding_capacity_resume_receipts WHERE project_id=p_project AND historical_missions=99;$old$;
   t:=a||$new$
 IF f.project_id IS NOT NULL AND (f.release_sha IS DISTINCT FROM p_release OR EXISTS(
   SELECT 1 FROM project_coding_capacity_resume_receipts WHERE project_id=p_project AND historical_missions=102)) THEN
  RETURN project_org_coding_capacity_final_offer(p_owner,p_project,p_release);
 END IF;$new$;
   IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected final offer anchor'; END IF;
   b:=replace(b,a,t);
  ELSIF k.sig LIKE 'public.project_org_coding_capacity_resume_authorize(%' THEN
   FOR a,t IN SELECT * FROM (VALUES
    ($old$OR p_additional IS DISTINCT FROM 3 OR (o->>'historicalMissions')::integer NOT IN (98,99)
 OR p_max IS DISTINCT FROM ((o->>'historicalMissions')::integer+3) OR p_paid_limit IS DISTINCT FROM 3$old$,
     $new$OR (o->>'historicalMissions')::integer NOT IN (98,99,102)
 OR p_additional IS DISTINCT FROM CASE WHEN (o->>'historicalMissions')::integer=102 THEN 1 ELSE 3 END
 OR p_max IS DISTINCT FROM ((o->>'historicalMissions')::integer+p_additional) OR p_paid_limit IS DISTINCT FROM p_additional$new$),
    ($old$VALUES(p.id,p_authorization,CASE WHEN (o->>'historicalMissions')::integer=99 THEN$old$,
     $new$VALUES(p.id,p_authorization,CASE WHEN (o->>'historicalMissions')::integer IN (99,102) THEN$new$),
    ($old$(o->>'priorMaxMissions')::integer,3,p_max,3,0,600000,$old$,$new$(o->>'priorMaxMissions')::integer,p_additional,p_max,p_paid_limit,0,600000,$new$),
    ($old$CASE WHEN (o->>'historicalMissions')::integer=99 THEN p_prior_authorization ELSE NULL END);$old$,
     $new$CASE WHEN (o->>'historicalMissions')::integer IN (99,102) THEN p_prior_authorization ELSE NULL END);$new$),
    ($old$', at most three fresh paid management calls, zero retries, no token, scope or deadline increase.'$old$,
     $new$', at most '||p_paid_limit||' fresh paid management calls, zero retries, no token, scope or deadline increase.'$new$),
    ($old$'maxMissions',p_max,'paidInferenceLimit',3,'retryLimit',0,$old$,
     $new$'maxMissions',p_max,'paidInferenceLimit',p_paid_limit,'retryLimit',0,$new$)
   ) patch(old_text,new_text) LOOP
    IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected final owner writer anchor: %',a; END IF;
    b:=replace(b,a,t);
   END LOOP;
  ELSIF k.sig='public.project_org_coding_capacity_resource_guard()' THEN
   a:=$old$ THEN RAISE EXCEPTION 'Original commissioning resources require the exact one-time owner receipt'; END IF;$old$;
   t:=$new$ AND NOT (OLD.max_missions=102 AND NEW.max_missions=103 AND OLD.status='blocked'
  AND NEW.token_allowance=OLD.token_allowance AND NEW.deadline=OLD.deadline
  AND EXISTS(SELECT 1 FROM project_coding_capacity_resume_receipts s WHERE s.project_id=OLD.id
   AND s.historical_missions=102 AND s.authorization_txid=txid_current() AND s.source_mission_id=OLD.active_mission_id
   AND s.prior_max_missions=OLD.max_missions AND s.approved_max_missions=NEW.max_missions))
 THEN RAISE EXCEPTION 'Original commissioning resources require the exact one-time owner receipt'; END IF;$new$;
   IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected final resource guard anchor'; END IF;
   b:=replace(b,a,t);
  ELSIF k.sig='public.project_org_coding_capacity_commands(uuid,uuid,jsonb)' THEN
   a:=$old$ IF actions=0 THEN RAISE EXCEPTION 'Commissioning requires a substantive implementation decision'; END IF;$old$;
   t:=a||$new$
 IF r.historical_missions=102 AND (n IS DISTINCT FROM r.manager_id OR actions<>1
  OR jsonb_array_length(p_commands)>2 OR NOT project_org_coding_capacity_final_roles_valid(r.project_id)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_commands) c WHERE c->>'action' IS DISTINCT FROM 'ready'
   AND (c->>'action' IS DISTINCT FROM 'commission_package' OR c->'milestoneIndex' IS DISTINCT FROM '0'::jsonb
    OR c->>'workerId' IS DISTINCT FROM '08e792df-1046-4282-89dc-83994a8a6b7e'
    OR c->>'writerId' IS DISTINCT FROM '08e792df-1046-4282-89dc-83994a8a6b7e'
    OR c->>'reviewerId' IS DISTINCT FROM '1cf12044-d9ba-4e8b-9ef4-8b7e5aa004a5')))
 THEN RAISE EXCEPTION 'Final signed commissioning permits only the existing authorized coder, writer and reviewer package'; END IF;$new$;
   IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected final command guard anchor'; END IF;
   b:=replace(b,a,t);
  ELSE
   a:=$old$   AND NOT EXISTS(SELECT 1 FROM project_work_packages WHERE project_id=p.id)$old$;
   t:=a||$new$
   AND (r.historical_missions<>102 OR project_org_coding_capacity_final_roles_valid(p.id))$new$;
   IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected final live guard anchor'; END IF;
   b:=replace(b,a,t);
  END IF;
  EXECUTE b;
 END LOOP;
END
$patch$;
COMMIT;

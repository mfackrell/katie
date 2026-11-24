-- Extend the EXISTING immutable commissioning successor ledger by exactly one
-- M99-specific stage. The original and M98 receipts are never updated/deleted.
-- Installation performs no project state mutation, worker creation or inference.
BEGIN;
ALTER TABLE public.project_coding_capacity_resume_receipts
 ADD COLUMN supersedes_authorization_id uuid,
 DROP CONSTRAINT project_coding_capacity_resume_receipts_pkey,
 DROP CONSTRAINT project_coding_capacity_resume_recei_prior_authorization_id_key,
 DROP CONSTRAINT project_coding_capacity_resume_rec_historical_mission_ids_check,
 DROP CONSTRAINT project_coding_capacity_resume_rece_approved_max_missions_check,
 DROP CONSTRAINT project_coding_capacity_resume_receip_historical_missions_check,
 DROP CONSTRAINT project_coding_capacity_resume_receipt_prior_max_missions_check,
 ADD PRIMARY KEY(project_id,historical_missions),
 ADD UNIQUE(project_id,authorization_id),
 ADD UNIQUE(supersedes_authorization_id),
 ADD FOREIGN KEY(project_id,supersedes_authorization_id)
  REFERENCES public.project_coding_capacity_resume_receipts(project_id,authorization_id),
 ADD CHECK(historical_missions IN (98,99) AND cardinality(historical_mission_ids)=historical_missions),
 ADD CHECK(approved_max_missions=historical_missions+3),
 ADD CHECK((historical_missions=98 AND prior_max_missions=100 AND supersedes_authorization_id IS NULL)
  OR (historical_missions=99 AND prior_max_missions=101 AND supersedes_authorization_id IS NOT NULL
    AND supersedes_authorization_id<>authorization_id));
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
   AND predecessor.approved_max_missions=s.prior_max_missions AND predecessor.release_generation+2=s.release_generation)))
 ORDER BY s.historical_missions DESC LIMIT 1
 ) s ON true;

REVOKE ALL ON public.project_coding_capacity_authority FROM PUBLIC,anon,authenticated,service_role;

-- Exact original failed M99 binding, with original team registry and no
-- outstanding lease, pending provider request, package or new worker.
CREATE FUNCTION public.project_org_coding_capacity_identity_offer(p_owner uuid,p_project uuid,p_release text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p work_projects; a project_provider_execution; g project_retest_production_release_gate;
 r project_coding_capacity_receipts; s project_coding_capacity_resume_receipts; f project_coding_capacity_resume_receipts;
 m agent_missions; j mission_assignments; used integer; spent bigint; providers integer; paid integer;
 state_hash text; registry jsonb;
BEGIN
 SELECT * INTO p FROM work_projects WHERE id=p_project;
 SELECT * INTO a FROM project_provider_execution WHERE project_id=p_project;
 SELECT * INTO g FROM project_retest_production_release_gate WHERE project_id=p_project;
 SELECT * INTO r FROM project_coding_capacity_receipts WHERE project_id=p_project;
 SELECT * INTO s FROM project_coding_capacity_resume_receipts WHERE project_id=p_project AND historical_missions=98;
 SELECT * INTO f FROM project_coding_capacity_resume_receipts WHERE project_id=p_project AND historical_missions=99;
 IF p.id IS DISTINCT FROM 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
 OR p_owner IS NULL OR a.owner_id IS DISTINCT FROM p_owner OR r.owner_id IS DISTINCT FROM p_owner
 OR s.owner_id IS DISTINCT FROM p_owner OR standalone_verify_scope(p_owner,p.actor_id,p.chat_id) IS DISTINCT FROM true
 OR s.authorization_id IS DISTINCT FROM 'dcbfc493-6311-44eb-af33-bcba213c3d64'::uuid
 OR s.prior_authorization_id IS DISTINCT FROM r.authorization_id
 OR s.release_sha IS DISTINCT FROM 'b3094d37a99ebe4b9a0cc9e86ef2f35515b655f8'
 OR s.deployment_id IS DISTINCT FROM 'dpl_CsCXnyzKQbLkYYD7WGbMLr51ihej'
 OR s.release_generation<>43 OR s.approved_max_missions<>101 OR s.prior_max_missions<>100
 OR s.paid_inference_limit<>3 OR s.retry_limit<>0 OR s.scope_hash IS DISTINCT FROM r.scope_hash
 OR s.cutoff IS DISTINCT FROM r.cutoff OR s.token_allowance<>600000
 OR g.state IS DISTINCT FROM 'active' OR g.alias_name IS DISTINCT FROM 'katie-mu.vercel.app'
 OR g.release_sha IS DISTINCT FROM p_release OR g.release_sha=s.release_sha OR g.deployment_id=s.deployment_id
 OR g.generation IS DISTINCT FROM s.release_generation+2
 THEN RAISE EXCEPTION 'Exact authenticated original owner and corrected Mission99 release required'; END IF;
 SELECT count(*),coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0)
 INTO used,spent FROM agent_missions WHERE project_id=p.id;
 SELECT count(*),count(*) FILTER(WHERE operation='inference') INTO providers,paid FROM project_provider_requests WHERE project_id=p.id;
 IF f.project_id IS NOT NULL THEN
  IF f.supersedes_authorization_id IS DISTINCT FROM s.authorization_id OR f.release_sha IS DISTINCT FROM g.release_sha
   OR f.release_generation IS DISTINCT FROM g.generation OR f.deployment_id IS DISTINCT FROM g.deployment_id
  THEN RAISE EXCEPTION 'Mission99 receipt belongs to a different release'; END IF;
  RETURN jsonb_build_object('stage','authorized','projectId',p.id,'authorizationId',f.authorization_id,'authorizedAt',f.authorized_at,
   'priorAuthorizationId',f.supersedes_authorization_id,'sourceMissionId',f.source_mission_id,'sourceAssignmentId',f.source_assignment_id,
   'releaseSha',f.release_sha,'releaseGeneration',f.release_generation,'deploymentId',f.deployment_id,'scopeHash',f.scope_hash,
   'paths',r.scope_paths,'cutoff',f.cutoff,'historicalMissions',99,'priorMaxMissions',101,'additionalMissions',3,'maxMissions',102,
   'remainingMissions',greatest(0,102-used),'paidInferenceLimit',3,'retryLimit',0,'tokenAllowance',600000,
   'recordedTokens',f.recorded_tokens,'remainingRecordedTokens',600000-f.recorded_tokens,'nodeCount',13,
   'directorId',r.director_id,'managerId',r.manager_id,'stateHash',f.state_hash,'status',p.status,
   'providerRequestsAtApproval',f.historical_provider_requests,'providerRequestsNow',providers,
   'packageId',(SELECT id FROM project_work_packages WHERE project_id=p.id AND milestone_index=0));
 END IF;
 SELECT * INTO m FROM agent_missions WHERE id='43af2c7c-0b7c-48e6-a247-016e599f3349'::uuid AND project_id=p.id;
 SELECT * INTO j FROM mission_assignments WHERE id='fb7c3e64-64ba-4612-9bba-a4084c11aafe'::uuid AND mission_id=m.id;
 IF p.status IS DISTINCT FROM 'blocked' OR p.detail IS DISTINCT FROM 'Commissioning assignment failed; automatic retries are not authorized'
 OR p.phase<>'development' OR p.organization_version<>1 OR p.milestone_index<>0 OR p.max_missions<>101 OR used<>99
 OR p.token_allowance<>600000 OR spent>=600000 OR p.active_mission_id IS DISTINCT FROM m.id
 OR p.lease IS NOT NULL OR p.lease_until IS NOT NULL
 OR p.deadline IS DISTINCT FROM r.cutoff OR p.deadline IS DISTINCT FROM a.deadline OR p.deadline<=clock_timestamp()+interval '5 minutes'
 OR p.approved_hash IS DISTINCT FROM r.scope_hash OR p.approval_hash IS DISTINCT FROM r.scope_hash OR a.approved_scope IS DISTINCT FROM r.scope_hash
 OR p.spec->'allowedPaths' IS DISTINCT FROM to_jsonb(r.scope_paths)
 OR encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex') IS DISTINCT FROM r.objective_hash
 OR encode(sha256(convert_to(project_canonical(p.spec),'UTF8')),'hex') IS DISTINCT FROM r.spec_hash
 OR NOT project_provider_continued(p.id) OR NOT project_org_retest_original_owner_lineage(p.id) OR NOT project_org_retest_exact_scope_grants(p.id)
 OR (SELECT array_agg(id ORDER BY id) FROM project_organization_nodes WHERE project_id=p.id) IS DISTINCT FROM r.original_node_ids
 OR EXISTS(SELECT 1 FROM project_organization_nodes WHERE project_id=p.id AND kind='worker' AND 'development'=ANY(tools))
 OR EXISTS(SELECT 1 FROM project_work_packages WHERE project_id=p.id)
 OR NOT EXISTS(SELECT 1 FROM project_organization_nodes n JOIN project_organization_nodes d ON d.id=n.parent_id
  WHERE n.id=r.manager_id AND d.id=r.director_id AND n.project_id=p.id AND d.project_id=p.id
   AND n.kind='manager' AND n.management_level='manager' AND n.status='active' AND n.decision_needed
   AND 'development'=ANY(n.tools) AND d.status='active' AND NOT d.decision_needed AND 'development'=ANY(d.tools)
   AND project_org_dependencies_ready(n.id))
 OR EXISTS(SELECT 1 FROM unnest(s.historical_mission_ids) saved(id) WHERE NOT EXISTS(SELECT 1 FROM agent_missions x WHERE x.id=saved.id AND x.project_id=p.id))
 OR EXISTS(SELECT 1 FROM agent_missions x WHERE x.project_id=p.id AND NOT x.id=ANY(s.historical_mission_ids) AND x.id<>m.id)
 OR EXISTS(SELECT 1 FROM agent_missions x WHERE x.project_id=p.id AND x.status NOT IN ('completed','blocked','stopped','failed'))
 OR EXISTS(SELECT 1 FROM mission_assignments y JOIN agent_missions x ON x.id=y.mission_id WHERE x.project_id=p.id
  AND (y.lease IS NOT NULL OR y.lease_until IS NOT NULL OR y.status NOT IN ('completed','failed','blocked','stopped','cancelled','canceled')))
 OR project_provider_request_pending(p.id)
 OR (SELECT count(*) FROM project_provider_requests q WHERE q.project_id=p.id AND q.operation='inference' AND NOT q.mission_id=ANY(s.historical_mission_ids))<>1
 OR m.id IS NULL OR j.id IS NULL OR m.status<>'blocked' OR m.calls<>1 OR m.project_kind<>'management'
 OR m.project_evidence->>'organizationNodeId' IS DISTINCT FROM r.manager_id::text
 OR m.project_evidence->>'codingCapacityAuthorizationId' IS DISTINCT FROM s.authorization_id::text
 OR m.project_evidence->>'previousMissionId' IS NOT NULL OR m.deadline IS DISTINCT FROM r.cutoff
 OR j.status<>'failed' OR j.attempts<>1 OR j.role<>'work' OR j.job_key<>'plan'
 OR j.payload->>'organizationNodeId' IS DISTINCT FROM r.manager_id::text
 OR j.detail IS DISTINCT FROM 'Mission state operation failed: {"code":"23505","details":"Key (project_id, agent_id)=(fe9d2658-41e3-44c1-ae8e-a0cba98371fe, 0c491807-490a-4bfb-a56b-115d4dece4bf) already exists.","hint":null,"message":"duplicate key value violates unique constraint \"project_organization_nodes_project_id_agent_id_key\""}'
 OR j.result->>'detail' IS DISTINCT FROM j.detail OR m.detail IS DISTINCT FROM j.detail
 OR EXISTS(SELECT 1 FROM project_organization_decisions WHERE assignment_id=j.id)
 OR (SELECT count(*) FROM mission_assignments WHERE mission_id=m.id)<>1
 OR NOT EXISTS(SELECT 1 FROM project_organization_assignments b JOIN project_organization_nodes n ON n.id=b.node_id
   WHERE b.assignment_id=j.id AND b.node_id=r.manager_id AND n.agent_id=j.agent_id
    AND b.contract_hash=encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex'))
 OR NOT EXISTS(SELECT 1 FROM project_provider_requests q WHERE q.project_id=p.id AND q.mission_id=m.id AND q.assignment_id=j.id
   AND q.operation='inference' AND q.resolved_at IS NOT NULL AND q.provider_receipt IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM project_organization_nodes n WHERE n.project_id=p.id AND n.parent_id=r.manager_id
  AND n.kind='worker' AND n.area='delivery_repository_assessment' AND n.agent_id='0c491807-490a-4bfb-a56b-115d4dece4bf'::uuid
  AND NOT 'development'=ANY(n.tools))
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
 THEN RAISE EXCEPTION 'Exact failed Mission99 commissioning baseline no longer eligible'; END IF;
 -- The original execution team is unchanged. General analysis is available
 -- for a valid registered agent; development requires an explicit true flag.
 -- An archived, occupied or missing identity is not a valid candidate.
 IF cardinality(p.team)<>3 OR NOT p.team @> ARRAY['0c491807-490a-4bfb-a56b-115d4dece4bf'::uuid,
  '8421786a-0874-4d86-992e-f0f087d8018e'::uuid,'e7d25ada-a761-41bf-8f65-f87056f175fa'::uuid]
 OR NOT EXISTS(SELECT 1 FROM managed_agents x JOIN managed_agents y ON y.id<>x.id
   WHERE x.id=ANY(p.team) AND y.id=ANY(p.team) AND NOT x.archived AND NOT y.archived
    AND x.config->'development'='true'::jsonb AND jsonb_typeof(y.config->'development')='boolean'
    AND jsonb_typeof(x.config->'research')='boolean' AND jsonb_typeof(y.config->'research')='boolean'
    AND x.config->>'reviewMode' IN ('always','adaptive') AND y.config->>'reviewMode' IN ('always','adaptive')
    AND NOT EXISTS(SELECT 1 FROM project_organization_nodes n WHERE n.project_id=p.id AND n.agent_id IN(x.id,y.id)))
 THEN RAISE EXCEPTION 'Commissioning resource constraint: original registered coder and distinct analysis reviewer unavailable'; END IF;
 SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) INTO registry FROM managed_agents x WHERE x.id=ANY(p.team);
 state_hash:=encode(sha256(convert_to(project_canonical(jsonb_build_object(
  'initialReceipt',to_jsonb(r),'priorReceipt',to_jsonb(s),'state',project_org_coding_capacity_state(p.id),'executionTeam',registry)),'UTF8')),'hex');
 RETURN jsonb_build_object('stage','authorize','projectId',p.id,'authorizationId',null,
  'priorAuthorizationId',s.authorization_id,'sourceMissionId',m.id,'sourceAssignmentId',j.id,'failure',j.detail,
  'releaseSha',g.release_sha,'releaseGeneration',g.generation,'deploymentId',g.deployment_id,'scopeHash',r.scope_hash,
  'paths',r.scope_paths,'cutoff',r.cutoff,'historicalMissions',99,'priorMaxMissions',101,'remainingMissions',2,
  'minAdditionalMissions',3,'recommendedAdditionalMissions',3,'maxAdditionalMissions',3,
  'additionalMissions',3,'maxMissions',102,'paidInferenceLimit',3,'retryLimit',0,'tokenAllowance',600000,
  'recordedTokens',spent,'remainingRecordedTokens',600000-spent,'nodeCount',13,'directorId',r.director_id,'managerId',r.manager_id,
  'providerRequestsAtApproval',providers,'historicalInferenceRequests',paid,'stateHash',state_hash,'status',p.status);
END
$$;
REVOKE ALL ON FUNCTION public.project_org_coding_capacity_identity_offer(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

-- Reuse the exact existing offer, owner writer, immutable receipt and effective
-- authority. Do not modify scheduler, provider dispatch, SMART or hierarchy.
DO $patch$
DECLARE k record; b text; a text; t text;
BEGIN
 FOR k IN SELECT * FROM (VALUES
 ('public.project_org_coding_capacity_resume_offer(uuid,uuid,text)','f5ad7f41630ee6dd79eb433d33e7d6f9'),
 ('public.project_org_coding_capacity_resume_authorize(uuid,uuid,text,bigint,text,uuid,text,text,timestamptz,integer,integer,integer,integer,integer,bigint,uuid,uuid,uuid)','d79956cac80092b63ab09d828d6023a1'),
 ('public.project_org_coding_capacity_resource_guard()','6f9e59e0fe33bcbf77cd1cf876a2b2a4')
 ) x(sig,expected) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=k.sig::regprocedure) IS DISTINCT FROM k.expected
  THEN RAISE EXCEPTION 'Unexpected installed Mission99 continuation preimage: %',k.sig; END IF;
  b:=pg_get_functiondef(k.sig::regprocedure);
  IF k.sig LIKE 'public.project_org_coding_capacity_resume_offer(%' THEN
   a:=$old$ SELECT * INTO s FROM project_coding_capacity_resume_receipts WHERE project_id=p_project;$old$;
   t:=$new$ SELECT * INTO s FROM project_coding_capacity_resume_receipts WHERE project_id=p_project AND historical_missions=98;
 IF s.project_id IS NOT NULL AND (s.release_sha IS DISTINCT FROM p_release OR EXISTS(
   SELECT 1 FROM project_coding_capacity_resume_receipts WHERE project_id=p_project AND historical_missions=99)) THEN
  RETURN project_org_coding_capacity_identity_offer(p_owner,p_project,p_release);
 END IF;$new$;
   IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected successor offer anchor'; END IF;
   b:=replace(b,a,t);
  ELSIF k.sig LIKE 'public.project_org_coding_capacity_resume_authorize(%' THEN
   FOR a,t IN SELECT * FROM (VALUES
    ($old$OR p_additional IS DISTINCT FROM 3 OR p_max IS DISTINCT FROM 101 OR p_paid_limit IS DISTINCT FROM 3$old$,
     $new$OR p_additional IS DISTINCT FROM 3 OR (o->>'historicalMissions')::integer NOT IN (98,99)
 OR p_max IS DISTINCT FROM ((o->>'historicalMissions')::integer+3) OR p_paid_limit IS DISTINCT FROM 3
 OR EXISTS(SELECT 1 FROM project_coding_capacity_receipts WHERE authorization_id=p_authorization)$new$),
    ($old$historical_provider_requests,state_hash,authorized_at)
 VALUES(p.id,p_authorization,p_prior_authorization,p_owner,p_source_mission,p_source_assignment,p_release,p_generation,p_deployment,
  p_scope,p_cutoff,98,ARRAY(SELECT id FROM agent_missions WHERE project_id=p.id ORDER BY id),100,3,101,3,0,600000,
  (o->>'recordedTokens')::bigint,(o->>'providerRequestsAtApproval')::integer,p_state_hash,stamp);$old$,
     $new$historical_provider_requests,state_hash,authorized_at,supersedes_authorization_id)
 VALUES(p.id,p_authorization,CASE WHEN (o->>'historicalMissions')::integer=99 THEN
   (SELECT authorization_id FROM project_coding_capacity_receipts WHERE project_id=p.id) ELSE p_prior_authorization END,
  p_owner,p_source_mission,p_source_assignment,p_release,p_generation,p_deployment,
  p_scope,p_cutoff,(o->>'historicalMissions')::integer,ARRAY(SELECT id FROM agent_missions WHERE project_id=p.id ORDER BY id),
  (o->>'priorMaxMissions')::integer,3,p_max,3,0,600000,
  (o->>'recordedTokens')::bigint,(o->>'providerRequestsAtApproval')::integer,p_state_hash,stamp,
  CASE WHEN (o->>'historicalMissions')::integer=99 THEN p_prior_authorization ELSE NULL END);$new$),
    ($old$600000,NULL,101,NULL,p_authorization,$old$,$new$600000,NULL,p_max,NULL,p_authorization,$new$),
    ($old$'Authenticated owner Mission98 commissioning continuation on '||p_release||'; 98 preserved missions, ceiling 101, exactly three fresh paid management calls at most, zero retries and no token, scope or deadline increase.'$old$,
     $new$'Authenticated owner Mission'||(o->>'historicalMissions')||' commissioning continuation on '||p_release||'; '||(o->>'historicalMissions')||' preserved missions, ceiling '||p_max||', at most three fresh paid management calls, zero retries, no token, scope or deadline increase.'$new$),
    ($old$detail='Owner-authorized Mission98 continuation; awaiting normal scheduler',$old$,
     $new$detail='Owner-authorized Mission'||(o->>'historicalMissions')||' continuation; awaiting normal scheduler',$new$),
    ($old$active_mission_id=p_source_mission AND max_missions=101;$old$,
     $new$active_mission_id=p_source_mission AND max_missions=p_max;$new$),
    ($old$'historicalMissions',98,'priorMaxMissions',100,'maxMissions',101,$old$,
     $new$'historicalMissions',(o->>'historicalMissions')::integer,'priorMaxMissions',(o->>'priorMaxMissions')::integer,'maxMissions',p_max,$new$)
   ) patch(old_text,new_text) LOOP
    IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected owner writer anchor: %',a; END IF;
    b:=replace(b,a,t);
   END LOOP;
  ELSE
   a:=$old$   AND s.prior_max_missions=OLD.max_missions AND s.approved_max_missions=NEW.max_missions))$old$;
   t:=a||$new$
 AND NOT (OLD.max_missions=101 AND NEW.max_missions=102 AND OLD.status='blocked'
  AND NEW.token_allowance=OLD.token_allowance AND NEW.deadline=OLD.deadline
  AND EXISTS(SELECT 1 FROM project_coding_capacity_resume_receipts s WHERE s.project_id=OLD.id
   AND s.historical_missions=99 AND s.authorization_txid=txid_current() AND s.source_mission_id=OLD.active_mission_id
   AND s.prior_max_missions=OLD.max_missions AND s.approved_max_missions=NEW.max_missions))$new$;
   IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected Mission99 resource guard anchor'; END IF;
   b:=replace(b,a,t);
  END IF;
  EXECUTE b;
 END LOOP;
END
$patch$;
COMMIT;

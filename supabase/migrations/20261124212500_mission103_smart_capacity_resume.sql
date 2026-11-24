-- One final SMART-capacity successor of the existing immutable owner receipt.
-- No original mission, worker, contract, grant, capacity or paid execution
-- is changed by installation. Existing SQL SMART/package validators remain.
BEGIN;
ALTER TABLE public.project_coding_capacity_resume_receipts
 DROP CONSTRAINT project_coding_capacity_resume_receipts_check1,
 DROP CONSTRAINT project_coding_capacity_resume_receipts_check4,
 ADD CHECK(historical_missions IN (98,99,102,103) AND cardinality(historical_mission_ids)=historical_missions),
 ADD CHECK((historical_missions=98 AND prior_max_missions=100 AND additional_missions=3 AND supersedes_authorization_id IS NULL)
 OR (historical_missions=99 AND prior_max_missions=101 AND additional_missions=3 AND supersedes_authorization_id IS NOT NULL AND supersedes_authorization_id<>authorization_id)
 OR (historical_missions=102 AND prior_max_missions=102 AND additional_missions=1 AND supersedes_authorization_id IS NOT NULL AND supersedes_authorization_id<>authorization_id)
 OR (historical_missions=103 AND prior_max_missions=103 AND additional_missions=1 AND supersedes_authorization_id IS NOT NULL AND supersedes_authorization_id<>authorization_id));
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
   AND predecessor.approved_max_missions=s.prior_max_missions AND predecessor.release_generation+2=s.release_generation))
 OR (s.historical_missions=103 AND EXISTS(
  SELECT 1 FROM public.project_coding_capacity_resume_receipts predecessor
  JOIN public.project_coding_capacity_resume_receipts older ON older.project_id=predecessor.project_id
   AND older.historical_missions=99 AND older.authorization_id=predecessor.supersedes_authorization_id
  JOIN public.project_coding_capacity_resume_receipts first ON first.project_id=older.project_id
   AND first.historical_missions=98 AND first.authorization_id=older.supersedes_authorization_id
  WHERE predecessor.project_id=s.project_id AND predecessor.historical_missions=102
   AND predecessor.authorization_id=s.supersedes_authorization_id AND predecessor.prior_authorization_id=r.authorization_id
   AND predecessor.owner_id=s.owner_id AND predecessor.scope_hash=s.scope_hash AND predecessor.cutoff=s.cutoff
   AND predecessor.approved_max_missions=s.prior_max_missions AND predecessor.release_generation+2=s.release_generation)))
 ORDER BY s.historical_missions DESC LIMIT 1
 ) s ON true;



REVOKE ALL ON public.project_coding_capacity_authority FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.project_org_coding_capacity_smart_offer(p_owner uuid,p_project uuid,p_release text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p work_projects; a project_provider_execution; g project_retest_production_release_gate;
 r project_coding_capacity_receipts; s project_coding_capacity_resume_receipts; f project_coding_capacity_resume_receipts;
 m agent_missions; j mission_assignments; used integer; spent bigint; providers integer; paid integer; state_hash text; registry jsonb;
BEGIN
 SELECT * INTO p FROM work_projects WHERE id=p_project;
 SELECT * INTO a FROM project_provider_execution WHERE project_id=p_project;
 SELECT * INTO g FROM project_retest_production_release_gate WHERE project_id=p_project;
 SELECT * INTO r FROM project_coding_capacity_receipts WHERE project_id=p_project;
 SELECT * INTO s FROM project_coding_capacity_resume_receipts WHERE project_id=p_project AND historical_missions=102;
 SELECT * INTO f FROM project_coding_capacity_resume_receipts WHERE project_id=p_project AND historical_missions=103;
 IF p.id IS DISTINCT FROM 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
 OR p_owner IS NULL OR a.owner_id IS DISTINCT FROM p_owner OR r.owner_id IS DISTINCT FROM p_owner
 OR s.owner_id IS DISTINCT FROM p_owner OR standalone_verify_scope(p_owner,p.actor_id,p.chat_id) IS DISTINCT FROM true
 OR s.authorization_id IS DISTINCT FROM 'f83c4eb4-48c0-4cc8-b9b6-a1862f7b8f93'::uuid
 OR s.prior_authorization_id IS DISTINCT FROM r.authorization_id
 OR NOT EXISTS(SELECT 1 FROM project_coding_capacity_resume_receipts predecessor WHERE predecessor.project_id=p.id AND predecessor.historical_missions=99
  AND predecessor.authorization_id=s.supersedes_authorization_id AND predecessor.owner_id=p_owner AND predecessor.scope_hash=s.scope_hash AND predecessor.cutoff=s.cutoff)
 OR s.release_sha IS DISTINCT FROM '2f14afc16f9fe39a7e5a73892eba96fab1c9a6bd'
 OR s.deployment_id IS DISTINCT FROM 'dpl_XXKkFT4MdD3L3VUp25GGsPZXe2TH'
 OR s.release_generation<>47 OR s.approved_max_missions<>103 OR s.prior_max_missions<>102
 OR s.paid_inference_limit<>1 OR s.retry_limit<>0 OR s.scope_hash IS DISTINCT FROM r.scope_hash OR s.cutoff IS DISTINCT FROM r.cutoff OR s.token_allowance<>600000
 OR g.state IS DISTINCT FROM 'active' OR g.alias_name IS DISTINCT FROM 'katie-mu.vercel.app'
 OR g.release_sha IS DISTINCT FROM p_release OR g.release_sha=s.release_sha OR g.deployment_id=s.deployment_id
 OR g.generation IS DISTINCT FROM s.release_generation+2
 THEN RAISE EXCEPTION 'Exact authenticated original owner and corrected Mission103 release required'; END IF;
 SELECT count(*),coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0) INTO used,spent FROM agent_missions WHERE project_id=p.id;
 SELECT count(*),count(*) FILTER(WHERE operation='inference') INTO providers,paid FROM project_provider_requests WHERE project_id=p.id;
 IF f.project_id IS NOT NULL THEN
  IF f.supersedes_authorization_id IS DISTINCT FROM s.authorization_id OR f.release_sha IS DISTINCT FROM g.release_sha
   OR f.release_generation IS DISTINCT FROM g.generation OR f.deployment_id IS DISTINCT FROM g.deployment_id
  THEN RAISE EXCEPTION 'Mission103 receipt belongs to a different release'; END IF;
  RETURN jsonb_build_object('stage','authorized','projectId',p.id,'authorizationId',f.authorization_id,'authorizedAt',f.authorized_at,
   'priorAuthorizationId',f.supersedes_authorization_id,'sourceMissionId',f.source_mission_id,'sourceAssignmentId',f.source_assignment_id,
   'releaseSha',f.release_sha,'releaseGeneration',f.release_generation,'deploymentId',f.deployment_id,'scopeHash',f.scope_hash,
   'paths',r.scope_paths,'cutoff',f.cutoff,'historicalMissions',103,'priorMaxMissions',103,'additionalMissions',1,'maxMissions',104,
   'remainingMissions',greatest(0,104-used),'paidInferenceLimit',1,'retryLimit',0,'tokenAllowance',600000,
   'recordedTokens',f.recorded_tokens,'remainingRecordedTokens',600000-f.recorded_tokens,'nodeCount',15,
   'coderId','08e792df-1046-4282-89dc-83994a8a6b7e','writerId','08e792df-1046-4282-89dc-83994a8a6b7e','reviewerId','1cf12044-d9ba-4e8b-9ef4-8b7e5aa004a5',
   'directorId',r.director_id,'managerId',r.manager_id,'stateHash',f.state_hash,'status',p.status,
   'providerRequestsAtApproval',f.historical_provider_requests,'providerRequestsNow',providers,
   'packageId',(SELECT id FROM project_work_packages WHERE project_id=p.id AND milestone_index=0));
 END IF;
 SELECT * INTO m FROM agent_missions WHERE id='f4ef8dd1-7802-409c-9787-88a3dd246861'::uuid AND project_id=p.id;
 SELECT * INTO j FROM mission_assignments WHERE id='9cfe36d9-f666-4019-8694-73db24577cac'::uuid AND mission_id=m.id;
 IF p.status IS DISTINCT FROM 'blocked' OR p.detail IS DISTINCT FROM 'Commissioning assignment failed; automatic retries are not authorized'
 OR p.phase<>'development' OR p.organization_version<>1 OR p.milestone_index<>0 OR p.max_missions<>103 OR used<>103
 OR p.token_allowance<>600000 OR spent>=600000 OR p.active_mission_id IS DISTINCT FROM m.id
 OR p.lease IS NOT NULL OR p.lease_until IS NOT NULL
 OR p.deadline IS DISTINCT FROM r.cutoff OR p.deadline IS DISTINCT FROM a.deadline OR p.deadline<=clock_timestamp()+interval '5 minutes'
 OR p.approved_hash IS DISTINCT FROM r.scope_hash OR p.approval_hash IS DISTINCT FROM r.scope_hash OR a.approved_scope IS DISTINCT FROM r.scope_hash
 OR p.spec->'allowedPaths' IS DISTINCT FROM to_jsonb(r.scope_paths)
 OR encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex') IS DISTINCT FROM r.objective_hash
 OR encode(sha256(convert_to(project_canonical(p.spec),'UTF8')),'hex') IS DISTINCT FROM r.spec_hash
 OR NOT project_provider_continued(p.id) OR NOT project_org_coding_capacity_final_roles_valid(p.id)
 OR EXISTS(SELECT 1 FROM project_work_packages WHERE project_id=p.id)
 OR EXISTS(SELECT 1 FROM project_worker_contracts WHERE project_id=p.id)
 OR NOT project_provider_mode(p.id)
 OR NOT EXISTS(SELECT 1 FROM project_organization_nodes n JOIN managed_agents a ON a.id=n.agent_id WHERE n.id='08e792df-1046-4282-89dc-83994a8a6b7e'::uuid AND n.project_id=p.id AND n.token_limit=32000 AND a.config->>'maxInputChars'='16000' AND a.config->>'maxActiveTasks'='1')
 OR NOT EXISTS(SELECT 1 FROM project_organization_nodes n JOIN managed_agents a ON a.id=n.agent_id WHERE n.id='1cf12044-d9ba-4e8b-9ef4-8b7e5aa004a5'::uuid AND n.project_id=p.id AND n.token_limit=16000 AND a.config->>'maxInputChars'='16000' AND a.config->>'maxActiveTasks'='1')
 OR NOT EXISTS(SELECT 1 FROM project_organization_nodes WHERE id=r.manager_id AND project_id=p.id AND decision_needed)
 OR EXISTS(SELECT 1 FROM unnest(s.historical_mission_ids) saved(id) WHERE NOT EXISTS(SELECT 1 FROM agent_missions x WHERE x.id=saved.id AND x.project_id=p.id))
 OR EXISTS(SELECT 1 FROM agent_missions x WHERE x.project_id=p.id AND NOT x.id=ANY(s.historical_mission_ids)
  AND x.id<>m.id)
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
 OR j.detail IS DISTINCT FROM 'SMART estimated workload exceeds single-worker context, resources or execution window; decompose before dispatch'
 OR j.result->'managementCommandRejection'->>'code' IS DISTINCT FROM 'smart_contract_capacity'
 OR j.result->'managementCommandRejection'->>'action' IS DISTINCT FROM 'commission_package'
 OR j.result->'managementCommandRejection'->'position' IS DISTINCT FROM '1'::jsonb
 OR j.result->'managementCommandRejection'->>'proposalHash' IS DISTINCT FROM 'd812f07753b5a1cb40edd4bcc6762bf8f50586b739c1651fa56f157bbc4f36bf'
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
 THEN RAISE EXCEPTION 'Exact failed Mission103 package baseline no longer eligible'; END IF;
 SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) INTO registry FROM managed_agents x WHERE x.id=ANY(p.team);
 state_hash:=encode(sha256(convert_to(project_canonical(jsonb_build_object(
 'initialReceipt',to_jsonb(r),'priorReceipt',to_jsonb(s),'state',project_org_coding_capacity_state(p.id),'executionTeam',registry)),'UTF8')),'hex');
 RETURN jsonb_build_object('stage','authorize','projectId',p.id,'authorizationId',null,
  'priorAuthorizationId',s.authorization_id,'sourceMissionId',m.id,'sourceAssignmentId',j.id,'failure',j.detail,
  'releaseSha',g.release_sha,'releaseGeneration',g.generation,'deploymentId',g.deployment_id,'scopeHash',r.scope_hash,
  'paths',r.scope_paths,'cutoff',r.cutoff,'historicalMissions',103,'priorMaxMissions',103,'remainingMissions',0,
  'minAdditionalMissions',1,'recommendedAdditionalMissions',1,'maxAdditionalMissions',1,
  'additionalMissions',1,'maxMissions',104,'paidInferenceLimit',1,'retryLimit',0,'tokenAllowance',600000,
  'recordedTokens',spent,'remainingRecordedTokens',600000-spent,'nodeCount',15,
  'coderId','08e792df-1046-4282-89dc-83994a8a6b7e','writerId','08e792df-1046-4282-89dc-83994a8a6b7e','reviewerId','1cf12044-d9ba-4e8b-9ef4-8b7e5aa004a5',
  'directorId',r.director_id,'managerId',r.manager_id,'providerRequestsAtApproval',providers,'historicalInferenceRequests',paid,'stateHash',state_hash,'status',p.status);
END
$$;

REVOKE ALL ON FUNCTION public.project_org_coding_capacity_smart_offer(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
DO $patch$
DECLARE k record; b text; a text; t text;
BEGIN
 FOR k IN SELECT * FROM (VALUES
 ('public.project_org_coding_capacity_final_offer(uuid,uuid,text)','e21ccf0206bb138ec64493a0816940b0'),
 ('public.project_org_coding_capacity_resume_authorize(uuid,uuid,text,bigint,text,uuid,text,text,timestamptz,integer,integer,integer,integer,integer,bigint,uuid,uuid,uuid)','bad9cf16b68cbf3d84b23290248f542d'),
 ('public.project_org_coding_capacity_resource_guard()','c081a1801e609091c801354bbea33cbf'),
 ('public.project_org_coding_capacity_commands(uuid,uuid,jsonb)','89a5984f5a822d110ab06246175efa2d'),
 ('public.project_org_coding_capacity_live(uuid)','ba74820786229f9e771227e3c32b11e9')
 ) x(sig,expected) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=k.sig::regprocedure) IS DISTINCT FROM k.expected
  THEN RAISE EXCEPTION 'Unexpected installed Mission103 continuation preimage: %',k.sig; END IF;
  b:=pg_get_functiondef(k.sig::regprocedure);
  IF k.sig LIKE 'public.project_org_coding_capacity_final_offer(%' THEN
   a:=$old$ SELECT * INTO f FROM project_coding_capacity_resume_receipts WHERE project_id=p_project AND historical_missions=102;$old$;
   t:=a||$new$
 IF f.project_id IS NOT NULL AND (f.release_sha IS DISTINCT FROM p_release OR EXISTS(
  SELECT 1 FROM project_coding_capacity_resume_receipts WHERE project_id=p_project AND historical_missions=103)) THEN
  RETURN project_org_coding_capacity_smart_offer(p_owner,p_project,p_release);
 END IF;$new$;
   IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected SMART offer anchor'; END IF;
   b:=replace(b,a,t);
  ELSIF k.sig LIKE 'public.project_org_coding_capacity_resume_authorize(%' THEN
   FOR a,t IN SELECT * FROM (VALUES
    ($old$NOT IN (98,99,102)$old$,$new$NOT IN (98,99,102,103)$new$),
    ($old$(o->>'historicalMissions')::integer=102 THEN 1 ELSE 3 END$old$,$new$(o->>'historicalMissions')::integer IN (102,103) THEN 1 ELSE 3 END$new$),
    ($old$VALUES(p.id,p_authorization,CASE WHEN (o->>'historicalMissions')::integer IN (99,102) THEN$old$,
     $new$VALUES(p.id,p_authorization,CASE WHEN (o->>'historicalMissions')::integer IN (99,102,103) THEN$new$),
    ($old$CASE WHEN (o->>'historicalMissions')::integer IN (99,102) THEN p_prior_authorization ELSE NULL END);$old$,
     $new$CASE WHEN (o->>'historicalMissions')::integer IN (99,102,103) THEN p_prior_authorization ELSE NULL END);$new$),
    ($old$Exact fresh three-mission owner consent required; stale or duplicate approval$old$,$new$Exact fresh bounded owner consent required; stale or duplicate approval$new$)
   ) patch(old_text,new_text) LOOP
    IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected SMART owner writer anchor: %',a; END IF;
    b:=replace(b,a,t);
   END LOOP;
  ELSIF k.sig='public.project_org_coding_capacity_resource_guard()' THEN
   a:=$old$ THEN RAISE EXCEPTION 'Original commissioning resources require the exact one-time owner receipt'; END IF;$old$;
   t:=$new$ AND NOT (OLD.max_missions=103 AND NEW.max_missions=104 AND OLD.status='blocked'
  AND NEW.token_allowance=OLD.token_allowance AND NEW.deadline=OLD.deadline
  AND EXISTS(SELECT 1 FROM project_coding_capacity_resume_receipts s WHERE s.project_id=OLD.id
   AND s.historical_missions=103 AND s.authorization_txid=txid_current() AND s.source_mission_id=OLD.active_mission_id
   AND s.prior_max_missions=OLD.max_missions AND s.approved_max_missions=NEW.max_missions))
 THEN RAISE EXCEPTION 'Original commissioning resources require the exact one-time owner receipt'; END IF;$new$;
   IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected SMART resource guard anchor'; END IF;
   b:=replace(b,a,t);
  ELSIF k.sig='public.project_org_coding_capacity_commands(uuid,uuid,jsonb)' THEN
   a:=$old$IF r.historical_missions=102 AND ($old$;
   t:=$new$IF r.historical_missions IN (102,103) AND ($new$;
   IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected SMART command guard anchor'; END IF;
   b:=replace(b,a,t);
  ELSE
   a:=$old$(r.historical_missions<>102 OR project_org_coding_capacity_final_roles_valid(p.id))$old$;
   t:=$new$(r.historical_missions NOT IN (102,103) OR project_org_coding_capacity_final_roles_valid(p.id))$new$;
   IF (length(b)-length(replace(b,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected SMART live guard anchor'; END IF;
   b:=replace(b,a,t);
  END IF;
  EXECUTE b;
 END LOOP;
END
$patch$;
COMMIT;

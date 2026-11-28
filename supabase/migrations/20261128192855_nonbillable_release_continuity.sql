-- A reviewed package's nonbillable delivery may survive a qualified runtime
-- release. This is operator release continuity, not a renewed retry grant.
-- The signed checkpoint, historical six-release allowance, provider receipts,
-- failed workflow receipt and all paid-dispatch predicates remain unchanged.
BEGIN;

CREATE FUNCTION public.project_org_package_nonbillable_checkpoint(p_project uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c project_package_checkpoint_continuations; s project_package_corrective_receipts;
 p work_projects; w project_work_packages; r project_package_execution_receipts;
 a project_provider_execution; e jsonb; requests jsonb;
BEGIN
 SELECT * INTO c FROM project_package_checkpoint_continuations WHERE project_id=p_project;
 IF c.project_id IS NULL THEN RETURN NULL; END IF;
 -- The shared evidence resolver verifies the authentic settlement, immutable
 -- candidate/contract, failed workflow and its settled provider history.
 e:=project_development_review_settlement(c.assignment_id);
 IF e IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO p FROM work_projects WHERE id=p_project;
 SELECT * INTO w FROM project_work_packages WHERE id=c.package_id AND project_id=p_project;
 SELECT * INTO r FROM project_package_execution_receipts WHERE project_id=p_project;
 SELECT * INTO a FROM project_provider_execution WHERE project_id=p_project;
 SELECT * INTO s FROM project_package_corrective_receipts WHERE receipt_id=(e->>'receiptId')::uuid;
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.started_at,q.id),'[]'::jsonb) INTO requests
 FROM project_provider_requests q WHERE q.project_id=p_project AND q.started_at>=c.authorized_at;
 IF NOT coalesce((e->>'projectId'=p_project::text AND e->>'authorizationId'=c.authorization_id::text
  AND c.owner_id=r.owner_id AND r.package_id=c.package_id
  AND c.cutoff>clock_timestamp() AND c.terms=project_org_package_checkpoint_terms()
  AND c.terms->>'stopAt'='verified-protected-preview' AND c.terms->>'additionalPaidRetries'='0'
  AND p.status IN('blocked','running') AND p.phase IN('development','delivery','browser_check','assessment')
  AND p.deadline=c.cutoff AND w.deadline=c.cutoff AND a.deadline=c.cutoff
  AND a.owner_id=c.owner_id AND a.window_id=c.authorization_id
  AND p.approved_hash=r.scope_hash AND p.approval_hash=r.scope_hash
  AND w.scope_hash=r.scope_hash AND a.approved_scope=r.scope_hash
  AND p.max_missions=(c.terms->>'maxMissions')::int
  AND p.token_allowance=(c.terms->>'tokenAllowance')::int
  AND project_org_package_execution_fingerprint(w.id)=c.renewed_fingerprint
  AND EXISTS(SELECT 1 FROM project_execution_windows x WHERE x.id=c.authorization_id
    AND x.project_id=p_project AND x.owner_id=c.owner_id AND x.cutoff=c.cutoff)
  -- No new provider request of any kind may hide outside the settled run.
  AND requests=s.checkpoint->'providerRequests'
  AND NOT project_provider_request_pending(p_project)
 ),false) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('authorizationId',c.authorization_id,'settlementId',s.receipt_id,
  'projectId',p_project,'packageId',c.package_id,'ownerId',c.owner_id,
  'scopeHash',r.scope_hash,'candidateSha',e->>'candidateSha',
  'sourceTreeSha',e->>'sourceTreeSha','cutoff',c.cutoff,'additionalPaidInference',0);
END $$;

-- Only immutable operator attestations can establish a new live delivery
-- release. The original signed identity remains usable without an attestation.
CREATE FUNCTION public.project_org_package_nonbillable_release_live(
 p_project uuid,p_release text,p_generation bigint,p_deployment text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cp jsonb; c project_package_checkpoint_continuations; g project_retest_production_release_gate;
BEGIN
 cp:=project_org_package_nonbillable_checkpoint(p_project);
 IF cp IS NULL THEN RETURN false; END IF;
 SELECT * INTO c FROM project_package_checkpoint_continuations WHERE project_id=p_project;
 SELECT * INTO g FROM project_retest_production_release_gate WHERE project_id=p_project;
 IF g.state IS DISTINCT FROM 'active' OR g.alias_name IS DISTINCT FROM 'katie-mu.vercel.app'
  OR g.release_sha IS DISTINCT FROM p_release OR g.generation IS DISTINCT FROM p_generation
  OR g.deployment_id IS DISTINCT FROM p_deployment THEN RETURN false; END IF;
 RETURN (g.release_sha=c.release_sha AND g.generation=c.release_generation AND g.deployment_id=c.deployment_id)
 OR EXISTS(SELECT 1 FROM project_events e WHERE e.project_id=p_project
  AND e.event='package_nonbillable_release_qualified' AND e.data->'checkpoint'=cp
  AND e.data->>'releaseSha'=p_release AND e.data->>'deploymentId'=p_deployment
  AND e.data->>'generation'=p_generation::text
  AND e.data->'qualification'->>'conclusion'='success');
END $$;

CREATE FUNCTION public.project_org_package_nonbillable_gate_allowed(
 p_project uuid,p_action text,p_release text,p_deployment text,p_generation bigint)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cp jsonb; g project_retest_production_release_gate;
BEGIN
 cp:=project_org_package_nonbillable_checkpoint(p_project);
 IF cp IS NULL THEN RETURN false; END IF;
 SELECT * INTO g FROM project_retest_production_release_gate WHERE project_id=p_project;
 IF g.generation IS DISTINCT FROM p_generation OR g.alias_name IS DISTINCT FROM 'katie-mu.vercel.app'
  OR p_release IS NULL OR p_release !~ '^[a-f0-9]{40}$'
  OR p_deployment IS NULL OR p_deployment !~ '^dpl_[A-Za-z0-9]+$'
  OR EXISTS(SELECT 1 FROM work_projects WHERE id=p_project AND (lease IS NOT NULL OR lease_until IS NOT NULL))
  OR EXISTS(SELECT 1 FROM mission_assignments j JOIN agent_missions m ON m.id=j.mission_id
    WHERE m.project_id=p_project AND (j.lease IS NOT NULL OR j.lease_until IS NOT NULL))
  OR EXISTS(SELECT 1 FROM agent_tasks t JOIN mission_assignments j ON j.id=t.id
    JOIN agent_missions m ON m.id=j.mission_id WHERE m.project_id=p_project AND t.status IN('dispatching','submitted'))
 THEN RETURN false; END IF;
 IF p_action='closed' THEN
  RETURN g.state='active' AND p_release=g.release_sha AND p_deployment=g.deployment_id
   AND project_org_package_nonbillable_release_live(p_project,p_release,p_generation,p_deployment);
 ELSIF p_action='active' THEN
  RETURN g.state='closed' AND p_release<>g.release_sha AND p_deployment<>g.deployment_id
   AND EXISTS(SELECT 1 FROM project_events e WHERE e.project_id=p_project
    AND e.event='package_nonbillable_release_transition' AND e.data->'checkpoint'=cp
    AND e.data->>'action'='closed' AND e.data->>'generation'=g.generation::text
    AND e.data->>'releaseSha'=g.release_sha AND e.data->>'deploymentId'=g.deployment_id);
 END IF;
 RETURN false;
END $$;

-- Protect both transitions and qualification from runtime table access.
CREATE FUNCTION public.project_org_nonbillable_release_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF (TG_OP<>'INSERT' AND OLD.event IN('package_nonbillable_release_transition','package_nonbillable_release_qualified'))
  OR (TG_OP<>'DELETE' AND NEW.event IN('package_nonbillable_release_transition','package_nonbillable_release_qualified')) THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Nonbillable release evidence is immutable'; END IF;
  IF current_user<>'postgres' THEN RAISE EXCEPTION 'Only the existing release operator records release evidence'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER nonbillable_release_event_guard BEFORE INSERT OR UPDATE OR DELETE ON public.project_events
FOR EACH ROW EXECUTE FUNCTION public.project_org_nonbillable_release_event_guard();

-- Preserve the existing operator, advisory locks, epoch comparison and drain
-- checks. Extend the existing gate predicate; never write the gate directly.
DO $patch$
DECLARE d text; anchor text;
BEGIN
 d:=pg_get_functiondef('public.project_org_package_corrective_gate_allowed(uuid,text,text,text,bigint)'::regprocedure);
 anchor:='begin';
 IF (length(d)-length(replace(d,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Unexpected corrective gate predecessor'; END IF;
 EXECUTE replace(d,anchor,anchor||E'\n if project_org_package_nonbillable_gate_allowed(p_project,p_action,p_release,p_deployment,p_generation) then return true;end if;');
 d:=pg_get_functiondef('public.project_org_retest_set_release_gate(uuid,text,text,text,bigint)'::regprocedure);
 anchor:=' return jsonb_build_object(''projectId'',p_project,''state'',p_action,';
 IF (length(d)-length(replace(d,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Unexpected operator gate predecessor'; END IF;
 EXECUTE replace(d,anchor,$record$
 if project_org_package_nonbillable_checkpoint(p_project) is not null then
  insert into project_events(project_id,event,data) values(p_project,'package_nonbillable_release_transition',
   jsonb_build_object('checkpoint',project_org_package_nonbillable_checkpoint(p_project),
    'action',p_action,'releaseSha',p_release,'deploymentId',p_deployment,
    'priorGeneration',g.generation,'generation',g.generation+1));
 end if;
$record$||anchor);
END $patch$;

-- Independent CI and exact READY canonical-alias verification remain the
-- privileged operator's obligation, as in corrective_continue. Recording this
-- attestation does not resume workers, alter consent, or grant provider calls.
CREATE FUNCTION public.project_org_package_nonbillable_release_qualify(
 p_project uuid,p_release text,p_generation bigint,p_deployment text,p_qualification jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cp jsonb; g project_retest_production_release_gate; prior project_events; result jsonb; receipt uuid:=gen_random_uuid();
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 PERFORM 1 FROM work_projects WHERE id=p_project FOR UPDATE;
 SELECT * INTO g FROM project_retest_production_release_gate WHERE project_id=p_project FOR UPDATE;
 cp:=project_org_package_nonbillable_checkpoint(p_project);
 IF cp IS NULL OR g.state IS DISTINCT FROM 'active' OR g.alias_name IS DISTINCT FROM 'katie-mu.vercel.app'
  OR g.release_sha IS DISTINCT FROM p_release OR g.generation IS DISTINCT FROM p_generation OR g.deployment_id IS DISTINCT FROM p_deployment
  OR jsonb_typeof(p_qualification) IS DISTINCT FROM 'object'
  OR p_qualification->>'releaseSha' IS DISTINCT FROM p_release
  OR p_qualification->>'deploymentId' IS DISTINCT FROM p_deployment
  OR p_qualification->>'canonicalAlias' IS DISTINCT FROM 'katie-mu.vercel.app'
  OR p_qualification->>'conclusion' IS DISTINCT FROM 'success'
  OR p_qualification->>'candidateSha' IS DISTINCT FROM cp->>'candidateSha'
  OR p_qualification->>'additionalPaidInference' IS DISTINCT FROM '0'
  OR coalesce(p_qualification->>'testedTree','') !~ '^[a-f0-9]{40}$'
  OR coalesce(p_qualification->>'pullRequest','') !~ '^[1-9][0-9]*$'
  OR coalesce(p_qualification->>'ciRunId','') !~ '^[1-9][0-9]*$'
  OR NOT EXISTS(SELECT 1 FROM project_events e WHERE e.project_id=p_project
   AND e.event='package_nonbillable_release_transition' AND e.data->'checkpoint'=cp
   AND e.data->>'action'='active' AND e.data->>'generation'=p_generation::text
   AND e.data->>'releaseSha'=p_release AND e.data->>'deploymentId'=p_deployment)
 THEN RAISE EXCEPTION 'Exact nonbillable checkpoint and qualified active canonical release required'; END IF;
 result:=jsonb_build_object('checkpoint',cp,'releaseSha',p_release,'generation',p_generation,
  'deploymentId',p_deployment,'qualification',p_qualification);
 SELECT * INTO prior FROM project_events WHERE project_id=p_project AND event='package_nonbillable_release_qualified'
  AND data->>'generation'=p_generation::text;
 IF prior.id IS NOT NULL THEN
  IF prior.data IS DISTINCT FROM result THEN RAISE EXCEPTION 'Release already attested with different evidence'; END IF;
  RETURN result||jsonb_build_object('receiptId',prior.id);
 END IF;
 INSERT INTO project_events(id,project_id,event,data) VALUES(receipt,p_project,'package_nonbillable_release_qualified',result);
 RETURN result||jsonb_build_object('receiptId',receipt);
END $$;

REVOKE ALL ON FUNCTION public.project_org_package_nonbillable_checkpoint(uuid),
 public.project_org_package_nonbillable_release_live(uuid,text,bigint,text),
 public.project_org_package_nonbillable_gate_allowed(uuid,text,text,text,bigint),
 public.project_org_nonbillable_release_event_guard(),
 public.project_org_package_nonbillable_release_qualify(uuid,text,bigint,text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_package_nonbillable_release_live(uuid,text,bigint,text) TO service_role;
COMMIT;

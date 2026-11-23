-- One authenticated source-bound retest of a latest, pre-inference blocked
-- management assignment. This is not a mission-number-specific exception.
-- No owner approval or paid work occurs when this migration is installed.
BEGIN;

CREATE TABLE public.project_context_retest_receipts(
 project_id uuid PRIMARY KEY REFERENCES public.work_projects(id),
 authorization_id uuid NOT NULL UNIQUE,
 owner_id uuid NOT NULL,
 source_mission_id uuid NOT NULL,
 source_assignment_id uuid NOT NULL,
 release_sha text NOT NULL CHECK(release_sha ~ '^[a-f0-9]{40}$'),
 release_generation bigint NOT NULL CHECK(release_generation>0),
 deployment_id text NOT NULL CHECK(deployment_id ~ '^dpl_[A-Za-z0-9]+$'),
 scope_hash text NOT NULL,
 cutoff timestamptz NOT NULL,
 historical_missions integer NOT NULL CHECK(historical_missions BETWEEN 84 AND 96),
 max_missions integer NOT NULL CHECK(max_missions=96),
 token_allowance integer NOT NULL CHECK(token_allowance=600000),
 prior_attempts integer NOT NULL CHECK(prior_attempts=1),
 prior_calls integer NOT NULL CHECK(prior_calls=0),
 permitted_additional_attempts integer NOT NULL CHECK(permitted_additional_attempts=1),
 original_failure_digest text NOT NULL,
 original_assignment_result jsonb,
 original_assignment_detail text,
 original_mission_detail text,
 original_available_at timestamptz,
 state_hash text NOT NULL CHECK(state_hash ~ '^[a-f0-9]{64}$'),
 context_hash text NOT NULL CHECK(context_hash ~ '^[a-f0-9]{64}$'),
 context_chars integer NOT NULL CHECK(context_chars BETWEEN 1 AND 48000),
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.project_context_retest_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_context_retest_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER project_context_retest_receipts_immutable
 BEFORE UPDATE OR DELETE ON public.project_context_retest_receipts
 FOR EACH ROW EXECUTE FUNCTION public.project_org_change_immutable();

CREATE FUNCTION public.project_org_context_retest_offer(
 p_owner uuid,p_project uuid,p_release text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $offer$
DECLARE p public.work_projects;g public.project_retest_production_release_gate;
 a public.project_provider_execution;win public.project_bounded_recovery_receipts;
 m public.agent_missions;j public.mission_assignments;n public.project_organization_nodes;
 prior public.project_context_retest_receipts;count_missions integer;
 snapshot_hash text;failure_digest text;
BEGIN
 SELECT * INTO p FROM public.work_projects WHERE id=p_project;
 SELECT * INTO g FROM public.project_retest_production_release_gate WHERE project_id=p_project;
 SELECT * INTO a FROM public.project_provider_execution WHERE project_id=p_project;
 SELECT * INTO win FROM public.project_bounded_recovery_receipts WHERE project_id=p_project;
 SELECT * INTO prior FROM public.project_context_retest_receipts WHERE project_id=p_project;
 IF p.id IS NULL OR p.id IS DISTINCT FROM 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  OR p_owner IS NULL OR p_owner IS DISTINCT FROM win.owner_id
  OR p_owner IS DISTINCT FROM a.owner_id
  OR NOT public.standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
  OR NOT public.project_org_retest_exact_scope_grants(p.id)
  OR NOT public.project_org_retest_original_owner_lineage(p.id)
  OR p.organization_version<>1 OR p.phase<>'development'
  OR p.approval_hash IS DISTINCT FROM p.approved_hash
  OR p.approved_hash IS DISTINCT FROM '4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
  OR p.max_missions<>96 OR p.token_allowance<>600000
  OR p.deadline IS DISTINCT FROM win.cutoff
  OR p.deadline IS DISTINCT FROM a.deadline
  OR a.window_id IS DISTINCT FROM win.window_id
  OR a.approved_scope IS DISTINCT FROM p.approved_hash
  OR g.project_id IS NULL OR g.state<>'active'
  OR g.release_sha IS DISTINCT FROM p_release
  OR g.alias_name<>'katie-mu.vercel.app'
  OR g.generation IS NULL OR g.generation<=0
  OR g.deployment_id IS NULL OR g.deployment_id !~ '^dpl_[A-Za-z0-9]+$'
  OR NOT public.project_org_bounded_recovery_window_valid(p.id)
 THEN RAISE EXCEPTION 'Authenticated original project owner, window or release not eligible'; END IF;
 IF prior.project_id IS NOT NULL THEN
  IF prior.owner_id IS DISTINCT FROM p_owner OR prior.release_sha IS DISTINCT FROM p_release
    OR prior.release_generation IS DISTINCT FROM g.generation
    OR prior.deployment_id IS DISTINCT FROM g.deployment_id
  THEN RAISE EXCEPTION 'Existing context retest belongs to a different release'; END IF;
  RETURN jsonb_build_object(
   'projectId',p.id,'stage','authorized','releaseSha',p_release,
   'releaseGeneration',g.generation,'deploymentId',g.deployment_id,
   'scopeHash',prior.scope_hash,'cutoff',prior.cutoff,
   'missionId',prior.source_mission_id,'assignmentId',prior.source_assignment_id,
   'historicalMissions',prior.historical_missions,'maxMissions',96,
   'tokenAllowance',600000,'nodeCount',13,'originalAttempts',1,
   'additionalAttempts',1,'authorizationId',prior.authorization_id,
   'authorizedAt',prior.authorized_at,'contextHash',prior.context_hash,
   'contextChars',prior.context_chars);
 END IF;
 SELECT count(*) INTO count_missions FROM public.agent_missions WHERE project_id=p.id;
 SELECT * INTO m FROM public.agent_missions WHERE id=p.active_mission_id AND project_id=p.id;
 SELECT * INTO j FROM public.mission_assignments WHERE mission_id=m.id;
 SELECT * INTO n FROM public.project_organization_nodes
  WHERE id::text=m.project_evidence->>'organizationNodeId' AND project_id=p.id;
 IF p.status<>'blocked'
  OR p.detail IS DISTINCT FROM 'Project management cannot achieve its objective within bounded retry authority'
  OR p.lease IS NOT NULL OR p.lease_until IS NOT NULL
  OR p.deadline<=clock_timestamp()+interval '5 minutes'
  OR count_missions<84 OR count_missions>=96
  OR m.id IS NULL OR m.status<>'blocked' OR m.project_kind<>'management'
  OR m.calls<>0 OR m.actual_tokens<>0 OR m.reserved_tokens<>0
  OR m.deadline IS DISTINCT FROM p.deadline
  OR m.detail IS DISTINCT FROM
   'Required management decision evidence exceeds bounded context; do not omit current contracts, unresolved exceptions, or necessary assignment results.'
  OR j.id IS NULL OR j.status<>'failed' OR j.attempts<>1
  OR j.lease IS NOT NULL OR j.lease_until IS NOT NULL
  OR j.result->>'detail' IS DISTINCT FROM m.detail
  OR j.result->'diagnostic'->>'stage' IS DISTINCT FROM 'work'
  OR j.result->'diagnostic'->>'acceptedIssue' IS DISTINCT FROM 'false'
  OR j.role<>'work' OR j.job_key<>'plan'
  OR n.id IS NULL OR n.status<>'active' OR n.deadline IS DISTINCT FROM p.deadline
  OR n.kind='worker'
  OR n.management_level NOT IN ('project_director','functional_director','manager','supervisor')
  OR NOT n.decision_needed OR n.agent_id IS DISTINCT FROM j.agent_id
  OR j.payload->>'organizationNodeId' IS DISTINCT FROM n.id::text
  OR NOT EXISTS(SELECT 1 FROM public.project_organization_assignments b
      WHERE b.assignment_id=j.id AND b.node_id=n.id
       AND b.contract_hash=encode(sha256(convert_to(public.project_canonical(n.acceptance),'UTF8')),'hex'))
  OR m.project_evidence->>'providerContinuationWindow' IS DISTINCT FROM a.window_id::text
  OR m.project_evidence->>'providerContinuationRelease' IS DISTINCT FROM a.continuation_release_sha
  OR m.project_evidence->>'providerContinuationDecision' IS DISTINCT FROM a.continuation_decision_id::text
  OR NOT public.project_provider_continued(p.id)
  OR NOT public.project_provider_continued_assignment(j.id)
  OR public.project_provider_request_pending(p.id)
  OR EXISTS(SELECT 1 FROM public.project_provider_requests pr
      WHERE pr.mission_id=m.id AND pr.assignment_id=j.id)
  OR EXISTS(SELECT 1 FROM public.agent_missions later
      WHERE later.project_id=p.id AND later.created_at>m.created_at)
  OR (SELECT count(*) FROM public.mission_assignments x WHERE x.mission_id=m.id)<>1
  OR (SELECT count(*) FROM public.project_organization_nodes x
      WHERE x.project_id=p.id AND x.status='active' AND x.deadline=p.deadline)<>13
  OR (SELECT count(*) FROM public.project_work_packages x WHERE x.project_id=p.id)<>0
  OR (SELECT coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0)
      FROM public.agent_missions spent WHERE spent.project_id=p.id)>600000
 THEN RAISE EXCEPTION 'Latest pre-inference management failure is not eligible for one owner retest'; END IF;
 failure_digest:=encode(sha256(convert_to(public.project_canonical(
  jsonb_build_object('mission',to_jsonb(m),'assignment',to_jsonb(j))),'UTF8')),'hex');
 snapshot_hash:=encode(sha256(convert_to(public.project_canonical(jsonb_build_object(
   'project',to_jsonb(p),'mission',to_jsonb(m),'assignment',to_jsonb(j),
   'gate',to_jsonb(g),'originalWindow',to_jsonb(win),
   'nodes',(SELECT coalesce(jsonb_agg(to_jsonb(nd) ORDER BY nd.id),'[]'::jsonb)
            FROM public.project_organization_nodes nd WHERE nd.project_id=p.id),
   'exceptions',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb)
            FROM public.project_organization_exceptions e WHERE e.project_id=p.id),
   'decisions',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb)
            FROM public.project_organization_decisions d WHERE d.project_id=p.id),
   'missionCount',count_missions
 )),'UTF8')),'hex');
 RETURN jsonb_build_object('projectId',p.id,'stage','authorize',
   'releaseSha',p_release,'releaseGeneration',g.generation,
   'deploymentId',g.deployment_id,'scopeHash',p.approved_hash,
   'cutoff',p.deadline,'missionId',m.id,'assignmentId',j.id,'principalId',n.id,
   'originalAttempts',j.attempts,'originalCalls',m.calls,'additionalAttempts',1,
   'historicalMissions',count_missions,'maxMissions',96,'tokenAllowance',600000,
   'nodeCount',13,'stateHash',snapshot_hash,'failureDigest',failure_digest,
   'authorizationId',null);
END
$offer$;
REVOKE ALL ON FUNCTION public.project_org_context_retest_offer(uuid,uuid,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_context_retest_offer(uuid,uuid,text) TO service_role;

CREATE FUNCTION public.project_org_context_retest_claim_authorized(
 p_project uuid,p_release text,p_generation bigint,p_deployment text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $claim$
 SELECT EXISTS(
  SELECT 1 FROM public.project_context_retest_receipts r
  JOIN public.work_projects p ON p.id=r.project_id
  JOIN public.project_provider_execution a ON a.project_id=p.id
    AND a.owner_id=r.owner_id AND a.window_id IS NOT NULL
    AND a.deadline=r.cutoff AND a.approved_scope=r.scope_hash
  JOIN public.project_retest_production_release_gate g ON g.project_id=p.id
    AND g.state='active' AND g.alias_name='katie-mu.vercel.app'
    AND g.release_sha=p_release AND g.generation=p_generation
    AND g.deployment_id=p_deployment
  JOIN public.agent_missions m ON m.id=r.source_mission_id
    AND m.project_id=p.id AND m.status='running' AND m.calls=0
    AND m.deadline=p.deadline AND m.project_kind='management'
  JOIN public.mission_assignments j ON j.id=r.source_assignment_id AND j.mission_id=m.id
    AND j.status='queued' AND j.attempts=r.prior_attempts
    AND j.lease IS NULL AND j.lease_until IS NULL
    AND j.available_at<=clock_timestamp()
  JOIN public.project_organization_nodes n
    ON n.id::text=m.project_evidence->>'organizationNodeId'
    AND n.project_id=p.id AND n.id::text=j.payload->>'organizationNodeId'
    AND n.agent_id=j.agent_id AND n.status='active' AND n.deadline=p.deadline
  WHERE p.id=p_project AND p.id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
    AND p.status='running' AND p.phase='development'
    AND p.deadline>clock_timestamp()+interval '5 minutes'
    AND r.release_sha=p_release AND r.release_generation=p_generation
    AND r.deployment_id=p_deployment AND r.permitted_additional_attempts=1
    AND r.prior_attempts=1 AND r.prior_calls=0
    AND r.scope_hash=p.approved_hash AND p.approval_hash=p.approved_hash
    AND r.cutoff=p.deadline AND r.max_missions=p.max_missions
    AND r.token_allowance=p.token_allowance
    AND r.historical_missions=(SELECT count(*) FROM public.agent_missions x WHERE x.project_id=p.id)
    AND r.original_assignment_result IS NOT DISTINCT FROM j.result
    AND r.original_assignment_detail IS NOT DISTINCT FROM j.detail
    AND (SELECT count(*) FROM public.mission_assignments x WHERE x.mission_id=m.id)=1
    AND j.role='work' AND j.job_key='plan'
    AND n.kind<>'worker' AND n.decision_needed
    AND n.management_level IN ('project_director','functional_director','manager','supervisor')
    AND EXISTS(SELECT 1 FROM public.project_organization_assignments b
        WHERE b.assignment_id=j.id AND b.node_id=n.id
          AND b.contract_hash=encode(sha256(convert_to(public.project_canonical(n.acceptance),'UTF8')),'hex'))
    AND m.project_evidence->>'providerContinuationWindow'=a.window_id::text
    AND m.project_evidence->>'providerContinuationDecision'=a.continuation_decision_id::text
    AND m.project_evidence->>'providerContinuationRelease'=a.continuation_release_sha
    AND r.owner_id=(SELECT owner_id FROM public.project_bounded_recovery_receipts orig
       WHERE orig.project_id=p.id)
    AND public.project_org_bounded_recovery_window_valid(p.id)
    AND public.project_provider_continued(p.id)
    AND public.project_provider_continued_assignment(j.id)
    AND NOT public.project_provider_request_pending(p.id)
    AND NOT EXISTS(SELECT 1 FROM public.agent_missions later
        WHERE later.project_id=p.id AND later.created_at>m.created_at)
    AND (SELECT count(*) FROM public.project_organization_nodes x
        WHERE x.project_id=p.id AND x.status='active' AND x.deadline=p.deadline)=13
    AND (SELECT coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0)
       FROM public.agent_missions spent WHERE spent.project_id=p.id)<=p.token_allowance
 );
$claim$;
REVOKE ALL ON FUNCTION public.project_org_context_retest_claim_authorized(uuid,text,bigint,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_context_retest_claim_authorized(uuid,text,bigint,text)
 TO service_role;

CREATE FUNCTION public.project_org_context_retest_authorize(
 p_owner uuid,p_project uuid,p_release text,p_generation bigint,p_deployment text,
 p_mission uuid,p_assignment uuid,p_authorization uuid,p_state_hash text,
 p_context_hash text,p_context_chars integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $authorize$
DECLARE p public.work_projects;g public.project_retest_production_release_gate;
 m public.agent_missions;j public.mission_assignments;offer jsonb;receipt public.project_context_retest_receipts;
 stamp timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 SELECT * INTO p FROM public.work_projects WHERE id=p_project FOR UPDATE;
 SELECT * INTO g FROM public.project_retest_production_release_gate WHERE project_id=p_project FOR UPDATE;
 SELECT * INTO m FROM public.agent_missions WHERE id=p_mission AND project_id=p_project FOR UPDATE;
 SELECT * INTO j FROM public.mission_assignments WHERE id=p_assignment AND mission_id=p_mission FOR UPDATE;
 IF p_authorization IS NULL OR p_context_hash !~ '^[a-f0-9]{64}$'
    OR p_context_chars<1 OR p_context_chars>48000
    OR p_release IS DISTINCT FROM g.release_sha OR g.state<>'active'
    OR p_generation IS DISTINCT FROM g.generation
    OR p_deployment IS DISTINCT FROM g.deployment_id
 THEN RAISE EXCEPTION 'Exact current owner, context, bound release and limits required';END IF;
 offer:=public.project_org_context_retest_offer(p_owner,p_project,p_release);
 IF offer->>'stage' IS DISTINCT FROM 'authorize'
   OR offer->>'stateHash' IS DISTINCT FROM p_state_hash
   OR offer->>'missionId' IS DISTINCT FROM p_mission::text
   OR offer->>'assignmentId' IS DISTINCT FROM p_assignment::text
   OR (offer->>'releaseGeneration')::bigint IS DISTINCT FROM p_generation
   OR offer->>'deploymentId' IS DISTINCT FROM p_deployment
 THEN RAISE EXCEPTION 'Owner context-retreat offer changed or already spent'; END IF;
 stamp:=clock_timestamp();
 INSERT INTO public.project_context_retest_receipts(
   project_id,authorization_id,owner_id,source_mission_id,source_assignment_id,
   release_sha,release_generation,deployment_id,scope_hash,cutoff,
   historical_missions,max_missions,token_allowance,prior_attempts,prior_calls,
   permitted_additional_attempts,original_failure_digest,
   original_assignment_result,original_assignment_detail,original_mission_detail,
   original_available_at,state_hash,context_hash,context_chars,authorized_at)
 VALUES(p.id,p_authorization,p_owner,m.id,j.id,p_release,p_generation,p_deployment,
   p.approved_hash,p.deadline,(offer->>'historicalMissions')::integer,96,600000,
   1,0,1,offer->>'failureDigest',j.result,j.detail,m.detail,
   j.available_at,p_state_hash,p_context_hash,p_context_chars,stamp);
 UPDATE public.mission_assignments SET status='queued',updated_at=stamp
  WHERE id=j.id AND status='failed' AND attempts=1 AND lease IS NULL AND lease_until IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original failed assignment changed before authorization';END IF;
 UPDATE public.agent_missions SET status='running',updated_at=stamp
  WHERE id=m.id AND status='blocked' AND calls=0;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original blocked mission changed before authorization';END IF;
 UPDATE public.work_projects SET status='running',impediment=NULL,
   progress_since=stamp,updated_at=stamp,
   detail='Authenticated owner allowed exactly one corrected-context management retest.'
  WHERE id=p.id AND status='blocked' AND active_mission_id=m.id
    AND lease IS NULL AND lease_until IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original blocked project changed before authorization';END IF;
 IF NOT public.project_org_context_retest_claim_authorized(
   p.id,p_release,p_generation,p_deployment)
  OR NOT public.project_org_retest_claim_release_authorized_epoch(
   p.id,p_release,p_generation,p_deployment)
 THEN RAISE EXCEPTION 'The normal claim boundary cannot admit this one retest';END IF;
 INSERT INTO public.project_events(project_id,event,data) VALUES(
  p.id,'management_context_one_retest_owner_approved',
  jsonb_build_object('authorizationId',p_authorization,'releaseSha',p_release,
   'deploymentId',p_deployment,'generation',p_generation,
   'missionId',m.id,'assignmentId',j.id,'priorAttempts',1,
   'allowedAdditionalAttempts',1,'historicalMissions',(offer->>'historicalMissions')::integer,
   'contextChars',p_context_chars,'contextHash',p_context_hash,
   'cutoff',p.deadline,'watchdogRefreshedAt',stamp));
 RETURN jsonb_build_object('projectId',p.id,'stage','authorized','existing',false,
   'authorizationId',p_authorization,'releaseSha',p_release,
   'releaseGeneration',p_generation,'deploymentId',p_deployment,
   'scopeHash',p.approved_hash,'cutoff',p.deadline,
   'missionId',m.id,'assignmentId',j.id,'historicalMissions',
   (offer->>'historicalMissions')::integer,'maxMissions',96,
   'tokenAllowance',600000,'nodeCount',13,
   'originalAttempts',1,'additionalAttempts',1,
   'contextHash',p_context_hash,'contextChars',p_context_chars,
   'authorizedAt',stamp);
END
$authorize$;
REVOKE ALL ON FUNCTION public.project_org_context_retest_authorize(uuid,uuid,text,bigint,text,uuid,uuid,uuid,text,text,integer)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_context_retest_authorize(uuid,uuid,text,bigint,text,uuid,uuid,uuid,text,text,integer)
 TO service_role;

-- Preserve every previous release-admission branch. Add exactly one general
-- owner-signed, source-bound, one-attempt predicate without mission-ID logic.
DO $patch$
DECLARE installed text;anchor text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc
     WHERE oid='public.project_org_retest_claim_release_authorized_epoch(uuid,text,bigint,text)'::regprocedure)
    <> '1fcfa14088ace3903ebab9259f2a3c79'
 THEN RAISE EXCEPTION 'Unexpected installed exact-release worker admission definition'; END IF;
 installed:=pg_get_functiondef(
   'public.project_org_retest_claim_release_authorized_epoch(uuid,text,bigint,text)'::regprocedure);
 anchor:=E'  OR public.project_org_bounded_recovery_claim_authorized(p_project,p_release,p_generation,p_deployment)\n );';
 IF (length(installed)-length(replace(installed,anchor,'')))/length(anchor)<>1
 THEN RAISE EXCEPTION 'Expected final claim admission anchor not unique'; END IF;
 EXECUTE replace(installed,anchor,
   E'  OR public.project_org_bounded_recovery_claim_authorized(p_project,p_release,p_generation,p_deployment)\n  OR public.project_org_context_retest_claim_authorized(p_project,p_release,p_generation,p_deployment)\n );');
END
$patch$;
COMMIT;

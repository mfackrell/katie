-- P0 surgical recovery: one explicitly authorized second claim of the SAME
-- failed original Mission 79 assignment. No additional project, mission, cap,
-- cutoff or authority. The prior failed response and provider receipt survive.
BEGIN;

CREATE TABLE public.project_mission79_retry_receipts (
 project_id uuid PRIMARY KEY REFERENCES public.work_projects(id),
 authorization_id uuid NOT NULL UNIQUE,
 owner_id uuid NOT NULL,
 mission_id uuid NOT NULL,
 assignment_id uuid NOT NULL,
 release_sha text NOT NULL CHECK (release_sha ~ '^[0-9a-f]{40}$'),
 deployment_id text NOT NULL CHECK (deployment_id ~ '^dpl_[A-Za-z0-9]+$'),
 release_generation bigint NOT NULL CHECK (release_generation>0),
 scope_hash text NOT NULL,
 cutoff timestamptz NOT NULL,
 prior_attempts integer NOT NULL CHECK (prior_attempts=1),
 prior_calls integer NOT NULL CHECK (prior_calls=1),
 prior_rejection jsonb NOT NULL,
 prior_detail text NOT NULL,
 prior_provider_request_id uuid NOT NULL,
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.project_mission79_retry_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_mission79_retry_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER project_mission79_retry_immutable BEFORE UPDATE OR DELETE
 ON public.project_mission79_retry_receipts FOR EACH ROW
 EXECUTE FUNCTION public.project_org_change_immutable();

-- This offer does not mutate state and cannot stand in for the signed owner POST.
CREATE FUNCTION public.project_org_mission79_retry_offer(
 p_owner uuid,p_project uuid,p_release text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $retry_offer$
DECLARE
 p work_projects; a project_provider_execution;
 m agent_missions; j mission_assignments;
 g project_retest_production_release_gate;
 q project_retest_future_window_receipts;
 b project_retest_claim_release_receipts;
 prior project_provider_requests;
 receipt project_mission79_retry_receipts;
 st text;
BEGIN
 SELECT * INTO p FROM work_projects WHERE id=p_project;
 SELECT * INTO a FROM project_provider_execution WHERE project_id=p_project;
 SELECT * INTO g FROM project_retest_production_release_gate WHERE project_id=p_project;
 SELECT * INTO q FROM project_retest_future_window_receipts WHERE project_id=p_project;
 SELECT * INTO b FROM project_retest_claim_release_receipts WHERE project_id=p_project;
 SELECT * INTO m FROM agent_missions WHERE id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid AND project_id=p_project;
 SELECT * INTO j FROM mission_assignments WHERE id='85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid AND mission_id=m.id;
 SELECT * INTO receipt FROM project_mission79_retry_receipts WHERE project_id=p_project;
 SELECT * INTO prior FROM project_provider_requests
  WHERE id='804249c2-0782-4075-8072-bb5f38d32f6a'::uuid;
 IF p_project IS DISTINCT FROM 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  OR p.id IS NULL OR p_owner IS NULL OR a.owner_id IS DISTINCT FROM p_owner
  OR NOT standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
  OR p_release IS NULL OR p_release !~ '^[0-9a-f]{40}$'
  OR g.project_id IS NULL OR g.state<>'active'
  OR g.alias_name<>'katie-mu.vercel.app'
  OR g.release_sha IS DISTINCT FROM p_release
  OR g.generation<=0 OR g.deployment_id !~ '^dpl_[A-Za-z0-9]+$'
  OR q.project_id IS NULL OR b.project_id IS NULL
  OR q.owner_id IS DISTINCT FROM p_owner OR b.owner_id IS DISTINCT FROM p_owner
  OR q.mission_id IS DISTINCT FROM m.id OR q.assignment_id IS DISTINCT FROM j.id
  OR b.mission_id IS DISTINCT FROM m.id OR b.assignment_id IS DISTINCT FROM j.id
  OR q.authorization_id IS DISTINCT FROM b.window_id
  OR a.window_id IS DISTINCT FROM q.authorization_id
  OR p.deadline IS DISTINCT FROM q.cutoff OR a.deadline IS DISTINCT FROM q.cutoff
  OR m.deadline IS DISTINCT FROM q.cutoff OR b.cutoff IS DISTINCT FROM q.cutoff
  OR q.cutoff<=clock_timestamp()+interval '5 minutes'
  OR p.approved_hash IS DISTINCT FROM '4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
  OR p.approval_hash IS DISTINCT FROM p.approved_hash
  OR a.approved_scope IS DISTINCT FROM p.approved_hash
  OR q.scope_hash IS DISTINCT FROM p.approved_hash OR b.scope_hash IS DISTINCT FROM p.approved_hash
  OR p.max_missions<>96 OR p.token_allowance<>600000 OR p.organization_version<>1
  OR p.phase<>'development' OR p.active_mission_id IS DISTINCT FROM m.id
  OR (SELECT count(*) FROM agent_missions x WHERE x.project_id=p.id)<>79
  OR (SELECT count(*) FROM project_organization_nodes x WHERE x.project_id=p.id
    AND x.status='active' AND x.deadline=p.deadline)<>13
  OR EXISTS(SELECT 1 FROM project_work_packages x WHERE x.project_id=p.id)
  OR NOT project_org_retest_original_owner_lineage(p.id)
  OR NOT project_org_retest_renewed_assignment(m.id,j.id)
  OR NOT project_provider_continued_assignment(j.id)
  OR NOT project_provider_continued(p.id)
  OR project_provider_request_pending(p.id)
  OR prior.id IS NULL OR prior.project_id IS DISTINCT FROM p.id
  OR prior.mission_id IS DISTINCT FROM m.id
  OR prior.assignment_id IS DISTINCT FROM j.id
  OR prior.execution_attempt IS DISTINCT FROM '366cee0b-283b-47d6-99b5-afe90ce0baf8'
  OR prior.operation<>'inference' OR prior.resolved_at IS NULL
  OR (receipt.project_id IS NULL AND (SELECT count(*) FROM project_provider_requests x
      WHERE x.assignment_id=j.id AND x.operation='inference')<>1)
 THEN RAISE EXCEPTION 'Original Mission79 owner, project, release or prior inference evidence changed';END IF;
 IF receipt.project_id IS NOT NULL THEN
  IF receipt.owner_id IS DISTINCT FROM p_owner
   OR receipt.mission_id IS DISTINCT FROM m.id
   OR receipt.assignment_id IS DISTINCT FROM j.id
   OR receipt.scope_hash IS DISTINCT FROM p.approved_hash
   OR receipt.cutoff IS DISTINCT FROM q.cutoff
  THEN RAISE EXCEPTION 'Immutable one-time retry receipt lineage changed';END IF;
  st:=CASE WHEN j.attempts=1 AND j.status='queued' THEN 'authorized'
          WHEN j.attempts=2 THEN 'claimed' ELSE 'terminal' END;
  RETURN jsonb_build_object('projectId',p.id,'stage',st,
   'releaseSha',receipt.release_sha,'releaseGeneration',receipt.release_generation,
   'deploymentId',receipt.deployment_id,'missionId',m.id,'assignmentId',j.id,
   'scopeHash',receipt.scope_hash,'cutoff',receipt.cutoff,
   'authorizationId',receipt.authorization_id,'authorizedAt',receipt.authorized_at,
   'originalAttempts',receipt.prior_attempts,'originalCalls',receipt.prior_calls,
   'currentAttempts',j.attempts,'historicalMissions',79,'maxMissions',96,
   'tokenAllowance',600000,'nodeCount',13);
 END IF;
 IF p.status<>'blocked' OR m.status<>'blocked' OR m.calls<>1
  OR j.status<>'failed' OR j.attempts<>1
  OR j.lease IS NOT NULL OR j.lease_until IS NOT NULL
  OR p.lease IS NOT NULL OR p.lease_until IS NOT NULL
  OR j.result->'managementCommandRejection'->>'code' IS DISTINCT FROM 'director_appointment'
  OR j.result->'managementCommandRejection'->>'action' IS DISTINCT FROM 'appoint'
  OR j.result->'managementCommandRejection'->>'position' IS DISTINCT FROM '1'
  OR j.detail IS DISTINCT FROM 'Project Director commissions Functional Directors only'
  OR j.result IS NULL OR (SELECT count(*) FROM mission_assignments x WHERE x.mission_id=m.id)<>1
  OR (SELECT count(*) FROM project_organization_decisions x WHERE x.assignment_id=j.id)<>0
  OR EXISTS(SELECT 1 FROM agent_missions x WHERE x.project_id=p.id AND x.status IN ('draft','running','awaiting_approval'))
  OR EXISTS(SELECT 1 FROM mission_assignments x JOIN agent_missions k ON k.id=x.mission_id
     WHERE k.project_id=p.id AND x.status IN ('queued','running','waiting_external'))
 THEN RAISE EXCEPTION 'Original Mission79 failed single attempt is not eligible for retry approval';END IF;
 RETURN jsonb_build_object('projectId',p.id,'stage','approve_retry',
  'releaseSha',p_release,'releaseGeneration',g.generation,
  'deploymentId',g.deployment_id,'missionId',m.id,'assignmentId',j.id,
  'scopeHash',p.approved_hash,'cutoff',q.cutoff,'authorizationId',NULL,
  'originalAttempts',1,'originalCalls',1,'historicalMissions',79,
  'maxMissions',96,'tokenAllowance',600000,'nodeCount',13,
  'stateHash',project_org_hierarchy_recovery_state(p.id));
END
$retry_offer$;

REVOKE ALL ON FUNCTION public.project_org_mission79_retry_offer(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_mission79_retry_offer(uuid,uuid,text) TO service_role;

-- The owner press is the only way to create this receipt and queue one retry.
-- No migration, operator or cron creates consent.
CREATE FUNCTION public.project_org_mission79_retry_authorize(
 p_owner uuid,p_project uuid,p_release text,p_mission uuid,p_assignment uuid,
 p_authorization uuid,p_cutoff timestamptz,p_state_hash text,
 p_generation bigint,p_deployment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $retry_authorize$
DECLARE p work_projects; m agent_missions; j mission_assignments;
 offer jsonb; stamp timestamptz; old_result jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 SELECT * INTO p FROM work_projects WHERE id=p_project FOR UPDATE;
 PERFORM 1 FROM project_provider_execution WHERE project_id=p_project FOR UPDATE;
 PERFORM 1 FROM project_retest_production_release_gate WHERE project_id=p_project FOR UPDATE;
 SELECT * INTO m FROM agent_missions WHERE id=p_mission AND project_id=p_project FOR UPDATE;
 SELECT * INTO j FROM mission_assignments WHERE id=p_assignment AND mission_id=p_mission FOR UPDATE;
 IF p_authorization IS NULL OR p_state_hash IS NULL
  OR p_mission IS DISTINCT FROM 'b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
  OR p_assignment IS DISTINCT FROM '85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
  OR p_cutoff IS NULL OR p_cutoff<=clock_timestamp()+interval '5 minutes'
  OR p_generation IS NULL OR p_generation<=0
  OR p_deployment IS NULL OR p_deployment !~ '^dpl_[A-Za-z0-9]+$'
 THEN RAISE EXCEPTION 'Exact one-time Mission79 retry authorization required';END IF;
 offer:=project_org_mission79_retry_offer(p_owner,p_project,p_release);
 IF offer->>'stage' IS DISTINCT FROM 'approve_retry'
  OR (offer->>'releaseGeneration')::bigint IS DISTINCT FROM p_generation
  OR offer->>'deploymentId' IS DISTINCT FROM p_deployment
  OR (offer->>'cutoff')::timestamptz IS DISTINCT FROM p_cutoff
  OR offer->>'stateHash' IS DISTINCT FROM p_state_hash
 THEN RAISE EXCEPTION 'One-time Mission79 owner preflight expired or was already consumed';END IF;
 IF j.status<>'failed' OR j.attempts<>1 OR m.calls<>1
  OR j.result->'managementCommandRejection'->>'code' IS DISTINCT FROM 'director_appointment'
 THEN RAISE EXCEPTION 'Original failed attempt changed before owner authorization';END IF;
 stamp:=clock_timestamp();
 old_result:=j.result;
 INSERT INTO project_mission79_retry_receipts
 (project_id,authorization_id,owner_id,mission_id,assignment_id,
  release_sha,deployment_id,release_generation,scope_hash,cutoff,
  prior_attempts,prior_calls,prior_rejection,prior_detail,prior_provider_request_id,authorized_at)
 VALUES(p.id,p_authorization,p_owner,m.id,j.id,
  p_release,p_deployment,p_generation,p.approved_hash,p_cutoff,
  j.attempts,m.calls,old_result,j.detail,
  '804249c2-0782-4075-8072-bb5f38d32f6a'::uuid,stamp);
 UPDATE mission_assignments
  SET status='queued',available_at=stamp,updated_at=stamp,
   detail='One additional owner-authorized management attempt is queued; prior failed response archived in immutable receipt.'
 WHERE id=j.id AND status='failed' AND attempts=1;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original failed job changed under lock';END IF;
 UPDATE agent_missions
  SET status='running',updated_at=stamp,
  detail='One corrected Project Director retry explicitly authorized; one prior provider call retained.'
 WHERE id=m.id AND status='blocked' AND calls=1;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original failed mission changed under lock';END IF;
 UPDATE work_projects
  SET status='running',updated_at=stamp,
  detail='Owner authorized one additional Mission79 attempt under unchanged scope and cutoff.'
 WHERE id=p.id AND status='blocked';
 IF NOT FOUND THEN RAISE EXCEPTION 'Original blocked project changed under lock';END IF;
 INSERT INTO project_events(project_id,event,data)
 VALUES(p.id,'mission79_single_retry_owner_authorized',
  jsonb_build_object('authorizationId',p_authorization,'missionId',m.id,
   'assignmentId',j.id,'priorAttempts',1,'priorCalls',1,
   'releaseSha',p_release,'deploymentId',p_deployment,'releaseGeneration',p_generation,
   'cutoff',p_cutoff,'originalProviderRequestId','804249c2-0782-4075-8072-bb5f38d32f6a',
   'authorizedAt',stamp));
 RETURN jsonb_build_object('projectId',p.id,'stage','authorized','existing',false,
   'authorizationId',p_authorization,'authorizedAt',stamp,
   'releaseSha',p_release,'releaseGeneration',p_generation,'deploymentId',p_deployment,
   'missionId',m.id,'assignmentId',j.id,'scopeHash',p.approved_hash,
   'cutoff',p_cutoff,'originalAttempts',1,'originalCalls',1,
   'historicalMissions',79,'maxMissions',96,'tokenAllowance',600000,'nodeCount',13);
END
$retry_authorize$;
REVOKE ALL ON FUNCTION public.project_org_mission79_retry_authorize(uuid,uuid,text,uuid,uuid,uuid,timestamptz,text,bigint,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_mission79_retry_authorize(uuid,uuid,text,uuid,uuid,uuid,timestamptz,text,bigint,text) TO service_role;

-- SQL claim predicate is TRUE only for the UNCLAIMED second attempt.
CREATE FUNCTION public.project_org_mission79_retry_claim_authorized(
 p_project uuid,p_release text,p_generation bigint,p_deployment text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $retry_claim$
 SELECT EXISTS (
  SELECT 1 FROM public.project_mission79_retry_receipts r
  JOIN public.project_retest_production_release_gate g ON g.project_id=r.project_id
    AND g.state='active' AND g.alias_name='katie-mu.vercel.app'
    AND g.release_sha=r.release_sha AND g.generation=r.release_generation
    AND g.deployment_id=r.deployment_id
  JOIN public.work_projects p ON p.id=r.project_id
    AND p.status='running' AND p.active_mission_id=r.mission_id
    AND p.deadline=r.cutoff AND p.deadline>clock_timestamp()
    AND p.approved_hash=r.scope_hash AND p.approval_hash=r.scope_hash
    AND p.max_missions=96 AND p.token_allowance=600000
  JOIN public.agent_missions m ON m.id=r.mission_id AND m.project_id=p.id
    AND m.status='running' AND m.calls=1 AND m.deadline=r.cutoff
  JOIN public.mission_assignments j ON j.id=r.assignment_id AND j.mission_id=m.id
    AND j.status='queued' AND j.attempts=1
    AND j.lease IS NULL AND j.lease_until IS NULL
    AND j.result=r.prior_rejection AND j.detail IS NOT NULL
  JOIN public.project_provider_execution a ON a.project_id=p.id
    AND a.owner_id=r.owner_id AND a.deadline=r.cutoff
  JOIN public.project_retest_future_window_receipts q ON q.project_id=p.id
    AND q.owner_id=r.owner_id AND q.cutoff=r.cutoff
    AND q.mission_id=m.id AND q.assignment_id=j.id
  JOIN public.project_retest_claim_release_receipts old_bind ON old_bind.project_id=p.id
    AND old_bind.owner_id=r.owner_id AND old_bind.assignment_id=j.id
    AND old_bind.mission_id=m.id
  WHERE r.project_id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
   AND r.mission_id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
   AND r.assignment_id='85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
   AND r.project_id=p_project AND r.release_sha=p_release
   AND r.release_generation=p_generation AND r.deployment_id=p_deployment
   AND r.prior_attempts=1 AND r.prior_calls=1
   AND r.prior_provider_request_id='804249c2-0782-4075-8072-bb5f38d32f6a'::uuid
   AND (SELECT count(*) FROM agent_missions x WHERE x.project_id=p.id)=79
   AND NOT public.project_provider_request_pending(p.id)
   AND public.project_provider_continued_assignment(j.id)
 );
$retry_claim$;
REVOKE ALL ON FUNCTION public.project_org_mission79_retry_claim_authorized(uuid,text,bigint,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_mission79_retry_claim_authorized(uuid,text,bigint,text) TO service_role;

-- The existing worker claim uses this exact fence twice: once in SELECT
-- under the global claim lock and again in the UPDATE before incrementing.
CREATE OR REPLACE FUNCTION public.project_org_retest_claim_release_authorized_epoch(
 p_project uuid,p_release text,p_generation bigint,p_deployment text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $original_or_retry$
 SELECT (
  (coalesce(p_generation>0,false)
   AND public.project_org_retest_claim_release_authorized(p_project,p_release)
   AND EXISTS (
    SELECT 1 FROM public.project_retest_production_release_gate g
    JOIN public.project_retest_claim_release_receipts receipt ON receipt.project_id=g.project_id
     AND receipt.bound_release_sha=p_release
     AND receipt.bound_release_generation=p_generation
     AND receipt.bound_deployment_id=p_deployment
    WHERE g.project_id=p_project AND g.release_sha=p_release
     AND g.state='active' AND g.alias_name='katie-mu.vercel.app'
     AND g.generation=p_generation AND g.deployment_id=p_deployment
   ))
  OR public.project_org_mission79_retry_claim_authorized(p_project,p_release,p_generation,p_deployment)
 );
$original_or_retry$;

-- The management executor may consume its SECOND provider call only after
-- the normal scheduler has leased this exact second attempt. No third attempt.
CREATE FUNCTION public.project_org_mission79_retry_execution_authorized(
 p_job uuid,p_lease uuid,p_release text,p_deployment text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $retry_execution$
 SELECT EXISTS(
  SELECT 1 FROM public.project_mission79_retry_receipts r
  JOIN public.project_retest_production_release_gate g ON g.project_id=r.project_id
    AND g.state='active' AND g.release_sha=r.release_sha
    AND g.generation=r.release_generation AND g.deployment_id=r.deployment_id
    AND g.alias_name='katie-mu.vercel.app'
  JOIN public.work_projects p ON p.id=r.project_id
    AND p.status='running' AND p.active_mission_id=r.mission_id
    AND p.deadline=r.cutoff AND p.deadline>clock_timestamp()
  JOIN public.agent_missions m ON m.id=r.mission_id AND m.project_id=p.id
    AND m.status='running' AND m.calls=1 AND m.deadline=r.cutoff
  JOIN public.mission_assignments j ON j.id=r.assignment_id AND j.mission_id=m.id
    AND j.status='running' AND j.attempts=2 AND j.lease=p_lease
    AND j.lease IS NOT NULL AND j.lease_until>clock_timestamp()
  WHERE r.project_id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
   AND r.mission_id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
   AND r.assignment_id='85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
   AND r.prior_attempts=1 AND r.prior_calls=1
   AND j.id=p_job AND j.lease=p_lease AND r.release_sha=p_release
   AND r.deployment_id=p_deployment
 );
$retry_execution$;
REVOKE ALL ON FUNCTION public.project_org_mission79_retry_execution_authorized(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_mission79_retry_execution_authorized(uuid,uuid,text,text) TO service_role;

-- The first-retry claim cannot use legacy Mission79 expiry settlement because
-- that old receipt belongs to a different immutable production release.
-- A second, expired lease is SETTLED, never requeued or spent again. The normal
-- mission cron calls this once per tick before attempting any new claim.
CREATE FUNCTION public.project_org_mission79_retry_settle_expired()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $retry_settle$
DECLARE j mission_assignments; r project_mission79_retry_receipts;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 UPDATE mission_assignments assignment
 SET status='failed',lease=NULL,lease_until=NULL,updated_at=clock_timestamp(),
  detail='Original Mission79 owner-authorized second attempt terminally settled after lease expiry; no third retry.'
 FROM project_mission79_retry_receipts receipt
 JOIN project_retest_production_release_gate gate ON gate.project_id=receipt.project_id
 JOIN agent_missions mission ON mission.id=receipt.mission_id
 JOIN work_projects project ON project.id=receipt.project_id
 WHERE receipt.project_id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  AND receipt.mission_id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
  AND receipt.assignment_id='85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
  AND assignment.id=receipt.assignment_id AND assignment.mission_id=mission.id
  AND assignment.status='running' AND assignment.attempts=2
  AND assignment.lease IS NOT NULL AND assignment.lease_until<=clock_timestamp()
  AND mission.calls BETWEEN 1 AND 2
  AND mission.project_id=project.id AND mission.status='running'
  AND project.active_mission_id=mission.id
  AND project.deadline=receipt.cutoff AND mission.deadline=receipt.cutoff
  AND gate.release_sha=receipt.release_sha
  AND gate.deployment_id=receipt.deployment_id
  AND gate.generation=receipt.release_generation
  AND gate.state='active' AND gate.alias_name='katie-mu.vercel.app'
  AND NOT project_provider_request_pending(project.id)
 RETURNING assignment.* INTO j;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO r FROM project_mission79_retry_receipts WHERE assignment_id=j.id;
 UPDATE agent_missions SET status='blocked',updated_at=clock_timestamp(),
  detail='Original Mission79 second attempt expired; result not confirmed, prior owner and provider evidence preserved.'
 WHERE id=r.mission_id AND status='running';
 UPDATE work_projects SET status='blocked',updated_at=clock_timestamp(),
  detail='One owner-authorized Mission79 retry exhausted without terminal result. No additional paid claim.'
 WHERE id=r.project_id AND active_mission_id=r.mission_id AND status='running';
 INSERT INTO project_events(project_id,event,data) VALUES(r.project_id,'mission79_retry_expired_terminally_settled',
  jsonb_build_object('missionId',r.mission_id,'assignmentId',r.assignment_id,
   'authorizationId',r.authorization_id,'priorAttempts',r.prior_attempts,
   'finalAttempts',j.attempts,'releaseSha',r.release_sha,
   'deploymentId',r.deployment_id,'releaseGeneration',r.release_generation,
   'settledAt',clock_timestamp()));
 RETURN true;
END $retry_settle$;
REVOKE ALL ON FUNCTION public.project_org_mission79_retry_settle_expired() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_mission79_retry_settle_expired() TO service_role;

COMMIT;

-- P0: preserve the one paid Mission79 retry when the generic 45-minute
-- project watchdog overtakes an authenticated authorization.
-- Existing owner retry and old paid failure are immutable and unchanged.
BEGIN;

CREATE TABLE public.project_mission79_watchdog_recovery_receipts (
 project_id uuid PRIMARY KEY REFERENCES public.work_projects(id),
 authorization_id uuid NOT NULL UNIQUE,
 original_retry_authorization_id uuid NOT NULL REFERENCES public.project_mission79_retry_receipts(authorization_id),
 owner_id uuid NOT NULL,
 mission_id uuid NOT NULL,
 assignment_id uuid NOT NULL,
 release_sha text NOT NULL CHECK(release_sha ~ '^[0-9a-f]{40}$'),
 deployment_id text NOT NULL CHECK(deployment_id ~ '^dpl_[A-Za-z0-9]+$'),
 release_generation bigint NOT NULL CHECK(release_generation>0),
 scope_hash text NOT NULL,
 cutoff timestamptz NOT NULL,
 blocked_event_id uuid NOT NULL REFERENCES public.project_events(id),
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.project_mission79_watchdog_recovery_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_mission79_watchdog_recovery_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER project_mission79_watchdog_recovery_immutable BEFORE UPDATE OR DELETE
 ON public.project_mission79_watchdog_recovery_receipts FOR EACH ROW
 EXECUTE FUNCTION public.project_org_change_immutable();

-- Read-only offer: exactly the already-authorized, unclaimed second attempt.
-- Its old receipt can never be silently transplanted to a new release.
CREATE FUNCTION public.project_org_mission79_watchdog_offer(
 p_owner uuid,p_project uuid,p_release text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $m79offer$
DECLARE
 p work_projects;g project_retest_production_release_gate;
 r project_mission79_retry_receipts;
 w project_mission79_watchdog_recovery_receipts;
 m agent_missions;j mission_assignments;a project_provider_execution;
 q project_retest_future_window_receipts;ev project_events;
 stage text;hash text;
BEGIN
 SELECT * INTO p FROM work_projects WHERE id=p_project;
 SELECT * INTO g FROM project_retest_production_release_gate WHERE project_id=p_project;
 SELECT * INTO r FROM project_mission79_retry_receipts WHERE project_id=p_project;
 SELECT * INTO w FROM project_mission79_watchdog_recovery_receipts WHERE project_id=p_project;
 SELECT * INTO m FROM agent_missions WHERE id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid AND project_id=p_project;
 SELECT * INTO j FROM mission_assignments WHERE id='85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid AND mission_id=m.id;
 SELECT * INTO a FROM project_provider_execution WHERE project_id=p_project;
 SELECT * INTO q FROM project_retest_future_window_receipts WHERE project_id=p_project;
 SELECT * INTO ev FROM project_events
  WHERE project_id=p_project AND event='block' AND created_at>r.authorized_at
   AND data->>'detail'='No new completed artifact or external execution transition for 00:45:00 in development. Work is blocked; saved results and charges are retained.'
  ORDER BY created_at DESC LIMIT 1;
 IF p_project IS DISTINCT FROM 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  OR p_owner IS NULL OR p.id IS NULL OR a.owner_id IS DISTINCT FROM p_owner
  OR NOT standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
  OR r.project_id IS NULL OR r.authorization_id IS NULL
  OR r.owner_id IS DISTINCT FROM p_owner
  OR r.mission_id IS DISTINCT FROM m.id OR r.assignment_id IS DISTINCT FROM j.id
  OR r.prior_calls<>1 OR r.prior_attempts<>1
  OR r.prior_provider_request_id IS DISTINCT FROM '804249c2-0782-4075-8072-bb5f38d32f6a'::uuid
  OR m.id IS NULL OR m.calls<>1 OR j.id IS NULL OR j.attempts<>1
  OR j.status<>'queued' OR j.lease IS NOT NULL OR j.lease_until IS NOT NULL
  OR j.result IS DISTINCT FROM r.prior_rejection
  OR m.status<>'running'
  OR p.active_mission_id IS DISTINCT FROM m.id
  OR p.phase<>'development' OR p.organization_version<>1
  OR p.approved_hash IS DISTINCT FROM r.scope_hash OR p.approval_hash IS DISTINCT FROM r.scope_hash
  OR p.max_missions<>96 OR p.token_allowance<>600000
  OR p.deadline IS DISTINCT FROM r.cutoff OR a.deadline IS DISTINCT FROM r.cutoff
  OR m.deadline IS DISTINCT FROM r.cutoff OR q.cutoff IS DISTINCT FROM r.cutoff
  OR q.owner_id IS DISTINCT FROM p_owner
  OR p.deadline<=clock_timestamp()+interval '5 minutes'
  OR (SELECT COUNT(*) FROM agent_missions x WHERE x.project_id=p.id)<>79
  OR (SELECT COUNT(*) FROM project_organization_nodes x WHERE x.project_id=p.id AND x.status='active')<>13
  OR EXISTS(SELECT 1 FROM project_work_packages x WHERE x.project_id=p.id)
  OR project_provider_request_pending(p.id)
  OR NOT project_provider_continued_assignment(j.id)
  OR g.project_id IS NULL OR g.state<>'active' OR g.alias_name<>'katie-mu.vercel.app'
  OR g.release_sha IS DISTINCT FROM p_release OR g.generation<=0
  OR g.deployment_id !~ '^dpl_[A-Za-z0-9]+$'
 THEN RAISE EXCEPTION 'Original Mission79 retry, owner, limits or canonical release changed';END IF;
 IF w.project_id IS NOT NULL THEN
  IF w.authorization_id IS NULL OR w.owner_id IS DISTINCT FROM p_owner
   OR w.original_retry_authorization_id IS DISTINCT FROM r.authorization_id
   OR w.release_sha IS DISTINCT FROM p_release
   OR w.deployment_id IS DISTINCT FROM g.deployment_id
   OR w.release_generation IS DISTINCT FROM g.generation
  THEN RAISE EXCEPTION 'Watchdog recovery authority is stale or consumed on another release';END IF;
  stage:=CASE WHEN j.attempts=2 THEN 'claimed' WHEN p.status='running' THEN 'recovered' ELSE 'terminal' END;
  RETURN jsonb_build_object('projectId',p.id,'stage',stage,
   'releaseSha',w.release_sha,'releaseGeneration',w.release_generation,
   'deploymentId',w.deployment_id,'missionId',m.id,'assignmentId',j.id,
   'scopeHash',w.scope_hash,'cutoff',w.cutoff,
   'priorAuthorizationId',r.authorization_id,'authorizationId',w.authorization_id,
   'authorizedAt',w.authorized_at,'originalAttempts',1,'originalCalls',1,
   'currentAttempts',j.attempts,'historicalMissions',79,'maxMissions',96,
   'tokenAllowance',600000,'nodeCount',13);
 END IF;
 IF p.status<>'blocked' OR p.lease IS NOT NULL OR p.lease_until IS NOT NULL
  OR p.detail IS DISTINCT FROM 'No new completed artifact or external execution transition for 00:45:00 in development. Work is blocked; saved results and charges are retained.'
  OR ev.id IS NULL OR ev.created_at<=r.authorized_at
 THEN RAISE EXCEPTION 'Exact original post-authorization watchdog block not present';END IF;
 hash:=encode(sha256(convert_to(concat_ws('|',p.id,r.authorization_id,p.status,
  p.progress_since,j.id,j.status,j.attempts,m.id,m.status,m.calls,
  g.release_sha,g.generation,g.deployment_id,p.deadline,ev.id),'UTF8')),'hex');
 RETURN jsonb_build_object('projectId',p.id,'stage','recover_watchdog',
  'releaseSha',p_release,'releaseGeneration',g.generation,'deploymentId',g.deployment_id,
  'missionId',m.id,'assignmentId',j.id,'scopeHash',r.scope_hash,
  'cutoff',r.cutoff,'authorizationId',NULL,'priorAuthorizationId',r.authorization_id,
  'stateHash',hash,'originalAttempts',1,'originalCalls',1,
  'historicalMissions',79,'maxMissions',96,'tokenAllowance',600000,'nodeCount',13);
END
$m79offer$;
REVOKE ALL ON FUNCTION public.project_org_mission79_watchdog_offer(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_mission79_watchdog_offer(uuid,uuid,text) TO service_role;

-- First-party authenticated POST only. Global project/claim locks prevent a
-- pending watchdog from committing an obsolete pre-authorization observation.
CREATE FUNCTION public.project_org_mission79_watchdog_recover(
 p_owner uuid,p_project uuid,p_release text,p_mission uuid,p_assignment uuid,
 p_authorization uuid,p_prior_authorization uuid,p_cutoff timestamptz,
 p_state_hash text,p_generation bigint,p_deployment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $m79recover$
DECLARE p work_projects; j mission_assignments;m agent_missions;
 offer jsonb;stamp timestamptz;ev project_events;r project_mission79_retry_receipts;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 SELECT * INTO p FROM work_projects WHERE id=p_project FOR UPDATE;
 PERFORM 1 FROM project_retest_production_release_gate WHERE project_id=p_project FOR UPDATE;
 SELECT * INTO m FROM agent_missions WHERE id=p_mission AND project_id=p_project FOR UPDATE;
 SELECT * INTO j FROM mission_assignments WHERE id=p_assignment AND mission_id=p_mission FOR UPDATE;
 SELECT * INTO r FROM project_mission79_retry_receipts WHERE project_id=p_project;
 IF p_authorization IS NULL OR p_authorization=p_prior_authorization
  OR p_mission IS DISTINCT FROM 'b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
  OR p_assignment IS DISTINCT FROM '85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
  OR p_prior_authorization IS DISTINCT FROM r.authorization_id
  OR p_cutoff<=clock_timestamp()+interval '5 minutes'
 THEN RAISE EXCEPTION 'New release-bound owner authorization required';END IF;
 offer:=project_org_mission79_watchdog_offer(p_owner,p_project,p_release);
 IF offer->>'stage' IS DISTINCT FROM 'recover_watchdog'
  OR offer->>'stateHash' IS DISTINCT FROM p_state_hash
  OR offer->>'priorAuthorizationId' IS DISTINCT FROM p_prior_authorization::text
  OR (offer->>'releaseGeneration')::bigint IS DISTINCT FROM p_generation
  OR offer->>'deploymentId' IS DISTINCT FROM p_deployment
  OR (offer->>'cutoff')::timestamptz IS DISTINCT FROM p_cutoff
 THEN RAISE EXCEPTION 'Watchdog recovery owner preflight already used or state changed';END IF;
 SELECT * INTO ev FROM project_events WHERE project_id=p_project
  AND event='block' AND created_at>r.authorized_at
  ORDER BY created_at DESC LIMIT 1;
 stamp:=clock_timestamp();
 INSERT INTO project_mission79_watchdog_recovery_receipts
 (project_id,authorization_id,original_retry_authorization_id,owner_id,
  mission_id,assignment_id,release_sha,deployment_id,release_generation,
  scope_hash,cutoff,blocked_event_id,authorized_at)
 VALUES(p.id,p_authorization,r.authorization_id,p_owner,m.id,j.id,
  p_release,p_deployment,p_generation,r.scope_hash,p_cutoff,ev.id,stamp);
 UPDATE work_projects SET status='running',progress_since=stamp,updated_at=stamp,
  detail='Owner recovered original queued Mission79 retry from stale watchdog under exact production release.'
 WHERE id=p.id AND status='blocked' AND lease IS NULL AND lease_until IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original blocked project changed under lock';END IF;
 IF NOT project_org_retest_claim_release_authorized_epoch(p.id,p_release,p_generation,p_deployment)
 THEN RAISE EXCEPTION 'Recovered retry does not pass exact scheduler claim admission';END IF;
 INSERT INTO project_events(project_id,event,data) VALUES(p.id,'mission79_watchdog_owner_recovered',
  jsonb_build_object('authorizationId',p_authorization,
   'originalRetryAuthorizationId',r.authorization_id,'missionId',m.id,
   'assignmentId',j.id,'releaseSha',p_release,'releaseGeneration',p_generation,
   'deploymentId',p_deployment,'cutoff',p_cutoff,'authorizedAt',stamp));
 RETURN jsonb_build_object('projectId',p.id,'stage','recovered','existing',false,
  'authorizationId',p_authorization,'priorAuthorizationId',r.authorization_id,
  'authorizedAt',stamp,'releaseSha',p_release,'releaseGeneration',p_generation,
  'deploymentId',p_deployment,'missionId',m.id,'assignmentId',j.id,
  'scopeHash',r.scope_hash,'cutoff',p_cutoff,
  'originalAttempts',1,'originalCalls',1,'currentAttempts',1,
  'historicalMissions',79,'maxMissions',96,'tokenAllowance',600000,'nodeCount',13);
END
$m79recover$;
REVOKE ALL ON FUNCTION public.project_org_mission79_watchdog_recover(uuid,uuid,text,uuid,uuid,uuid,uuid,timestamptz,text,bigint,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_mission79_watchdog_recover(uuid,uuid,text,uuid,uuid,uuid,uuid,timestamptz,text,bigint,text) TO service_role;

-- Patch only four existing original retry routines, keeping global locks and
-- all other predicates. The new immutable release receipt is an explicit,
-- owner-signed substitute for the old *release binding*, not new paid attempts.
DO $patch$
DECLARE s text;t text;
BEGIN
 SELECT pg_get_functiondef('public.project_org_mission79_retry_authorize(uuid,uuid,text,uuid,uuid,uuid,timestamptz,text,bigint,text)'::regprocedure) INTO s;
 IF (length(s)-length(replace(s,'SET status=''running'',updated_at=stamp,','')))/length('SET status=''running'',updated_at=stamp,')<>1
 THEN RAISE EXCEPTION 'Unexpected original owner retry status contract';END IF;
 t:=replace(s,'SET status=''running'',updated_at=stamp,','SET status=''running'',progress_since=stamp,updated_at=stamp,');
 EXECUTE t;

 SELECT pg_get_functiondef('public.project_org_mission79_retry_claim_authorized(uuid,text,bigint,text)'::regprocedure) INTO s;
 IF (length(s)-length(replace(s,'JOIN public.project_retest_production_release_gate g ON g.project_id=r.project_id','')))/length('JOIN public.project_retest_production_release_gate g ON g.project_id=r.project_id')<>1
 THEN RAISE EXCEPTION 'Unexpected Mission79 retry claim fence';END IF;
 t:=replace(s,'JOIN public.project_retest_production_release_gate g ON g.project_id=r.project_id',
  'LEFT JOIN public.project_mission79_watchdog_recovery_receipts w ON w.project_id=r.project_id AND w.original_retry_authorization_id=r.authorization_id AND w.owner_id=r.owner_id AND w.cutoff=r.cutoff AND w.scope_hash=r.scope_hash'||chr(10)||
  '  JOIN public.project_retest_production_release_gate g ON g.project_id=r.project_id');
 t:=replace(t,'g.release_sha=r.release_sha AND g.generation=r.release_generation',
  'g.release_sha=coalesce(w.release_sha,r.release_sha) AND g.generation=coalesce(w.release_generation,r.release_generation)');
 t:=replace(t,'g.deployment_id=r.deployment_id','g.deployment_id=coalesce(w.deployment_id,r.deployment_id)');
 t:=replace(t,'r.project_id=p_project AND r.release_sha=p_release','r.project_id=p_project AND coalesce(w.release_sha,r.release_sha)=p_release');
 t:=replace(t,'r.release_generation=p_generation AND r.deployment_id=p_deployment',
  'coalesce(w.release_generation,r.release_generation)=p_generation AND coalesce(w.deployment_id,r.deployment_id)=p_deployment');
 IF t=s OR position('coalesce(w.release_sha,r.release_sha)=p_release' IN t)=0
 THEN RAISE EXCEPTION 'Mission79 retry release pin substitution failed';END IF;
 EXECUTE t;

 SELECT pg_get_functiondef('public.project_org_mission79_retry_execution_authorized(uuid,uuid,text,text)'::regprocedure) INTO s;
 IF position('JOIN public.project_retest_production_release_gate g ON g.project_id=r.project_id' IN s)=0
 THEN RAISE EXCEPTION 'Unexpected Mission79 paid retry authorization';END IF;
 t:=replace(s,'JOIN public.project_retest_production_release_gate g ON g.project_id=r.project_id',
  'LEFT JOIN public.project_mission79_watchdog_recovery_receipts w ON w.project_id=r.project_id AND w.original_retry_authorization_id=r.authorization_id AND w.owner_id=r.owner_id AND w.cutoff=r.cutoff'||chr(10)||
  '  JOIN public.project_retest_production_release_gate g ON g.project_id=r.project_id');
 t:=replace(t,'g.state=''active'' AND g.release_sha=r.release_sha','g.state=''active'' AND g.release_sha=coalesce(w.release_sha,r.release_sha)');
 t:=replace(t,'g.generation=r.release_generation AND g.deployment_id=r.deployment_id',
  'g.generation=coalesce(w.release_generation,r.release_generation) AND g.deployment_id=coalesce(w.deployment_id,r.deployment_id)');
 t:=replace(t,'r.release_sha=p_release','coalesce(w.release_sha,r.release_sha)=p_release');
 t:=replace(t,'r.deployment_id=p_deployment','coalesce(w.deployment_id,r.deployment_id)=p_deployment');
 IF t=s OR position('coalesce(w.release_sha,r.release_sha)=p_release' IN t)=0
 THEN RAISE EXCEPTION 'Mission79 paid release check substitution failed';END IF;
 EXECUTE t;

 SELECT pg_get_functiondef('public.project_org_mission79_retry_settle_expired()'::regprocedure) INTO s;
 IF position('JOIN project_retest_production_release_gate gate ON gate.project_id=receipt.project_id' IN s)=0
 THEN RAISE EXCEPTION 'Unexpected Mission79 terminal settlement';END IF;
 t:=replace(s,'JOIN project_retest_production_release_gate gate ON gate.project_id=receipt.project_id',
  'LEFT JOIN project_mission79_watchdog_recovery_receipts w ON w.project_id=receipt.project_id AND w.original_retry_authorization_id=receipt.authorization_id'||chr(10)||
  ' JOIN project_retest_production_release_gate gate ON gate.project_id=receipt.project_id');
 t:=replace(t,'gate.release_sha=receipt.release_sha','gate.release_sha=coalesce(w.release_sha,receipt.release_sha)');
 t:=replace(t,'gate.deployment_id=receipt.deployment_id','gate.deployment_id=coalesce(w.deployment_id,receipt.deployment_id)');
 t:=replace(t,'gate.generation=receipt.release_generation','gate.generation=coalesce(w.release_generation,receipt.release_generation)');
 IF t=s OR position('coalesce(w.release_sha,receipt.release_sha)' IN t)=0
 THEN RAISE EXCEPTION 'Mission79 expired lease release substitution failed';END IF;
 EXECUTE t;
END
$patch$;
COMMIT;

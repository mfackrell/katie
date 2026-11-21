-- P0 owner-authenticated Mission80 recovery + bounded downstream continuation.
-- No automatic consent, new project, manual claim, extra retry or timeout changes.
BEGIN;

CREATE TABLE public.project_mission80_watchdog_recovery_receipts (
 project_id uuid PRIMARY KEY REFERENCES public.work_projects(id),
 authorization_id uuid NOT NULL UNIQUE,
 owner_id uuid NOT NULL,
 mission_id uuid NOT NULL,
 assignment_id uuid NOT NULL,
 release_sha text NOT NULL CHECK(release_sha ~ '^[a-f0-9]{40}$'),
 release_generation bigint NOT NULL CHECK(release_generation>0),
 deployment_id text NOT NULL CHECK(deployment_id ~ '^dpl_[A-Za-z0-9]+$'),
 scope_hash text NOT NULL,
 cutoff timestamptz NOT NULL,
 blocked_event_id uuid NOT NULL REFERENCES public.project_events(id),
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.project_mission80_watchdog_recovery_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_mission80_watchdog_recovery_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER project_mission80_watchdog_receipt_immutable
 BEFORE UPDATE OR DELETE ON public.project_mission80_watchdog_recovery_receipts
 FOR EACH ROW EXECUTE FUNCTION public.project_org_change_immutable();

CREATE FUNCTION public.project_org_mission80_watchdog_offer(
 p_owner uuid,p_project uuid,p_release text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $m80offer$
DECLARE
 p work_projects;g project_retest_production_release_gate;
 a project_provider_execution;q project_retest_future_window_receipts;
 m agent_missions;j mission_assignments;
 r79 project_mission79_retry_receipts;w79 project_mission79_watchdog_recovery_receipts;
 m79 agent_missions;j79 mission_assignments;
 saved project_mission80_watchdog_recovery_receipts;
 ev project_events;state_hash text;stage text;
BEGIN
 SELECT * INTO p FROM work_projects WHERE id=p_project;
 SELECT * INTO g FROM project_retest_production_release_gate WHERE project_id=p_project;
 SELECT * INTO a FROM project_provider_execution WHERE project_id=p_project;
 SELECT * INTO q FROM project_retest_future_window_receipts WHERE project_id=p_project;
 SELECT * INTO m FROM agent_missions WHERE id='ce8dcc30-e316-49e7-934d-6add6c14a697'::uuid AND project_id=p_project;
 SELECT * INTO j FROM mission_assignments WHERE id='3d118a6c-d121-4d65-8c6e-ed5620660b82'::uuid AND mission_id=m.id;
 SELECT * INTO r79 FROM project_mission79_retry_receipts WHERE project_id=p_project;
 SELECT * INTO w79 FROM project_mission79_watchdog_recovery_receipts WHERE project_id=p_project;
 SELECT * INTO m79 FROM agent_missions WHERE id=r79.mission_id AND project_id=p_project;
 SELECT * INTO j79 FROM mission_assignments WHERE id=r79.assignment_id AND mission_id=m79.id;
 SELECT * INTO saved FROM project_mission80_watchdog_recovery_receipts WHERE project_id=p_project;
 SELECT * INTO ev FROM project_events e
  WHERE e.project_id=p_project AND e.event='block'
   AND e.created_at=p.updated_at
   AND e.data->>'detail'='No new completed artifact or external execution transition for 00:45:00 in development. Work is blocked; saved results and charges are retained.'
  ORDER BY e.created_at DESC LIMIT 1;

 IF p_project IS DISTINCT FROM 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  OR p_owner IS NULL OR p.id IS NULL OR a.owner_id IS DISTINCT FROM p_owner
  OR NOT standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
  OR m.id IS NULL OR j.id IS NULL OR r79.project_id IS NULL OR w79.project_id IS NULL
  OR w79.owner_id IS DISTINCT FROM p_owner
  OR w79.original_retry_authorization_id IS DISTINCT FROM r79.authorization_id
  OR w79.mission_id IS DISTINCT FROM m79.id OR w79.assignment_id IS DISTINCT FROM j79.id
  OR m79.status<>'completed' OR m79.calls<>2
  OR j79.status<>'completed' OR j79.attempts<>2
  OR NOT EXISTS (SELECT 1 FROM project_organization_decisions d
       WHERE d.project_id=p.id AND d.assignment_id=j79.id
        AND d.id::text=j79.result->>'decisionId'
        AND w79.authorized_at<d.created_at AND d.created_at<m.created_at)
  OR q.project_id IS NULL OR q.owner_id IS DISTINCT FROM p_owner
  OR q.authorization_id IS DISTINCT FROM a.window_id
  OR q.cutoff IS DISTINCT FROM p.deadline OR q.scope_hash IS DISTINCT FROM p.approved_hash
  OR p.approval_hash IS DISTINCT FROM p.approved_hash
  OR a.approved_scope IS DISTINCT FROM p.approved_hash
  OR a.deadline IS DISTINCT FROM p.deadline
  OR p.max_missions<>96 OR p.token_allowance<>600000
  OR p.deadline<=clock_timestamp()+interval '5 minutes'
  OR p.phase<>'development' OR p.organization_version<>1
  OR m.project_kind<>'management' OR m.deadline IS DISTINCT FROM p.deadline
  OR m.project_evidence->>'providerContinuationWindow' IS DISTINCT FROM a.window_id::text
  OR m.project_evidence->>'providerContinuationDecision' IS DISTINCT FROM a.continuation_decision_id::text
  OR m.project_evidence->>'providerContinuationRelease' IS DISTINCT FROM a.continuation_release_sha
  OR (SELECT count(*) FROM agent_missions x WHERE x.project_id=p.id)<>80
  OR (SELECT count(*) FROM mission_assignments x WHERE x.mission_id=m.id)<>1
  OR (SELECT count(*) FROM project_organization_nodes x WHERE x.project_id=p.id AND x.status='active')<>13
  OR NOT EXISTS (SELECT 1 FROM project_organization_assignments oa
    JOIN project_organization_nodes n ON n.id=oa.node_id AND n.project_id=p.id
    WHERE oa.assignment_id=j.id AND n.id::text=m.project_evidence->>'organizationNodeId'
     AND n.agent_id=j.agent_id AND n.status='active' AND n.management_level='functional_director'
     AND n.area='independent_qa' AND NOT ('development'=ANY(n.tools)))
  OR NOT project_org_retest_exact_scope_grants(p.id)
  OR NOT project_org_retest_original_owner_lineage(p.id)
  OR NOT project_provider_continued(p.id)
  OR NOT project_provider_continued_assignment(j.id)
  OR project_provider_request_pending(p.id)
  OR EXISTS (SELECT 1 FROM project_work_packages w WHERE w.project_id=p.id)
  OR g.project_id IS NULL OR g.state<>'active' OR g.alias_name<>'katie-mu.vercel.app'
  OR g.release_sha IS DISTINCT FROM p_release OR g.generation<=0
  OR g.deployment_id !~ '^dpl_[A-Za-z0-9]+$'
 THEN RAISE EXCEPTION 'Original owner project, Mission80 lineage or release changed';END IF;
 IF saved.project_id IS NOT NULL THEN
  IF saved.owner_id IS DISTINCT FROM p_owner OR saved.mission_id IS DISTINCT FROM m.id
   OR saved.assignment_id IS DISTINCT FROM j.id
   OR saved.release_sha IS DISTINCT FROM p_release
   OR saved.release_generation IS DISTINCT FROM g.generation
   OR saved.deployment_id IS DISTINCT FROM g.deployment_id
   OR saved.scope_hash IS DISTINCT FROM p.approved_hash
   OR saved.cutoff IS DISTINCT FROM p.deadline
  THEN RAISE EXCEPTION 'Existing Mission80 recovery belongs to a different release';END IF;
  stage:=CASE WHEN j.status='completed' THEN 'completed'
   WHEN j.attempts>=1 THEN 'claimed'
   WHEN p.status='running' AND j.status='queued' AND j.attempts=0 THEN 'recovered'
   ELSE 'terminal' END;
  RETURN jsonb_build_object('projectId',p.id,'stage',stage,
    'releaseSha',saved.release_sha,'releaseGeneration',saved.release_generation,
    'deploymentId',saved.deployment_id,'missionId',m.id,'assignmentId',j.id,
    'authorizationId',saved.authorization_id,'authorizedAt',saved.authorized_at,
    'scopeHash',saved.scope_hash,'cutoff',saved.cutoff,
    'currentAttempts',j.attempts,'historicalMissions',80,
    'maxMissions',96,'tokenAllowance',600000,'nodeCount',13);
 END IF;
 IF p.status<>'blocked' OR p.active_mission_id IS DISTINCT FROM m.id
  OR p.lease IS NOT NULL OR p.lease_until IS NOT NULL
  OR p.detail IS DISTINCT FROM
   'No new completed artifact or external execution transition for 00:45:00 in development. Work is blocked; saved results and charges are retained.'
  OR ev.id IS NULL OR ev.created_at<=m.created_at
  OR p.progress_since IS NULL
  OR m.status<>'running' OR m.calls<>0
  OR j.status<>'queued' OR j.attempts<>0
  OR j.lease IS NOT NULL OR j.lease_until IS NOT NULL
  OR j.result IS NOT NULL OR j.available_at>clock_timestamp()
 THEN RAISE EXCEPTION 'Exact blocked and unclaimed Mission80 state required';END IF;
 state_hash:=encode(sha256(convert_to(concat_ws('|',p.id,p.status,p.updated_at,
   p.progress_since,m.id,m.status,m.calls,j.id,j.status,j.attempts,g.release_sha,
   g.generation,g.deployment_id,p.deadline,ev.id),'UTF8')),'hex');
 RETURN jsonb_build_object('projectId',p.id,'stage','recover_watchdog',
  'releaseSha',g.release_sha,'releaseGeneration',g.generation,
  'deploymentId',g.deployment_id,'missionId',m.id,'assignmentId',j.id,
  'authorizationId',NULL,'stateHash',state_hash,
  'scopeHash',p.approved_hash,'cutoff',p.deadline,
  'currentAttempts',0,'historicalMissions',80,
  'maxMissions',96,'tokenAllowance',600000,'nodeCount',13);
END
$m80offer$;
REVOKE ALL ON FUNCTION public.project_org_mission80_watchdog_offer(uuid,uuid,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_mission80_watchdog_offer(uuid,uuid,text) TO service_role;

CREATE FUNCTION public.project_org_mission80_watchdog_recover(
 p_owner uuid,p_project uuid,p_release text,p_mission uuid,p_assignment uuid,
 p_authorization uuid,p_cutoff timestamptz,p_state_hash text,
 p_generation bigint,p_deployment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $m80recover$
DECLARE p work_projects;m agent_missions;j mission_assignments;
 offer jsonb;stamp timestamptz;ev project_events;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 SELECT * INTO p FROM work_projects WHERE id=p_project FOR UPDATE;
 PERFORM 1 FROM project_retest_production_release_gate WHERE project_id=p_project FOR UPDATE;
 SELECT * INTO m FROM agent_missions WHERE id=p_mission AND project_id=p_project FOR UPDATE;
 SELECT * INTO j FROM mission_assignments WHERE id=p_assignment AND mission_id=p_mission FOR UPDATE;
 IF p_authorization IS NULL
  OR p_mission IS DISTINCT FROM 'ce8dcc30-e316-49e7-934d-6add6c14a697'::uuid
  OR p_assignment IS DISTINCT FROM '3d118a6c-d121-4d65-8c6e-ed5620660b82'::uuid
  OR p_cutoff<=clock_timestamp()+interval '5 minutes'
 THEN RAISE EXCEPTION 'Explicit Mission80 owner authorization required';END IF;
 offer:=project_org_mission80_watchdog_offer(p_owner,p_project,p_release);
 IF offer->>'stage' IS DISTINCT FROM 'recover_watchdog'
  OR offer->>'stateHash' IS DISTINCT FROM p_state_hash
  OR offer->>'releaseSha' IS DISTINCT FROM p_release
  OR (offer->>'releaseGeneration')::bigint IS DISTINCT FROM p_generation
  OR offer->>'deploymentId' IS DISTINCT FROM p_deployment
  OR (offer->>'cutoff')::timestamptz IS DISTINCT FROM p_cutoff
  OR offer->>'missionId' IS DISTINCT FROM p_mission::text
  OR offer->>'assignmentId' IS DISTINCT FROM p_assignment::text
 THEN RAISE EXCEPTION 'Mission80 recovery preflight changed or receipt consumed';END IF;
 SELECT * INTO ev FROM project_events e WHERE e.project_id=p_project
  AND e.event='block' AND e.created_at=p.updated_at
  ORDER BY e.created_at DESC LIMIT 1;
 stamp:=clock_timestamp();
 INSERT INTO project_mission80_watchdog_recovery_receipts
 (project_id,authorization_id,owner_id,mission_id,assignment_id,release_sha,
  release_generation,deployment_id,scope_hash,cutoff,blocked_event_id,authorized_at)
 VALUES(p.id,p_authorization,p_owner,m.id,j.id,p_release,
  p_generation,p_deployment,p.approved_hash,p_cutoff,ev.id,stamp);
 UPDATE work_projects SET status='running',progress_since=stamp,updated_at=stamp,
  detail='Authenticated owner restored original queued Mission80 under exact current release.',
  impediment=NULL
 WHERE id=p.id AND status='blocked' AND active_mission_id=m.id
  AND lease IS NULL AND lease_until IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Mission80 parent blocked state changed under lock';END IF;
 IF NOT project_org_retest_claim_release_authorized_epoch(p.id,p_release,p_generation,p_deployment)
 THEN RAISE EXCEPTION 'Recovered Mission80 cannot pass normal release-bound scheduler claim';END IF;
 INSERT INTO project_events(project_id,event,data)
 VALUES(p.id,'mission80_watchdog_owner_recovered',
   jsonb_build_object('authorizationId',p_authorization,'missionId',m.id,
    'assignmentId',j.id,'releaseSha',p_release,'generation',p_generation,
    'deploymentId',p_deployment,'cutoff',p_cutoff,'authorizedAt',stamp));
 RETURN jsonb_build_object('projectId',p.id,'stage','recovered','existing',false,
   'authorizationId',p_authorization,'authorizedAt',stamp,
   'releaseSha',p_release,'releaseGeneration',p_generation,
   'deploymentId',p_deployment,'missionId',m.id,'assignmentId',j.id,
   'scopeHash',p.approved_hash,'cutoff',p_cutoff,
   'currentAttempts',0,'historicalMissions',80,
   'maxMissions',96,'tokenAllowance',600000,'nodeCount',13);
END
$m80recover$;
REVOKE ALL ON FUNCTION public.project_org_mission80_watchdog_recover(uuid,uuid,text,uuid,uuid,uuid,timestamptz,text,bigint,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_mission80_watchdog_recover(uuid,uuid,text,uuid,uuid,uuid,timestamptz,text,bigint,text) TO service_role;

-- Preserve the first two exact Mission79 branches unchanged; widen only the
-- owner-project continuation into per-mission validated post79 management.
CREATE OR REPLACE FUNCTION public.project_org_retest_claim_release_authorized_epoch(p_project uuid, p_release text, p_generation bigint, p_deployment text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- This branch is the original owner's bounded downstream management
  -- continuation, not a reuse of the one-time Mission79 retry. Every new
  -- assignment must independently qualify under the live source, limits,
  -- org membership and release epoch. Initial attempts ONLY.
  OR EXISTS (
   SELECT 1 FROM public.work_projects p
   JOIN public.project_provider_execution a ON a.project_id=p.id
    AND a.approved_scope=p.approved_hash AND a.deadline=p.deadline
   JOIN public.project_retest_future_window_receipts q ON q.project_id=p.id
    AND q.owner_id=a.owner_id AND q.authorization_id=a.window_id
    AND q.cutoff=p.deadline AND q.scope_hash=p.approved_hash
   JOIN public.project_execution_windows ow ON ow.id=a.window_id
    AND ow.project_id=p.id AND ow.owner_id=a.owner_id
    AND ow.decision_id=a.continuation_decision_id AND ow.cutoff=p.deadline
   JOIN public.project_mission79_retry_receipts r79 ON r79.project_id=p.id
    AND r79.owner_id=a.owner_id AND r79.cutoff=p.deadline
    AND r79.scope_hash=p.approved_hash AND r79.prior_attempts=1 AND r79.prior_calls=1
   JOIN public.project_mission79_watchdog_recovery_receipts w79 ON w79.project_id=p.id
    AND w79.original_retry_authorization_id=r79.authorization_id
    AND w79.owner_id=a.owner_id AND w79.mission_id=r79.mission_id
    AND w79.assignment_id=r79.assignment_id AND w79.scope_hash=p.approved_hash
    AND w79.cutoff=p.deadline
   JOIN public.agent_missions m79 ON m79.id=r79.mission_id
    AND m79.project_id=p.id AND m79.status='completed' AND m79.calls=2
   JOIN public.mission_assignments j79 ON j79.id=r79.assignment_id
    AND j79.mission_id=m79.id AND j79.status='completed'
    AND j79.attempts=2 AND j79.lease IS NULL
   JOIN public.project_organization_decisions d79 ON d79.project_id=p.id
    AND d79.assignment_id=j79.id AND d79.id::text=j79.result->>'decisionId'
   JOIN public.agent_missions m ON m.id=p.active_mission_id
    AND m.project_id=p.id AND m.status='running' AND m.calls=0
    AND m.project_kind='management' AND m.deadline=p.deadline
   JOIN public.mission_assignments j ON j.mission_id=m.id
    AND j.status='queued' AND j.attempts=0 AND j.role='work'
    AND j.job_key='plan' AND j.lease IS NULL AND j.lease_until IS NULL
    AND j.available_at<=clock_timestamp()
   JOIN public.project_organization_nodes n ON n.id::text=m.project_evidence->>'organizationNodeId'
    AND n.project_id=p.id AND n.status='active'
    AND n.agent_id=j.agent_id AND n.kind<>'worker'
    AND n.deadline=p.deadline AND n.management_level IN
     ('project_director','functional_director','manager','supervisor')
   JOIN public.project_organization_assignments oa ON oa.node_id=n.id
    AND oa.assignment_id=j.id
   JOIN public.project_retest_production_release_gate g ON g.project_id=p.id
    AND g.state='active' AND g.alias_name='katie-mu.vercel.app'
    AND g.release_sha=p_release AND g.generation=p_generation
    AND g.deployment_id=p_deployment
   WHERE p.id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
    AND p.id=p_project AND p.status='running' AND p.phase='development'
    AND p.deadline>clock_timestamp() AND p.approval_hash=p.approved_hash
    AND p.max_missions=96 AND p.token_allowance=600000
    AND r79.mission_id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
    AND r79.assignment_id='85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
    AND m.id<>m79.id AND m.created_at>d79.created_at
    AND w79.authorized_at<d79.created_at
    AND (SELECT count(*) FROM public.agent_missions x WHERE x.project_id=p.id) BETWEEN 80 AND 96
    AND (SELECT count(*) FROM public.mission_assignments x WHERE x.mission_id=m.id)=1
    AND (SELECT count(*) FROM public.project_organization_nodes x
     WHERE x.project_id=p.id AND x.status='active')=13
    AND NOT EXISTS (SELECT 1 FROM public.agent_missions newer
     WHERE newer.project_id=p.id AND newer.created_at>m.created_at)
    AND EXISTS (
     SELECT 1 FROM public.agent_missions prev
     JOIN public.mission_assignments prev_job ON prev_job.mission_id=prev.id
      AND prev_job.status='completed'
     JOIN public.project_organization_decisions prev_decision ON prev_decision.project_id=p.id
      AND prev_decision.assignment_id=prev_job.id
      AND prev_decision.id::text=prev_job.result->>'decisionId'
     WHERE prev.project_id=p.id AND prev.status='completed'
      AND prev.created_at=(
       SELECT max(prior.created_at) FROM public.agent_missions prior
       WHERE prior.project_id=p.id AND prior.created_at<m.created_at)
    )
    AND m.project_evidence->>'providerContinuationWindow'=a.window_id::text
    AND m.project_evidence->>'providerContinuationDecision'=a.continuation_decision_id::text
    AND m.project_evidence->>'providerContinuationRelease'=a.continuation_release_sha
    AND public.project_org_retest_exact_scope_grants(p.id)
    AND public.project_org_retest_original_owner_lineage(p.id)
    AND public.project_provider_continued(p.id)
    AND public.project_provider_continued_assignment(j.id)
    AND NOT public.project_provider_request_pending(p.id)
    AND (SELECT coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0)
         FROM public.agent_missions spent WHERE spent.project_id=p.id)<=p.token_allowance
  )
 );
$function$;

COMMIT;

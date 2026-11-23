-- Original owner approval for the saved 84-mission tic-tac-toe project.
-- No automatic consent, historical replay, scope/resource increase, or scheduler unlock.
BEGIN;
CREATE TABLE public.project_original_execution_recovery_receipts (
 project_id uuid PRIMARY KEY REFERENCES public.work_projects(id),
 authorization_id uuid NOT NULL UNIQUE,
 owner_id uuid NOT NULL,
 original_window_id uuid NOT NULL REFERENCES public.project_execution_windows(id),
 release_sha text NOT NULL CHECK(release_sha ~ '^[a-f0-9]{40}$'),
 release_generation bigint NOT NULL CHECK(release_generation>0),
 deployment_id text NOT NULL CHECK(deployment_id ~ '^dpl_[A-Za-z0-9]+$'),
 scope_hash text NOT NULL,
 prior_cutoff timestamptz NOT NULL,
 cutoff timestamptz NOT NULL CHECK(cutoff>prior_cutoff),
 original_missions integer NOT NULL CHECK(original_missions=84),
 max_missions integer NOT NULL CHECK(max_missions=96),
 authorized_total_missions integer NOT NULL CHECK(authorized_total_missions BETWEEN 84 AND 96),
 approved_claims integer NOT NULL CHECK(approved_claims BETWEEN 1 AND 26),
 approved_retries integer NOT NULL CHECK(approved_retries IN(0,1)),
 token_allowance bigint NOT NULL CHECK(token_allowance=600000),
 node_count integer NOT NULL CHECK(node_count=13),
 original_m83 jsonb NOT NULL,
 original_m84 jsonb NOT NULL,
 state_hash text NOT NULL CHECK(state_hash ~ '^[a-f0-9]{64}$'),
 blocked_event_id uuid NOT NULL REFERENCES public.project_events(id),
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(cutoff>authorized_at AND cutoff<=authorized_at+interval '72 hours')
);
ALTER TABLE public.project_original_execution_recovery_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_original_execution_recovery_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER project_original_execution_recovery_immutable
 BEFORE UPDATE OR DELETE ON public.project_original_execution_recovery_receipts
 FOR EACH ROW EXECUTE FUNCTION public.project_org_change_immutable();

CREATE FUNCTION public.project_org_original_execution_recovery_offer(
 p_owner uuid,p_project uuid,p_release text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $original_offer$
DECLARE p work_projects;g project_retest_production_release_gate;
 a project_provider_execution;m83 agent_missions;j83 mission_assignments;
 m84 agent_missions;j84 mission_assignments;
 source_event project_events;old_window project_execution_windows;
 prior project_original_execution_recovery_receipts;state_hash text;
BEGIN
 SELECT * INTO p FROM public.work_projects WHERE id=p_project;
 SELECT * INTO g FROM public.project_retest_production_release_gate WHERE project_id=p_project;
 SELECT * INTO a FROM public.project_provider_execution WHERE project_id=p_project;
 SELECT * INTO m83 FROM public.agent_missions WHERE id='2289146a-5728-40e7-bc05-79c5c0bed12d'::uuid AND project_id=p_project;
 SELECT * INTO j83 FROM public.mission_assignments WHERE id='95118a8e-8db5-465c-a8d7-98e35631ba30'::uuid AND mission_id=m83.id;
 SELECT * INTO m84 FROM public.agent_missions WHERE id='18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid AND project_id=p_project;
 SELECT * INTO j84 FROM public.mission_assignments WHERE id='bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid AND mission_id=m84.id;
 SELECT * INTO old_window FROM public.project_execution_windows WHERE id=a.window_id AND project_id=p_project;
 SELECT * INTO prior FROM public.project_original_execution_recovery_receipts WHERE project_id=p_project;
 SELECT * INTO source_event FROM public.project_events e
  WHERE e.project_id=p_project AND e.event='block' AND e.created_at=p.updated_at
  AND e.data->>'detail'='No new completed artifact or external execution transition for 00:45:00 in development. Work is blocked; saved results and charges are retained.'
  AND e.data->'impediment'->>'minimumAction' LIKE '%18819669-d4cf-4010-a455-19f5bcbf93cb%'
  ORDER BY e.created_at DESC LIMIT 1;
 IF p_project IS DISTINCT FROM 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  OR p_owner IS NULL OR a.owner_id IS DISTINCT FROM p_owner
  OR p.id IS NULL OR g.project_id IS NULL
  OR NOT public.standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
  OR p.max_missions<>96 OR p.token_allowance<>600000
  OR p.approved_hash IS DISTINCT FROM '4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
  OR p.approval_hash IS DISTINCT FROM p.approved_hash
  OR g.alias_name<>'katie-mu.vercel.app' OR g.state<>'active'
  OR g.release_sha IS DISTINCT FROM p_release OR g.generation<=0
  OR g.deployment_id !~ '^dpl_[A-Za-z0-9]+$'
  OR a.approved_scope IS DISTINCT FROM p.approved_hash
  OR m83.id IS NULL OR j83.id IS NULL OR m84.id IS NULL OR j84.id IS NULL
  OR old_window.id IS NULL OR old_window.owner_id IS DISTINCT FROM p_owner
  OR old_window.decision_id IS DISTINCT FROM a.continuation_decision_id
 THEN RAISE EXCEPTION 'Original owner project, historical authority or canonical release changed';END IF;
 IF prior.project_id IS NOT NULL THEN
  IF prior.owner_id IS DISTINCT FROM p_owner OR prior.release_sha IS DISTINCT FROM p_release
   OR prior.release_generation IS DISTINCT FROM g.generation
   OR prior.deployment_id IS DISTINCT FROM g.deployment_id OR prior.original_missions<>84
  THEN RAISE EXCEPTION 'Existing recovery belongs to another owner or release';END IF;
  RETURN jsonb_build_object('projectId',p.id,
   'stage',CASE WHEN p.status='running' THEN 'recovered' ELSE 'terminal' END,
   'releaseSha',prior.release_sha,'releaseGeneration',prior.release_generation,
   'deploymentId',prior.deployment_id,'scopeHash',prior.scope_hash,
   'priorCutoff',prior.prior_cutoff,'cutoff',prior.cutoff,
   'authorizationId',prior.authorization_id,'authorizedAt',prior.authorized_at,
   'historicalMissions',84,'maxMissions',96,'tokenAllowance',600000,'nodeCount',13,
   'authorizedTotalMissions',prior.authorized_total_missions,
   'approvedClaims',prior.approved_claims,'approvedRetries',prior.approved_retries,
   'missionId',m84.id,'assignmentId',j84.id,'currentAttempts',j84.attempts);
 END IF;
 IF p.status<>'blocked' OR p.phase<>'development'
  OR p.deadline IS DISTINCT FROM '2026-11-22T14:00:00Z'::timestamptz
  OR a.deadline IS DISTINCT FROM p.deadline OR old_window.cutoff IS DISTINCT FROM p.deadline
  OR p.deadline>=clock_timestamp() OR p.organization_version<>1
  OR p.active_mission_id IS DISTINCT FROM m84.id
  OR p.lease IS NOT NULL OR p.lease_until IS NOT NULL
  OR p.detail IS DISTINCT FROM
   'No new completed artifact or external execution transition for 00:45:00 in development. Work is blocked; saved results and charges are retained.'
  OR source_event.id IS NULL OR source_event.created_at<=m84.created_at
  OR m84.project_kind<>'management' OR m84.status<>'blocked' OR m84.calls<>0
  OR m84.deadline IS DISTINCT FROM p.deadline
  OR m84.project_evidence->>'organizationNodeId' IS DISTINCT FROM 'c486ade1-2a9c-4cd5-a80b-90c032e4e03e'
  OR j84.status<>'queued' OR j84.attempts<>0 OR j84.lease IS NOT NULL OR j84.lease_until IS NOT NULL
  OR j84.result IS NOT NULL OR j84.role<>'work' OR j84.job_key<>'plan'
  OR j84.available_at>clock_timestamp()
  OR m83.status<>'blocked' OR m83.calls<>0 OR m83.deadline IS DISTINCT FROM p.deadline
  OR j83.status<>'failed' OR j83.attempts<>1 OR j83.lease IS NOT NULL OR j83.lease_until IS NOT NULL
  OR j83.result->>'detail' IS DISTINCT FROM 'Required management decision evidence exceeds bounded context; do not omit current contracts, unresolved exceptions, or necessary assignment results.'
  OR j83.result->'diagnostic' IS DISTINCT FROM '{"stage":"work","errorType":"Error","acceptedIssue":false}'::jsonb
  OR (SELECT count(*) FROM public.agent_missions m WHERE m.project_id=p.id)<>84
  OR (SELECT count(*) FROM public.project_organization_nodes n
      WHERE n.project_id=p.id AND n.status='active' AND n.deadline=p.deadline)<>13
  OR NOT EXISTS(SELECT 1 FROM public.project_organization_nodes root
     JOIN public.project_organization_assignments oa ON oa.node_id=root.id
     WHERE root.id='c486ade1-2a9c-4cd5-a80b-90c032e4e03e'::uuid
      AND root.project_id=p.id AND root.kind='project_director'
      AND root.parent_id IS NULL AND root.status='active' AND root.decision_needed
      AND root.agent_id=j84.agent_id AND oa.assignment_id=j84.id
      AND oa.contract_hash=encode(sha256(convert_to(public.project_canonical(root.acceptance),'UTF8')),'hex'))
  OR NOT EXISTS(SELECT 1 FROM public.project_organization_exceptions e
     WHERE e.project_id=p.id AND e.origin_id='4e6503c8-7723-49e7-ad30-22f633feb2f8'::uuid
      AND e.owner_id='c486ade1-2a9c-4cd5-a80b-90c032e4e03e'::uuid
      AND e.status='open' AND e.reason='objective'
      AND e.detail='Management session failed twice; saved decisions and charges retained.'
      AND e.created_at>m83.created_at AND e.created_at<m84.created_at)
  OR NOT EXISTS(SELECT 1 FROM public.agent_missions m82
     JOIN public.mission_assignments j82 ON j82.mission_id=m82.id
     JOIN public.project_organization_decisions d82 ON d82.assignment_id=j82.id
      AND d82.project_id=m82.project_id AND d82.id::text=j82.result->>'decisionId'
     WHERE m82.id='53f28eed-631a-4e7e-b868-7b36a34be616'::uuid
       AND m82.project_id=p.id AND m82.status='completed' AND m82.calls=1
       AND j82.id='0e358d94-6f36-4607-998f-e603646d33de'::uuid
       AND j82.status='completed' AND j82.attempts=1 AND d82.created_at<m83.created_at)
  OR NOT public.project_org_retest_exact_scope_grants(p.id)
  OR NOT public.project_org_retest_original_owner_lineage(p.id)
  OR NOT public.project_provider_continued(p.id)
  OR NOT public.project_provider_continued_assignment(j84.id)
  OR public.project_provider_request_pending(p.id)
  OR EXISTS(SELECT 1 FROM public.project_work_packages w WHERE w.project_id=p.id)
  OR EXISTS(SELECT 1 FROM public.mission_assignments j
      JOIN public.agent_missions m ON m.id=j.mission_id
      WHERE m.project_id=p.id AND j.status='running')
 THEN RAISE EXCEPTION 'Exact expired 84-mission blocked and unclaimed escalation required';END IF;
 state_hash:=encode(sha256(convert_to(concat_ws('|',p.id,p.status,p.updated_at,p.progress_since,
  p.active_mission_id,p.deadline,p.approved_hash,m83.id,m83.status,m83.calls,m83.updated_at,
  j83.id,j83.status,j83.attempts,j83.result::text,m84.id,m84.status,m84.calls,
  m84.updated_at,j84.id,j84.status,j84.attempts,g.release_sha,g.generation,
  g.deployment_id,source_event.id),'UTF8')),'hex');
 RETURN jsonb_build_object('projectId',p.id,'stage','authorize','missionId',m84.id,
  'assignmentId',j84.id,'releaseSha',g.release_sha,'releaseGeneration',g.generation,
  'deploymentId',g.deployment_id,'scopeHash',p.approved_hash,'stateHash',state_hash,
  'priorCutoff',p.deadline,'cutoff',NULL,'authorizationId',NULL,
  'historicalMissions',84,'maxMissions',96,'remainingMissions',12,
  'tokenAllowance',600000,'nodeCount',13,'currentAttempts',0,
  'maxWindowHours',72,'maxClaimsAllowed',26,'retryOptions',jsonb_build_array(0,1),
  'spendingTerms','No increase to existing owner-authorized per-call spending settings. New paid execution may incur provider-account charges.');
END
$original_offer$;
REVOKE ALL ON FUNCTION public.project_org_original_execution_recovery_offer(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_original_execution_recovery_offer(uuid,uuid,text) TO service_role;

-- The original 84th assignment and every later organically scheduled mission
-- must independently qualify. No failed command is treated as accepted.
CREATE FUNCTION public.project_org_original_recovery_claim_authorized(
 p_project uuid,p_release text,p_generation bigint,p_deployment text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $original_claim$
 SELECT EXISTS(
  SELECT 1 FROM public.project_original_execution_recovery_receipts r
  JOIN public.work_projects p ON p.id=r.project_id
  JOIN public.project_provider_execution a ON a.project_id=p.id
   AND a.owner_id=r.owner_id AND a.approved_scope=r.scope_hash
   AND a.deadline=r.cutoff AND a.window_id=r.original_window_id
  JOIN public.project_retest_production_release_gate g ON g.project_id=p.id
   AND g.alias_name='katie-mu.vercel.app' AND g.state='active'
   AND g.release_sha=p_release AND g.generation=p_generation
   AND g.deployment_id=p_deployment
   AND g.release_sha=r.release_sha AND g.generation=r.release_generation
   AND g.deployment_id=r.deployment_id
  JOIN public.agent_missions m ON m.id=p.active_mission_id
   AND m.project_id=p.id AND m.status='running' AND m.calls=0
   AND m.deadline=p.deadline
  JOIN public.mission_assignments j ON j.mission_id=m.id
   AND j.status='queued' AND j.lease IS NULL AND j.lease_until IS NULL
   AND j.available_at<=clock_timestamp() AND j.attempts<=r.approved_retries
  JOIN public.project_organization_nodes n ON n.id::text=m.project_evidence->>'organizationNodeId'
   AND n.project_id=p.id AND n.status='active' AND n.deadline=p.deadline
   AND n.agent_id=j.agent_id
  JOIN public.project_organization_assignments binding ON binding.node_id=n.id
   AND binding.assignment_id=j.id
   AND binding.contract_hash=encode(sha256(convert_to(public.project_canonical(n.acceptance),'UTF8')),'hex')
  WHERE p.id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
   AND p.id=p_project AND p.status='running' AND p.phase='development'
   AND p.deadline=r.cutoff AND r.cutoff>clock_timestamp()
   AND r.authorized_at<r.cutoff AND p.approved_hash=r.scope_hash
   AND p.approval_hash=r.scope_hash AND p.max_missions=r.max_missions
   AND p.max_missions=96 AND p.token_allowance=r.token_allowance
   AND p.token_allowance=600000 AND r.original_missions=84
   AND (SELECT count(*) FROM public.agent_missions all_m WHERE all_m.project_id=p.id)
     BETWEEN 84 AND r.authorized_total_missions
   AND (SELECT count(*) FROM public.project_organization_nodes all_n
     WHERE all_n.project_id=p.id AND all_n.status='active')=13
   AND (SELECT count(*) FROM public.mission_assignments jobs WHERE jobs.mission_id=m.id)=1
   AND NOT EXISTS(SELECT 1 FROM public.agent_missions newest
     WHERE newest.project_id=p.id AND newest.created_at>m.created_at)
   AND m.project_evidence->>'providerContinuationDecision'=a.continuation_decision_id::text
   AND m.project_evidence->>'providerContinuationRelease'=a.continuation_release_sha
   AND m.project_evidence->>'providerContinuationWindow'=a.window_id::text
   AND NOT public.project_provider_request_pending(p.id)
   AND public.project_provider_continued(p.id)
   AND public.project_provider_continued_assignment(j.id)
   AND (SELECT coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0)
      FROM public.agent_missions spent WHERE spent.project_id=p.id)<=p.token_allowance
   AND (SELECT coalesce(sum(booked.attempts),0) FROM public.mission_assignments booked
      JOIN public.agent_missions charged ON charged.id=booked.mission_id
      WHERE charged.project_id=p.id AND
       (charged.id='18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid
        OR charged.created_at>=r.authorized_at))<r.approved_claims
   AND (
    -- Original unused Project Director escalation is a FIRST claim, not
    -- a retry of the previously failed QA instruction.
    (m.id='18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid
     AND j.id='bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid
     AND n.kind='project_director' AND n.parent_id IS NULL
     AND j.role='work' AND j.job_key='plan'
     AND EXISTS(SELECT 1 FROM public.project_organization_exceptions e
       WHERE e.project_id=p.id AND e.owner_id=n.id
        AND e.origin_id='4e6503c8-7723-49e7-ad30-22f633feb2f8'::uuid
        AND e.reason='objective' AND e.status='open'
        AND e.created_at>='2026-11-21 20:37:39Z'::timestamptz
        AND e.created_at<m.created_at)
     AND (m.project_evidence->>'previousMissionId') IS NULL)
    OR
    (m.created_at>=r.authorized_at AND
     (
      -- Every successive leadership mission has its own scheduler-created
      -- immediate reporting binding and independently valid predecessor.
      (m.project_kind='management' AND n.kind<>'worker'
       AND j.role='work' AND j.job_key='plan'
       AND n.management_level IN('project_director','functional_director','manager','supervisor')
       AND EXISTS(SELECT 1 FROM public.agent_missions prev
        JOIN public.mission_assignments pj ON pj.mission_id=prev.id
        WHERE prev.project_id=p.id
         AND prev.created_at=(SELECT max(earlier.created_at)
           FROM public.agent_missions earlier WHERE earlier.project_id=p.id AND earlier.created_at<m.created_at)
         AND (
          (prev.status='completed' AND pj.status='completed'
           AND EXISTS(SELECT 1 FROM public.project_organization_decisions decision
            WHERE decision.project_id=p.id AND decision.assignment_id=pj.id
             AND decision.id::text=pj.result->>'decisionId'))
          OR (prev.status='blocked' AND pj.status='failed'
           AND (
            (n.id::text=prev.project_evidence->>'organizationNodeId'
             AND n.decision_needed
             AND (SELECT count(*) FROM public.agent_missions prior_fails
              WHERE prior_fails.project_id=p.id
               AND prior_fails.project_evidence->>'organizationNodeId'=n.id::text
               AND prior_fails.status='blocked' AND prior_fails.created_at<=prev.created_at)<=2)
            OR EXISTS(SELECT 1 FROM public.project_organization_nodes failed_n
             JOIN public.project_organization_exceptions e ON e.origin_id=failed_n.id
              AND e.owner_id=n.id AND e.project_id=p.id
              AND e.reason='objective' AND e.status='open'
              AND e.detail='Management session failed twice; saved decisions and charges retained.'
              AND e.created_at>prev.created_at AND e.created_at<m.created_at
             WHERE failed_n.project_id=p.id AND failed_n.id::text=prev.project_evidence->>'organizationNodeId'
              AND failed_n.parent_id=n.id AND n.decision_needed))
           )))
       ))
      OR (m.project_kind='organization_work' AND n.kind='worker'
       AND EXISTS(SELECT 1 FROM public.project_organization_work w
         WHERE w.project_id=p.id AND w.mission_id=m.id
          AND w.node_id=n.id AND w.status='running'))
      OR (m.project_kind='development' AND n.kind='worker'
       AND EXISTS(SELECT 1 FROM public.project_work_package_attempts att
         JOIN public.project_work_packages package ON package.id=att.package_id
          AND package.project_id=p.id
         JOIN public.project_worker_contracts contract ON contract.package_id=package.id
          AND contract.worker_id=n.id
         WHERE att.mission_id=m.id AND package.status IN('running','review','rejected')))
     ))
   )
 );
$original_claim$;
REVOKE ALL ON FUNCTION public.project_org_original_recovery_claim_authorized(uuid,text,bigint,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_original_recovery_claim_authorized(uuid,text,bigint,text)
 TO service_role;

-- Original consent once admitted keeps the legacy provider-window identity as
-- provenance; its mutable CURRENT cutoff advances only on a signed receipt.
CREATE OR REPLACE FUNCTION public.project_provider_continued(p_project uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 select exists(select 1 from project_provider_execution a
 join project_organization_decisions d on d.id=a.continuation_decision_id and d.project_id=a.project_id
 join project_organization_nodes n on n.id=d.node_id and n.project_id=a.project_id and n.kind='project_director' and n.parent_id is null
 join mission_assignments j on j.id=d.assignment_id and j.status='completed'
 join agent_missions m on m.id=j.mission_id and m.project_id=a.project_id and m.status='completed'
 left join project_director_recoveries r on r.project_id=a.project_id and r.owner_id=a.owner_id
 left join project_execution_windows w on w.id=a.window_id and w.project_id=a.project_id and w.owner_id=a.owner_id
  and w.decision_id=d.id and (w.release_sha=a.continuation_release_sha or (project_org_scoped_retry_release(w.id,a.continuation_release_sha) or (project_org_management_resume_release(w.id,a.continuation_release_sha) or project_org_blocked_owner_release(w.id,a.continuation_release_sha)))) and (w.cutoff=a.deadline OR EXISTS (
 SELECT 1 FROM public.project_original_execution_recovery_receipts renewed
 JOIN public.project_retest_production_release_gate active_gate ON active_gate.project_id=renewed.project_id
 WHERE renewed.project_id=a.project_id AND renewed.owner_id=a.owner_id
  AND renewed.original_window_id=a.window_id AND renewed.prior_cutoff=w.cutoff
  AND renewed.cutoff=a.deadline AND renewed.scope_hash=a.approved_scope
  AND active_gate.release_sha=renewed.release_sha
  AND active_gate.generation=renewed.release_generation
  AND active_gate.deployment_id=renewed.deployment_id
  AND active_gate.state='active'
  AND renewed.cutoff>clock_timestamp()
))
 where a.project_id=p_project and a.continued_at is not null and a.continuation_release_sha ~ '^[0-9a-f]{40}$'
 and ((r.project_id is not null and d.assignment_id=r.assignment_id) or w.id is not null)
 and (a.window_id is null or w.id is not null));
$function$;
-- Original single-mission historical branches are untouched. The final
-- alternative admits subsequent validated work under THIS owner-signed window.
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
    AND (
     EXISTS (
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
     OR (m.id='53f28eed-631a-4e7e-b868-7b36a34be616'::uuid
      AND j.id='0e358d94-6f36-4607-998f-e603646d33de'::uuid
      AND public.project_org_mission82_independent_escalation(p.id))
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
  OR public.project_org_original_recovery_claim_authorized(p_project,p_release,p_generation,p_deployment)
 );
$function$;
-- Honor the owner's selected total mission ceiling at issuance time, too;
-- all other projects preserve the existing p.max_missions guard.
CREATE OR REPLACE FUNCTION public.project_org_schedule_hierarchy(p_project uuid, p_lease uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p work_projects; n project_organization_nodes; mid uuid; j uuid; previous_mid uuid; w project_organization_work; begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project and lease=p_lease and p_lease is not null and lease_until>now() and status='running' and deadline>now();
 if p.id is null then raise exception 'Project lease required';end if;
 if p.organization_version=0 then return null;end if;
 if p.active_mission_id is not null then
 if exists(select 1 from agent_missions where id=p.active_mission_id and project_kind='management') then
 if exists(select 1 from agent_missions where id=p.active_mission_id and status in ('blocked','stopped')) then
 select * into n from project_organization_nodes where id=(select (project_evidence->>'organizationNodeId')::uuid from agent_missions where id=p.active_mission_id);
 if (select count(*) from agent_missions where project_id=p.id and project_kind='management' and project_evidence->>'organizationNodeId'=n.id::text and status in ('blocked','stopped') and (not project_provider_mode(p.id) or p.phase<>'development' or p.approved_hash is null or created_at>=coalesce((select max(s.approved_at) from project_scope_ratification_approvals s where s.project_id=p.id and s.scope_hash=p.approved_hash),'-infinity'::timestamptz)))>=2 then
 if n.parent_id is null then return jsonb_build_object('blocked','Project management cannot achieve its objective within bounded retry authority');end if;
 insert into project_organization_exceptions(project_id,origin_id,owner_id,reason,detail) values(p.id,n.id,n.parent_id,'objective','Management session failed twice; saved decisions and charges retained.');
 update project_organization_nodes set decision_needed=(id=n.parent_id) where id in(n.id,n.parent_id);
 else update project_organization_nodes set decision_needed=true where id=n.id;end if;
 update work_projects set active_mission_id=(select (project_evidence->>'previousMissionId')::uuid from agent_missions where id=p.active_mission_id) where id=p.id;
 end if;return jsonb_build_object('waiting',true);end if;
 if exists(select 1 from agent_missions where id=p.active_mission_id and project_kind='organization_work') then
 if exists(select 1 from agent_missions where id=p.active_mission_id and status in ('completed','blocked','stopped')) then
 update project_organization_work set status=case when (select status from agent_missions where id=p.active_mission_id)='completed' then 'completed' else 'blocked' end where mission_id=p.active_mission_id returning * into w;
 update project_organization_nodes set decision_needed=true where id=(select parent_id from project_organization_nodes where id=w.node_id);
 update work_projects set active_mission_id=(select (project_evidence->>'previousMissionId')::uuid from agent_missions where id=p.active_mission_id) where id=p.id;
 end if;return jsonb_build_object('waiting',true);end if;
 if not exists(select 1 from agent_missions where id=p.active_mission_id and status in ('completed','blocked')) and not project_smart_pending(p.active_mission_id) then return null;end if;
 previous_mid:=p.active_mission_id;
 end if;
 if p.phase='assessment' and previous_mid is not null and not exists(select 1 from project_organization_closures where project_id=p.id) then update project_organization_nodes set decision_needed=true where project_id=p.id and kind='project_director';end if;
 select * into n from project_organization_nodes where project_id=p.id and kind<>'worker' and status='active' and decision_needed and deadline>now() and project_org_dependencies_ready(id) order by case when kind='project_director' and not project_org_plan_ready(id) then 0 else 1 end,case when p.phase='development' and p.approved_hash is not null and not exists(select 1 from project_work_packages pkg where pkg.project_id=p.id and pkg.milestone_index=p.milestone_index) then depth else -depth end,created_at,id limit 1;
 if n.id is null then
 select * into w from project_organization_work where project_id=p.id and status='queued' and project_org_dependencies_ready(node_id) order by created_at,id limit 1;
 if w.id is null then
 if exists(select 1 from project_organization_nodes where project_id=p.id and kind<>'worker' and status='active' and decision_needed) or exists(select 1 from project_organization_work where project_id=p.id and status='queued') then return jsonb_build_object('waiting',true,'detail','Organizations are coordinating their accepted dependencies.');end if;
 return null;end if;
 select * into n from project_organization_nodes where id=w.node_id;
 end if;
 -- Planning uses the existing project authorization, never an implicit new allowance.
 if not project_provider_mode(p.id) and not exists(select 1 from project_organization_authority where project_id=p.id and objective_hash=encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')) then return jsonb_build_object('waiting',true,'detail','Project financial authority is required before management inference');end if;
 if not project_provider_mode(p.id) and n.token_limit<10000 then return jsonb_build_object('blocked','Delegated management capacity unavailable');end if;
 if (select count(*) from agent_missions where project_id=p.id)>=least(
 p.max_missions,coalesce((select r.authorized_total_missions
 from public.project_original_execution_recovery_receipts r
 where r.project_id=p.id and r.cutoff=p.deadline
 and r.cutoff>clock_timestamp()),p.max_missions)
) then return jsonb_build_object('blocked','Approved project mission limit reached');end if;
 if exists(select 1 from project_organization_dependencies d join project_organization_nodes x on x.id=d.depends_on where d.node_id in(n.id,n.parent_id) and x.status<>'accepted') then return jsonb_build_object('blocked','Delegated organization dependency is incomplete');end if;
 mid:=gen_random_uuid();
 if n.kind='worker' then
 perform create_mission(mid,w.instruction,array[n.agent_id],20,case when w.capability='repository_review' then p.repository_id else null end);
 update work_projects set active_mission_id=mid where id=p.id;
 update agent_missions set project_id=p.id,project_kind='organization_work',project_evidence=jsonb_build_object('organizationNodeId',n.id,'previousMissionId',previous_mid,'approvedScopeHash',p.approved_hash),token_allowance=case when project_provider_mode(p.id) then token_allowance else least(60000,n.token_limit)::int end,deadline=least(p.deadline,n.deadline),status='running' where id=mid;
 -- Fixed assignment: the manager already planned this work; no worker may appoint agents.
 update mission_assignments set role='work',payload=jsonb_build_object('capability',w.capability),instruction=w.instruction where mission_id=mid;
 update project_organization_work set mission_id=mid,status='running' where id=w.id;
 return jsonb_build_object('missionId',mid,'nodeId',n.id);
 end if;
 -- create_mission validates definitions/capacity; create its plan as an execution identity first,
 -- then bind the management-only assignment after the project lease owns this mission.
 perform create_mission(mid,n.objective,array[p.team[1]],20,null);
 update work_projects set active_mission_id=mid where id=p.id;
 update agent_missions set project_id=p.id,project_kind='management',project_evidence=jsonb_build_object('organizationNodeId',n.id,'previousMissionId',previous_mid),team=jsonb_build_array((select to_jsonb(a) from managed_agents a where a.id=n.agent_id)),token_allowance=case when project_provider_mode(p.id) then token_allowance else least(60000,n.token_limit)::int end,deadline=least(p.deadline,n.deadline),status='running' where id=mid;
 update mission_assignments set role='work',agent_id=n.agent_id,payload=jsonb_build_object('organizationNodeId',n.id),instruction='Make bounded management decisions. Delegate all technical execution.' where mission_id=mid returning id into j;
 insert into project_organization_assignments values(j,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex'),now());
 return jsonb_build_object('missionId',mid,'nodeId',n.id);
end $function$;

-- Sole mutation path: the first-party verified owner approves a NEW bounded
-- cutoff and exact lease ceilings. No old failure or provider receipt is reset.
CREATE FUNCTION public.project_org_original_execution_recover(
 p_owner uuid,p_project uuid,p_release text,p_generation bigint,p_deployment text,
 p_authorization uuid,p_state_hash text,p_new_cutoff timestamptz,
 p_new_missions integer,p_new_claims integer,p_retry_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $original_recover$
DECLARE offer jsonb;p work_projects;a project_provider_execution;
 m84 agent_missions;j84 mission_assignments;m83 agent_missions;j83 mission_assignments;
 node project_organization_nodes;event_row project_events;stamp timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 SELECT * INTO p FROM public.work_projects WHERE id=p_project FOR UPDATE;
 SELECT * INTO a FROM public.project_provider_execution WHERE project_id=p_project FOR UPDATE;
 PERFORM 1 FROM public.project_retest_production_release_gate WHERE project_id=p_project FOR UPDATE;
 SELECT * INTO m84 FROM public.agent_missions
  WHERE id='18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid AND project_id=p_project FOR UPDATE;
 SELECT * INTO j84 FROM public.mission_assignments
  WHERE id='bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid AND mission_id=m84.id FOR UPDATE;
 SELECT * INTO m83 FROM public.agent_missions
  WHERE id='2289146a-5728-40e7-bc05-79c5c0bed12d'::uuid AND project_id=p_project FOR UPDATE;
 SELECT * INTO j83 FROM public.mission_assignments
  WHERE id='95118a8e-8db5-465c-a8d7-98e35631ba30'::uuid AND mission_id=m83.id FOR UPDATE;
 IF p_authorization IS NULL OR p_state_hash IS NULL OR p_new_cutoff IS NULL
  OR NOT isfinite(p_new_cutoff)
  OR p_new_cutoff<=clock_timestamp()+interval '10 minutes'
  OR p_new_cutoff>clock_timestamp()+interval '72 hours'
  OR p_new_missions IS NULL OR p_new_missions NOT BETWEEN 0 AND 12
  OR p_new_claims IS NULL OR p_new_claims NOT BETWEEN 1 AND 26
  OR p_retry_limit IS NULL OR p_retry_limit NOT IN (0,1)
  OR p_new_claims>2*(1+p_new_missions)
  OR EXISTS(SELECT 1 FROM public.project_original_execution_recovery_receipts r WHERE r.project_id=p_project)
 THEN RAISE EXCEPTION 'Fresh explicit cutoff and bounded worker-claim terms require owner approval';END IF;
 offer:=public.project_org_original_execution_recovery_offer(p_owner,p_project,p_release);
 IF offer->>'stage' IS DISTINCT FROM 'authorize'
  OR offer->>'stateHash' IS DISTINCT FROM p_state_hash
  OR offer->>'releaseSha' IS DISTINCT FROM p_release
  OR (offer->>'releaseGeneration')::bigint IS DISTINCT FROM p_generation
  OR offer->>'deploymentId' IS DISTINCT FROM p_deployment
  OR (offer->>'priorCutoff')::timestamptz IS DISTINCT FROM p.deadline
  OR (offer->>'historicalMissions')::int<>84
  OR offer->>'missionId' IS DISTINCT FROM m84.id::text
  OR offer->>'assignmentId' IS DISTINCT FROM j84.id::text
 THEN RAISE EXCEPTION 'Owner, state, history or release identity changed under lock';END IF;
 PERFORM 1 FROM public.project_organization_nodes
  WHERE project_id=p.id ORDER BY depth,id FOR UPDATE;
 IF (SELECT count(*) FROM public.project_organization_nodes WHERE project_id=p.id AND deadline=p.deadline)<>13
 THEN RAISE EXCEPTION 'Organizational contract cutoff changed under owner lock';END IF;
 SELECT * INTO event_row FROM public.project_events e
  WHERE e.project_id=p.id AND e.event='block' AND e.created_at=p.updated_at
  ORDER BY e.created_at DESC LIMIT 1;
 IF event_row.id IS NULL THEN RAISE EXCEPTION 'Original watchdog evidence changed';END IF;
 stamp:=clock_timestamp();
 INSERT INTO public.project_original_execution_recovery_receipts
 (project_id,authorization_id,owner_id,original_window_id,release_sha,
  release_generation,deployment_id,scope_hash,prior_cutoff,cutoff,original_missions,
  max_missions,authorized_total_missions,approved_claims,approved_retries,
  token_allowance,node_count,original_m83,original_m84,state_hash,blocked_event_id,authorized_at)
 VALUES(p.id,p_authorization,p_owner,a.window_id,p_release,p_generation,
  p_deployment,p.approved_hash,p.deadline,p_new_cutoff,84,96,84+p_new_missions,
  p_new_claims,p_retry_limit,600000,13,
  jsonb_build_object('missionId',m83.id,'status',m83.status,'calls',m83.calls,
   'deadline',m83.deadline,'assignmentId',j83.id,'jobStatus',j83.status,
   'attempts',j83.attempts,'result',j83.result),
  jsonb_build_object('missionId',m84.id,'status',m84.status,'calls',m84.calls,
   'deadline',m84.deadline,'assignmentId',j84.id,'jobStatus',j84.status,
   'attempts',j84.attempts,'result',j84.result),
  p_state_hash,event_row.id,stamp);
 INSERT INTO public.project_execution_windows
  (id,project_id,owner_id,release_sha,decision_id,prior_cutoff,cutoff,prior_release_sha)
 VALUES(p_authorization,p.id,p_owner,p_release,a.continuation_decision_id,
  p.deadline,p_new_cutoff,a.continuation_release_sha);
 -- Keep the original provider source WINDOW ID; only the mutable current
 -- deadline advances, and only after this immutable owner receipt is written.
 UPDATE public.project_provider_execution SET deadline=p_new_cutoff
  WHERE project_id=p.id AND owner_id=p_owner AND deadline=p.deadline;
 IF NOT FOUND THEN RAISE EXCEPTION 'Owner provider continuation changed';END IF;
 UPDATE public.work_projects SET deadline=p_new_cutoff,status='running',
  progress_since=stamp,updated_at=stamp,impediment=NULL,
  detail='Owner-approved original execution recovery: same queued Mission84, no historical replay.'
 WHERE id=p.id AND status='blocked' AND active_mission_id=m84.id
  AND lease IS NULL AND lease_until IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original parent blocked state changed';END IF;
 FOR node IN SELECT * FROM public.project_organization_nodes
   WHERE project_id=p.id ORDER BY depth,id FOR UPDATE LOOP
  INSERT INTO public.project_organization_contract_changes
   (project_id,node_id,window_id,prior_deadline,deadline,prior_tools,tools,prior_submission)
  VALUES(p.id,node.id,p_authorization,node.deadline,p_new_cutoff,
   node.tools,node.tools,node.completion_submission);
  UPDATE public.project_organization_nodes SET deadline=p_new_cutoff WHERE id=node.id;
 END LOOP;
 UPDATE public.agent_missions SET deadline=p_new_cutoff,status='running',updated_at=stamp
  WHERE id=m84.id AND project_id=p.id AND status='blocked' AND calls=0
   AND deadline=p.deadline;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original unclaimed Mission84 state changed';END IF;
 IF NOT public.project_provider_continued(p.id)
  OR NOT public.project_provider_continued_assignment(j84.id)
  OR NOT public.project_org_original_recovery_claim_authorized(p.id,p_release,p_generation,p_deployment)
  OR (SELECT count(*) FROM public.project_organization_nodes n
      WHERE n.project_id=p.id AND n.status='active' AND n.deadline=p_new_cutoff)<>13
 THEN RAISE EXCEPTION 'Original owner recovery failed native claim or contract guards';END IF;
 INSERT INTO public.project_events(project_id,event,data)
 VALUES(p.id,'original_project_owner_recovered',jsonb_build_object(
  'authorizationId',p_authorization,'ownerId',p_owner,
  'missionId',m84.id,'assignmentId',j84.id,
  'priorCutoff',p.deadline,'newCutoff',p_new_cutoff,
  'originalMissions',84,'authorizedTotalMissions',84+p_new_missions,
  'approvedClaims',p_new_claims,'approvedRetries',p_retry_limit,
  'scopeHash',p.approved_hash,'releaseSha',p_release,
  'releaseGeneration',p_generation,'deploymentId',p_deployment,
  'restoredAt',stamp));
 RETURN jsonb_build_object('projectId',p.id,'stage','recovered',
  'authorizationId',p_authorization,'authorizedAt',stamp,
  'releaseSha',p_release,'releaseGeneration',p_generation,
  'deploymentId',p_deployment,'cutoff',p_new_cutoff,
  'priorCutoff',p.deadline,'scopeHash',p.approved_hash,
  'historicalMissions',84,'maxMissions',96,'authorizedTotalMissions',84+p_new_missions,
  'approvedClaims',p_new_claims,'approvedRetries',p_retry_limit,
  'tokenAllowance',600000,'nodeCount',13,
  'missionId',m84.id,'assignmentId',j84.id,'currentAttempts',0,'existing',false);
END
$original_recover$;
REVOKE ALL ON FUNCTION public.project_org_original_execution_recover(uuid,uuid,text,bigint,text,uuid,text,timestamptz,integer,integer,integer)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_original_execution_recover(uuid,uuid,text,bigint,text,uuid,text,timestamptz,integer,integer,integer)
 TO service_role;
COMMIT;

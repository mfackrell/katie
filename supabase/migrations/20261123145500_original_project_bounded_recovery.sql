-- P0 single owner-authorized recovery of ORIGINAL 84-mission project.
-- No automatic grant, mission replay, historical edits, spending increase,
-- SMART changes, watchdog threshold changes or manual provider dispatch.
BEGIN;
CREATE TABLE public.project_original_execution_recovery_receipts (
 project_id uuid PRIMARY KEY REFERENCES public.work_projects(id),
 authorization_id uuid NOT NULL UNIQUE,
 owner_id uuid NOT NULL,
 prior_window_id uuid NOT NULL,
 prior_cutoff timestamptz NOT NULL,
 cutoff timestamptz NOT NULL,
 release_sha text NOT NULL CHECK(release_sha~'^[a-f0-9]{40}$'),
 deployment_id text NOT NULL CHECK(deployment_id~'^dpl_[A-Za-z0-9]+$'),
 release_generation bigint NOT NULL CHECK(release_generation>0),
 approved_scope text NOT NULL,
 prior_block_event_id uuid NOT NULL REFERENCES public.project_events(id),
 original_mission_id uuid NOT NULL,
 original_assignment_id uuid NOT NULL,
 historical_missions integer NOT NULL CHECK(historical_missions=84),
 authorized_mission_ceiling integer NOT NULL CHECK(authorized_mission_ceiling BETWEEN 84 AND 96),
 total_token_ceiling bigint NOT NULL CHECK(total_token_ceiling=600000),
 initial_attempts_per_assignment integer NOT NULL CHECK(initial_attempts_per_assignment=1),
 prior_failure_retry_allowance integer NOT NULL CHECK(prior_failure_retry_allowance=0),
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.project_original_execution_recovery_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_original_execution_recovery_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER project_original_execution_recovery_immutable BEFORE UPDATE OR DELETE
 ON public.project_original_execution_recovery_receipts FOR EACH ROW EXECUTE FUNCTION public.project_org_change_immutable();

CREATE FUNCTION public.project_org_original_recovery_offer(
 p_owner uuid,p_project uuid,p_release text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $offer$
DECLARE
 p work_projects; a project_provider_execution; g project_retest_production_release_gate;
 m83 agent_missions;j83 mission_assignments;m84 agent_missions;j84 mission_assignments;
 e project_events;receipt project_original_execution_recovery_receipts;
 initial_window project_execution_windows;state_hash text;term text;
BEGIN
 SELECT * INTO p FROM work_projects WHERE id=p_project;
 SELECT * INTO a FROM project_provider_execution WHERE project_id=p_project;
 SELECT * INTO g FROM project_retest_production_release_gate WHERE project_id=p_project;
 SELECT * INTO receipt FROM project_original_execution_recovery_receipts WHERE project_id=p_project;
 SELECT * INTO initial_window FROM project_execution_windows WHERE id=a.window_id;
 SELECT * INTO m83 FROM agent_missions WHERE id='2289146a-5728-40e7-bc05-79c5c0bed12d'::uuid AND project_id=p_project;
 SELECT * INTO j83 FROM mission_assignments WHERE id='95118a8e-8db5-465c-a8d7-98e35631ba30'::uuid AND mission_id=m83.id;
 SELECT * INTO m84 FROM agent_missions WHERE id='18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid AND project_id=p_project;
 SELECT * INTO j84 FROM mission_assignments WHERE id='bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid AND mission_id=m84.id;
 SELECT * INTO e FROM project_events WHERE project_id=p_project AND event='block'
  AND created_at=p.updated_at ORDER BY created_at DESC LIMIT 1;
 IF p.id IS NULL OR p.id IS DISTINCT FROM 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  OR p_owner IS NULL OR a.owner_id IS DISTINCT FROM p_owner
  OR NOT standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
  OR g.state<>'active' OR g.release_sha IS DISTINCT FROM p_release
  OR g.alias_name<>'katie-mu.vercel.app' OR g.generation<1
  OR g.deployment_id !~ '^dpl_[A-Za-z0-9]+$'
  OR p.max_missions<>96 OR p.token_allowance<>600000
  OR p.approval_hash IS DISTINCT FROM p.approved_hash
  OR p.approved_hash IS DISTINCT FROM '4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
  OR NOT public.project_org_retest_original_owner_lineage(p.id)
  OR NOT public.project_org_retest_exact_scope_grants(p.id)
 THEN RAISE EXCEPTION 'Original owner scope or current verified release unavailable';END IF;
 IF receipt.project_id IS NOT NULL THEN
  IF receipt.owner_id IS DISTINCT FROM p_owner OR receipt.original_mission_id IS DISTINCT FROM m84.id
   OR receipt.original_assignment_id IS DISTINCT FROM j84.id
   OR receipt.approved_scope IS DISTINCT FROM p.approved_hash
  THEN RAISE EXCEPTION 'Original recovery receipt integrity failed';END IF;
  term:=CASE WHEN j84.attempts>=1 THEN 'claimed' WHEN p.status='running' THEN 'recovered'
    ELSE 'terminal' END;
  RETURN jsonb_build_object('projectId',p.id,'stage',term,
    'releaseSha',receipt.release_sha,'releaseGeneration',receipt.release_generation,
    'deploymentId',receipt.deployment_id,'missionId',receipt.original_mission_id,
    'assignmentId',receipt.original_assignment_id,'priorCutoff',receipt.prior_cutoff,
    'cutoff',receipt.cutoff,'priorWindowId',receipt.prior_window_id,
    'scopeHash',receipt.approved_scope,'historicalMissions',receipt.historical_missions,
    'maxMissions',96,'missionCeiling',receipt.authorized_mission_ceiling,
    'tokenAllowance',receipt.total_token_ceiling,'initialAttemptsPerAssignment',1,
    'priorFailureRetryAllowance',0,'authorizationId',receipt.authorization_id,
    'authorizedAt',receipt.authorized_at,'currentAttempts',j84.attempts,'nodeCount',13);
 END IF;
 IF p.status<>'blocked' OR p.phase<>'development' OR p.organization_version<>1
  OR p.deadline>clock_timestamp() OR a.deadline IS DISTINCT FROM p.deadline
  OR initial_window.id IS NULL OR initial_window.cutoff IS DISTINCT FROM p.deadline
  OR initial_window.owner_id IS DISTINCT FROM a.owner_id
  OR p.active_mission_id IS DISTINCT FROM m84.id
  OR p.lease IS NOT NULL OR p.lease_until IS NOT NULL
  OR e.id IS NULL OR e.data->'impediment'->>'minimumAction' NOT LIKE '%18819669-d4cf-4010-a455-19f5bcbf93cb%'
  OR m84.id IS NULL OR m84.status<>'blocked' OR m84.calls<>0
  OR m84.project_kind<>'management' OR m84.deadline IS DISTINCT FROM p.deadline
  OR j84.id IS NULL OR j84.status<>'queued' OR j84.attempts<>0
  OR j84.lease IS NOT NULL OR j84.lease_until IS NOT NULL OR j84.result IS NOT NULL
  OR m83.id IS NULL OR m83.status<>'blocked' OR m83.calls<>0
  OR j83.id IS NULL OR j83.status<>'failed' OR j83.attempts<>1
  OR j83.lease IS NOT NULL OR j83.lease_until IS NOT NULL
  OR j83.result->'diagnostic'->>'stage'<>'work'
  OR j83.result->>'detail' IS DISTINCT FROM
   'Required management decision evidence exceeds bounded context; do not omit current contracts, unresolved exceptions, or necessary assignment results.'
  OR (SELECT count(*) FROM agent_missions WHERE project_id=p.id)<>84
  OR (SELECT count(*) FROM project_organization_nodes WHERE project_id=p.id AND status='active' AND deadline=p.deadline)<>13
  OR (SELECT count(*) FROM project_work_packages WHERE project_id=p.id)<>0
  OR public.project_provider_request_pending(p.id)
  OR NOT EXISTS (SELECT 1 FROM project_organization_nodes n
    JOIN project_organization_assignments b ON b.node_id=n.id
     AND b.assignment_id=j84.id
     AND b.contract_hash=encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex')
    WHERE n.id::text=m84.project_evidence->>'organizationNodeId'
      AND n.project_id=p.id AND n.kind='project_director'
      AND n.parent_id IS NULL AND n.status='active' AND n.agent_id=j84.agent_id)
  OR NOT EXISTS (SELECT 1 FROM project_organization_exceptions ex
    JOIN project_organization_nodes qa ON qa.id=ex.origin_id
    WHERE ex.project_id=p.id AND ex.owner_id=(m84.project_evidence->>'organizationNodeId')::uuid
     AND qa.id::text=m83.project_evidence->>'organizationNodeId'
     AND qa.parent_id=ex.owner_id AND ex.status='open' AND ex.reason='objective'
     AND ex.created_at>m83.created_at AND ex.created_at<m84.created_at)
 THEN RAISE EXCEPTION 'Exact expired original Mission84 and failed Mission83 evidence required';END IF;
 state_hash:=encode(sha256(convert_to(project_canonical(jsonb_build_object(
  'projectId',p.id,'status',p.status,'updatedAt',p.updated_at,
  'deadline',p.deadline,'progressSince',p.progress_since,'activeMissionId',p.active_mission_id,
  'ownerId',a.owner_id,'oldWindowId',a.window_id,'scope',p.approved_hash,
  'releaseSha',g.release_sha,'generation',g.generation,'deploymentId',g.deployment_id,
  'watchdogEventId',e.id,'m83',to_jsonb(m83),'j83',to_jsonb(j83),
  'm84',to_jsonb(m84),'j84',to_jsonb(j84),'missions',84
 )),'UTF8')),'hex');
 RETURN jsonb_build_object('projectId',p.id,'stage','authorize',
  'releaseSha',g.release_sha,'releaseGeneration',g.generation,
  'deploymentId',g.deployment_id,'missionId',m84.id,'assignmentId',j84.id,
  'priorCutoff',p.deadline,'priorWindowId',a.window_id,
  'scopeHash',p.approved_hash,'historicalMissions',84,'maxMissions',96,
  'missionCeilingMax',96,'missionCeilingMin',84,'tokenAllowance',600000,
  'initialAttemptsPerAssignment',1,'priorFailureRetryAllowance',0,
  'nodeCount',13,'currentAttempts',0,'authorizationId',null,'stateHash',state_hash);
END
$offer$;
REVOKE ALL ON FUNCTION public.project_org_original_recovery_offer(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_original_recovery_offer(uuid,uuid,text) TO service_role;

CREATE FUNCTION public.project_org_original_window_authorize(
 p_owner uuid,p_project uuid,p_release text,p_generation bigint,p_deployment text,
 p_authorization uuid,p_cutoff timestamptz,p_mission_ceiling integer,p_token_ceiling bigint,
 p_initial_attempts integer,p_prior_retry_allowance integer,p_state_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $authorize$
DECLARE p work_projects;a project_provider_execution;
 m agent_missions;j mission_assignments;n project_organization_nodes;
 offer jsonb;previous_window uuid;previous_cutoff timestamptz;watchdog uuid;stamp timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 SELECT * INTO p FROM work_projects WHERE id=p_project FOR UPDATE;
 SELECT * INTO a FROM project_provider_execution WHERE project_id=p_project FOR UPDATE;
 PERFORM 1 FROM project_retest_production_release_gate WHERE project_id=p_project FOR UPDATE;
 SELECT * INTO m FROM agent_missions WHERE id='18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid AND project_id=p_project FOR UPDATE;
 SELECT * INTO j FROM mission_assignments WHERE id='bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid AND mission_id=m.id FOR UPDATE;
 offer:=public.project_org_original_recovery_offer(p_owner,p_project,p_release);
 IF offer->>'stage' IS DISTINCT FROM 'authorize'
  OR offer->>'stateHash' IS DISTINCT FROM p_state_hash
  OR offer->>'releaseSha' IS DISTINCT FROM p_release
  OR (offer->>'releaseGeneration')::bigint IS DISTINCT FROM p_generation
  OR offer->>'deploymentId' IS DISTINCT FROM p_deployment
  OR p_authorization IS NULL
  OR p_token_ceiling<>600000
  OR p_initial_attempts<>1 OR p_prior_retry_allowance<>0
  OR p_mission_ceiling NOT BETWEEN 84 AND 96
  OR p_cutoff IS NULL OR NOT isfinite(p_cutoff)
  OR p_cutoff<=clock_timestamp()+interval '30 minutes'
  OR p_cutoff>clock_timestamp()+interval '7 days'
  OR EXISTS (SELECT 1 FROM project_execution_windows WHERE id=p_authorization)
  OR EXISTS (SELECT 1 FROM project_original_execution_recovery_receipts WHERE project_id=p_project)
 THEN RAISE EXCEPTION 'Explicit unchanged-scope original project owner recovery terms required';END IF;
 previous_window:=a.window_id;previous_cutoff:=p.deadline;
 SELECT id INTO watchdog FROM project_events WHERE project_id=p_project AND event='block'
  AND created_at=p.updated_at ORDER BY created_at DESC LIMIT 1;
 IF watchdog IS NULL OR m.status<>'blocked' OR m.calls<>0
  OR j.status<>'queued' OR j.attempts<>0 OR j.lease IS NOT NULL OR j.lease_until IS NOT NULL
 THEN RAISE EXCEPTION 'Original blocked and unattempted Mission84 state changed';END IF;
 PERFORM 1 FROM project_organization_nodes WHERE project_id=p.id ORDER BY depth,id FOR UPDATE;
 IF (SELECT count(*) FROM project_organization_nodes WHERE project_id=p.id AND status='active' AND deadline=previous_cutoff)<>13
  OR project_provider_request_pending(p.id)
  OR (SELECT count(*) FROM agent_missions WHERE project_id=p.id)<>84
 THEN RAISE EXCEPTION 'Existing organization or resource authority changed';END IF;
 -- Keep the original owner decision and provider continuation release; the
 -- new execution window is bound separately to the CURRENT canonical release.
 INSERT INTO project_execution_windows(id,project_id,owner_id,release_sha,decision_id,
  prior_cutoff,cutoff,prior_release_sha)
 VALUES(p_authorization,p.id,p_owner,a.continuation_release_sha,
  a.continuation_decision_id,previous_cutoff,p_cutoff,a.continuation_release_sha);
 stamp:=clock_timestamp();
 INSERT INTO project_original_execution_recovery_receipts(project_id,authorization_id,
  owner_id,prior_window_id,prior_cutoff,cutoff,release_sha,deployment_id,
  release_generation,approved_scope,prior_block_event_id,original_mission_id,
  original_assignment_id,historical_missions,authorized_mission_ceiling,
  total_token_ceiling,initial_attempts_per_assignment,prior_failure_retry_allowance,authorized_at)
 VALUES(p.id,p_authorization,p_owner,previous_window,previous_cutoff,p_cutoff,
  p_release,p_deployment,p_generation,p.approved_hash,watchdog,m.id,j.id,84,
  p_mission_ceiling,p_token_ceiling,1,0,stamp);
 UPDATE project_provider_execution SET window_id=p_authorization,deadline=p_cutoff
  WHERE project_id=p.id AND owner_id=p_owner;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original provider owner binding changed';END IF;
 UPDATE work_projects SET deadline=p_cutoff,status='running',
  progress_since=stamp,updated_at=stamp,impediment=NULL,
  detail='Authenticated owner approved bounded continuation of original Mission84.'
  WHERE id=p.id AND status='blocked' AND active_mission_id=m.id
   AND lease IS NULL AND lease_until IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original blocked project changed under recovery locks';END IF;
 FOR n IN SELECT * FROM project_organization_nodes WHERE project_id=p.id ORDER BY depth,id FOR UPDATE LOOP
  INSERT INTO project_organization_contract_changes(project_id,node_id,window_id,
   prior_deadline,deadline,prior_tools,tools,prior_submission)
   VALUES(p.id,n.id,p_authorization,n.deadline,p_cutoff,n.tools,n.tools,n.completion_submission);
  UPDATE project_organization_nodes SET deadline=p_cutoff WHERE id=n.id AND deadline=previous_cutoff;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original node deadline drifted';END IF;
 END LOOP;
 -- The owner explicitly authorizes resumption of the ORIGINAL unclaimed
 -- mission; its assignment stays QUEUED/attempts=0 and all prior failures stay.
 UPDATE agent_missions SET deadline=p_cutoff,status='running',updated_at=stamp
  WHERE id=m.id AND project_id=p.id AND status='blocked' AND calls=0
   AND deadline=previous_cutoff;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original Mission84 state changed';END IF;
 IF NOT public.project_provider_continued(p.id)
  OR (SELECT count(*) FROM project_organization_nodes WHERE project_id=p.id AND deadline=p_cutoff)<>13
  OR NOT public.project_org_original_new_window_claim_allowed(p.id,p_release,p_generation,p_deployment)
 THEN RAISE EXCEPTION 'Owner claim diagnostics: continued %, member %, scope %, lineage %, qualified %, providerPending %, newerCount %, activeCount %, currentDeadline %, missionDeadline %, window %, expectedPrior %, projectStatus %, release %',
    public.project_provider_continued(p.id),
    public.project_provider_continued_assignment(j.id),
    public.project_org_retest_exact_scope_grants(p.id),
    public.project_org_retest_original_owner_lineage(p.id),
    public.project_org_original_new_window_claim_allowed(p.id,p_release,p_generation,p_deployment),
    public.project_provider_request_pending(p.id),
    (SELECT count(*) FROM agent_missions x WHERE x.project_id=p.id AND x.created_at>m.created_at),
    (SELECT count(*) FROM project_organization_nodes x WHERE x.project_id=p.id AND x.status='active' AND x.deadline=p_cutoff),
    p_cutoff,m.deadline,a.window_id,previous_window,p.status,p_release;END IF;
 INSERT INTO project_events(project_id,event,data) VALUES(p.id,'original_project_owner_window_recovered',
  jsonb_build_object('authorizationId',p_authorization,'ownerId',p_owner,
   'priorWindowId',previous_window,'priorCutoff',previous_cutoff,'cutoff',p_cutoff,
   'releaseSha',p_release,'generation',p_generation,'deploymentId',p_deployment,
   'missionCeiling',p_mission_ceiling,'tokenCeiling',p_token_ceiling,
   'initialAttemptsPerAssignment',1,'priorFailureRetryAllowance',0,
   'missionId',m.id,'assignmentId',j.id,'historicalMissions',84,'authorizedAt',stamp));
 RETURN jsonb_build_object('projectId',p.id,'stage','recovered','existing',false,
  'authorizationId',p_authorization,'authorizedAt',stamp,
  'releaseSha',p_release,'releaseGeneration',p_generation,'deploymentId',p_deployment,
  'scopeHash',p.approved_hash,'cutoff',p_cutoff,'priorCutoff',previous_cutoff,
  'historicalMissions',84,'maxMissions',96,'missionCeiling',p_mission_ceiling,
  'tokenAllowance',p_token_ceiling,'nodeCount',13,'initialAttemptsPerAssignment',1,
  'priorFailureRetryAllowance',0,'missionId',m.id,'assignmentId',j.id,
  'currentAttempts',j.attempts);
END
$authorize$;
REVOKE ALL ON FUNCTION public.project_org_original_window_authorize(uuid,uuid,text,bigint,text,uuid,timestamptz,integer,bigint,integer,integer,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_original_window_authorize(uuid,uuid,text,bigint,text,uuid,timestamptz,integer,bigint,integer,integer,text) TO service_role;

CREATE FUNCTION public.project_org_original_new_window_claim_allowed(
 p_project uuid,p_release text,p_generation bigint,p_deployment text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $current_recovery$
 SELECT EXISTS(
 SELECT 1 FROM public.project_original_execution_recovery_receipts r
 JOIN public.work_projects p ON p.id=r.project_id
 JOIN public.project_provider_execution a ON a.project_id=p.id
  AND a.owner_id=r.owner_id AND a.window_id=r.authorization_id
  AND a.approved_scope=r.approved_scope AND a.deadline=r.cutoff
 JOIN public.project_execution_windows w ON w.id=r.authorization_id
  AND w.project_id=p.id AND w.owner_id=r.owner_id
  AND w.decision_id=a.continuation_decision_id AND w.cutoff=r.cutoff
  AND w.prior_cutoff=r.prior_cutoff
  AND w.release_sha=a.continuation_release_sha
 JOIN public.project_retest_production_release_gate g ON g.project_id=p.id
  AND g.state='active' AND g.alias_name='katie-mu.vercel.app'
  AND g.release_sha=p_release AND g.generation=p_generation AND g.deployment_id=p_deployment
  AND g.release_sha=r.release_sha AND g.generation=r.release_generation
  AND g.deployment_id=r.deployment_id
 JOIN public.agent_missions m ON m.id=p.active_mission_id AND m.project_id=p.id
  AND m.status='running' AND m.calls=0
  AND m.deadline=p.deadline AND m.project_kind IN('management','organization_work')
 JOIN public.mission_assignments j ON j.mission_id=m.id
  AND j.status='queued' AND j.attempts=0
  AND j.lease IS NULL AND j.lease_until IS NULL
  AND j.available_at<=clock_timestamp()
 JOIN public.project_organization_nodes n ON n.id::text=m.project_evidence->>'organizationNodeId'
  AND n.project_id=p.id AND n.status='active' AND n.agent_id=j.agent_id
  AND n.deadline=p.deadline
 JOIN public.project_organization_assignments b ON b.node_id=n.id
  AND b.assignment_id=j.id
  AND b.contract_hash=encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex')
 JOIN public.agent_missions historical83 ON historical83.id='2289146a-5728-40e7-bc05-79c5c0bed12d'::uuid
  AND historical83.project_id=p.id AND historical83.status='blocked' AND historical83.calls=0
 JOIN public.mission_assignments job83 ON job83.id='95118a8e-8db5-465c-a8d7-98e35631ba30'::uuid
  AND job83.mission_id=historical83.id AND job83.status='failed'
  AND job83.attempts=1 AND job83.lease IS NULL
  AND job83.result->>'detail'=
   'Required management decision evidence exceeds bounded context; do not omit current contracts, unresolved exceptions, or necessary assignment results.'
 JOIN public.agent_missions original84 ON original84.id=r.original_mission_id
  AND original84.project_id=p.id AND original84.id='18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid
 JOIN public.mission_assignments job84 ON job84.id=r.original_assignment_id
  AND job84.mission_id=original84.id AND job84.id='bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid
 WHERE p.id=p_project AND p.id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  AND p.status='running' AND p.phase='development' AND p.organization_version=1
  AND p.deadline=r.cutoff AND p.deadline>clock_timestamp()
  AND p.approved_hash=r.approved_scope AND p.approval_hash=r.approved_scope
  AND r.approved_scope='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
  AND r.historical_missions=84 AND r.total_token_ceiling=600000
  AND r.initial_attempts_per_assignment=1 AND r.prior_failure_retry_allowance=0
  AND p.token_allowance=600000 AND p.max_missions=96
  AND (SELECT count(*) FROM public.agent_missions mm WHERE mm.project_id=p.id)
      BETWEEN 84 AND r.authorized_mission_ceiling
  AND (SELECT count(*) FROM public.project_organization_nodes nn
       WHERE nn.project_id=p.id AND nn.status='active')=13
  AND (SELECT count(*) FROM public.mission_assignments jj WHERE jj.mission_id=m.id)=1
  AND NOT EXISTS(SELECT 1 FROM public.agent_missions newer
      WHERE newer.project_id=p.id AND newer.created_at>m.created_at)
  AND NOT public.project_provider_request_pending(p.id)
  AND (SELECT coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0)
       FROM public.agent_missions spent WHERE spent.project_id=p.id)<=r.total_token_ceiling
  AND public.project_org_retest_original_owner_lineage(p.id)
  AND public.project_org_retest_exact_scope_grants(p.id)
  AND public.project_provider_continued(p.id)
  AND public.project_provider_continued_assignment(j.id)
  AND (
   (m.id=original84.id AND j.id=job84.id AND m.project_kind='management'
    AND n.kind='project_director' AND n.parent_id IS NULL
    AND m.project_evidence->>'providerContinuationWindow'=r.prior_window_id::text
    AND m.project_evidence->>'providerContinuationDecision'=a.continuation_decision_id::text
    AND m.project_evidence->>'providerContinuationRelease'=a.continuation_release_sha)
   OR
   (m.created_at>r.authorized_at
    AND m.project_evidence->>'providerContinuationWindow'=r.authorization_id::text
    AND m.project_evidence->>'providerContinuationDecision'=a.continuation_decision_id::text
    AND m.project_evidence->>'providerContinuationRelease'=a.continuation_release_sha
    AND (
     (m.project_kind='management' AND n.kind<>'worker' AND
      j.job_key='plan' AND j.role='work' AND
      EXISTS(
       SELECT 1 FROM public.agent_missions prev
       JOIN public.mission_assignments prev_job ON prev_job.mission_id=prev.id
       WHERE prev.project_id=p.id AND prev.created_at=(
         SELECT max(prior.created_at) FROM public.agent_missions prior
         WHERE prior.project_id=p.id AND prior.created_at<m.created_at)
       AND (
        (prev.status='completed' AND prev_job.status='completed'
         AND EXISTS (SELECT 1 FROM public.project_organization_decisions d
          WHERE d.project_id=p.id AND d.assignment_id=prev_job.id
           AND d.id::text=prev_job.result->>'decisionId'))
        OR
        (prev.status='blocked' AND prev_job.status='failed'
         AND prev_job.lease IS NULL AND prev.calls<=1
         AND (
          (prev.project_evidence->>'organizationNodeId'=n.id::text
           AND n.decision_needed
           AND (SELECT count(*) FROM public.agent_missions previous_failures
                WHERE previous_failures.project_id=p.id
                 AND previous_failures.status='blocked'
                 AND previous_failures.project_evidence->>'organizationNodeId'=n.id::text
                 AND previous_failures.created_at<=prev.created_at)<2)
          OR EXISTS(SELECT 1 FROM public.project_organization_exceptions exc
            JOIN public.project_organization_nodes failed_node
             ON failed_node.id::text=prev.project_evidence->>'organizationNodeId'
            WHERE exc.project_id=p.id AND exc.reason='objective'
             AND exc.origin_id=failed_node.id AND exc.owner_id=n.id
             AND failed_node.parent_id=n.id AND exc.status='open'
             AND exc.created_at>=prev.created_at AND exc.created_at<m.created_at)
         ))
       )
      ))
     OR (m.project_kind='organization_work' AND n.kind='worker'
       AND EXISTS(SELECT 1 FROM public.project_organization_work ow
        WHERE ow.project_id=p.id AND ow.node_id=n.id AND ow.mission_id=m.id
         AND ow.status='running' AND ow.instruction=j.instruction))
    )
   )
  )
 );
$current_recovery$;
REVOKE ALL ON FUNCTION public.project_org_original_new_window_claim_allowed(uuid,text,bigint,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_original_new_window_claim_allowed(uuid,text,bigint,text)
 TO service_role;

-- Preserve all previous one-time authorities. Add the current-window admission
-- as one independent alternative, without rewriting historical receipts.
CREATE OR REPLACE FUNCTION public.project_provider_continued_assignment(p_job uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 select exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
 join project_provider_execution a on a.project_id=m.project_id
 left join project_director_recoveries r on r.project_id=a.project_id
 where j.id=p_job and j.id is distinct from r.assignment_id and m.project_evidence->>'providerContinuationDecision'=a.continuation_decision_id::text
 and m.project_evidence->>'providerContinuationRelease'=a.continuation_release_sha
 and (case when m.id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
  and exists(select 1 from project_retest_future_window_receipts new_window where new_window.project_id=a.project_id)
  then j.id='85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
   and public.project_org_retest_renewed_assignment(m.id,j.id)
  else ((m.project_evidence->>'providerContinuationWindow') is not distinct from a.window_id::text
   or public.project_org_retest_renewed_assignment(m.id,j.id)) end)
  and public.project_provider_continued(a.project_id)
  or (
   j.id='bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid
   and m.id='18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid
   and exists (
    select 1 from project_original_execution_recovery_receipts r
    where r.project_id=m.project_id and r.project_id=a.project_id
     and r.original_mission_id=m.id and r.original_assignment_id=j.id
     and r.authorization_id=a.window_id and r.cutoff=a.deadline
     and r.approved_scope=a.approved_scope and r.owner_id=a.owner_id
     and m.project_evidence->>'providerContinuationWindow'=r.prior_window_id::text
     and m.project_evidence->>'providerContinuationDecision'=a.continuation_decision_id::text
     and m.project_evidence->>'providerContinuationRelease'=a.continuation_release_sha
     and public.project_provider_continued(a.project_id)
   )
  )
  );
$function$;

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
  OR public.project_org_original_new_window_claim_allowed(p_project,p_release,p_generation,p_deployment)
 );
$function$;
COMMIT;

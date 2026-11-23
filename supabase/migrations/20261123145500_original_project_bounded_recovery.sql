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
 THEN RAISE EXCEPTION 'Owner-approved continuation cannot be claimed under current release';END IF;
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

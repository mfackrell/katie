-- One owner-selected recovery window for the original 84-mission project.
-- All previous windows, failed results, provider receipts and limits are immutable.

BEGIN;
CREATE TABLE public.project_bounded_recovery_receipts (
 project_id uuid PRIMARY KEY REFERENCES public.work_projects(id),
 authorization_id uuid NOT NULL UNIQUE,
 owner_id uuid NOT NULL,
 window_id uuid NOT NULL UNIQUE,
 release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
 release_generation bigint NOT NULL CHECK (release_generation>0),
 deployment_id text NOT NULL CHECK (deployment_id ~ '^dpl_[A-Za-z0-9]+$'),
 scope_hash text NOT NULL,
 prior_window_id uuid NOT NULL,
 prior_cutoff timestamptz NOT NULL,
 cutoff timestamptz NOT NULL,
 historical_missions integer NOT NULL CHECK (historical_missions=84),
 max_missions integer NOT NULL CHECK (max_missions=96),
 token_allowance integer NOT NULL CHECK (token_allowance=600000),
 additional_paid_retries integer NOT NULL CHECK (additional_paid_retries=0),
 active_mission_id uuid NOT NULL,
 active_assignment_id uuid NOT NULL,
 historical_m83_hash text NOT NULL,
 blocked_event_id uuid NOT NULL REFERENCES public.project_events(id),
 state_hash text NOT NULL,
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.project_bounded_recovery_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_bounded_recovery_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER project_bounded_recovery_receipt_immutable
 BEFORE UPDATE OR DELETE ON public.project_bounded_recovery_receipts
 FOR EACH ROW EXECUTE FUNCTION public.project_org_change_immutable();

-- Distinguish a renewed authority from all seven prior expired or
-- already-consumed windows; never reuse their receipts for a claim.
CREATE FUNCTION public.project_org_bounded_recovery_window_valid(p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $valid$
 SELECT EXISTS (
  SELECT 1 FROM public.project_bounded_recovery_receipts r
  JOIN public.work_projects p ON p.id=r.project_id
  JOIN public.project_provider_execution a ON a.project_id=p.id
   AND a.owner_id=r.owner_id AND a.approved_scope=r.scope_hash
   AND a.deadline=r.cutoff AND a.window_id=r.window_id
  JOIN public.project_execution_windows w ON w.id=r.window_id
   AND w.project_id=p.id AND w.owner_id=r.owner_id
   AND w.decision_id=a.continuation_decision_id
   AND w.prior_cutoff=r.prior_cutoff AND w.cutoff=r.cutoff
   AND w.release_sha=a.continuation_release_sha
  JOIN public.project_retest_production_release_gate g ON g.project_id=p.id
   AND g.state='active' AND g.alias_name='katie-mu.vercel.app'
   AND g.release_sha=r.release_sha AND g.generation=r.release_generation
   AND g.deployment_id=r.deployment_id
  JOIN public.agent_missions m83 ON m83.id='2289146a-5728-40e7-bc05-79c5c0bed12d'::uuid AND m83.project_id=p.id
  JOIN public.mission_assignments j83 ON j83.id='95118a8e-8db5-465c-a8d7-98e35631ba30'::uuid
   AND j83.mission_id=m83.id
  JOIN public.agent_missions m84 ON m84.id=r.active_mission_id AND m84.project_id=p.id
  JOIN public.mission_assignments j84 ON j84.id=r.active_assignment_id AND j84.mission_id=m84.id
  WHERE p.id=p_project AND p.id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
   AND r.owner_id='04ed6c05-a586-4a56-ba81-1b50e378746b'::uuid
   AND r.active_mission_id='18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid
   AND r.active_assignment_id='bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid
   AND r.authorization_id=r.window_id
   AND r.prior_cutoff='2026-11-22T14:00:00Z'::timestamptz
   AND r.cutoff>clock_timestamp() AND p.deadline=r.cutoff
   AND p.approved_hash=r.scope_hash AND p.approval_hash=r.scope_hash
   AND p.phase='development' AND p.organization_version=1
   AND p.max_missions=r.max_missions AND p.token_allowance=r.token_allowance
   AND r.additional_paid_retries=0 AND r.historical_missions=84
   AND (SELECT count(*) FROM public.project_organization_nodes n
     WHERE n.project_id=p.id AND n.status='active' AND n.deadline=r.cutoff)=13
   AND (SELECT count(*) FROM public.project_organization_contract_changes c
     WHERE c.project_id=p.id AND c.window_id=r.window_id
      AND c.prior_deadline=r.prior_cutoff AND c.deadline=r.cutoff
      AND c.prior_tools=c.tools)=13
   AND m83.status='blocked' AND m83.calls=0
   AND j83.status='failed' AND j83.attempts=1 AND j83.lease IS NULL
   AND j83.result->>'detail'='Required management decision evidence exceeds bounded context; do not omit current contracts, unresolved exceptions, or necessary assignment results.'
   AND encode(sha256(convert_to(public.project_canonical(jsonb_build_object(
    'mission',to_jsonb(m83),'assignment',to_jsonb(j83))),'UTF8')),'hex')=r.historical_m83_hash
   AND m84.project_kind='management'
   AND m84.project_evidence->>'organizationNodeId'='c486ade1-2a9c-4cd5-a80b-90c032e4e03e'
   AND j84.agent_id='c10c9dc2-d69a-46fe-9129-866fa7f5faa6'::uuid
   AND j84.payload->>'organizationNodeId'='c486ade1-2a9c-4cd5-a80b-90c032e4e03e'
   AND r.scope_hash='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
   AND public.project_org_retest_exact_scope_grants(p.id)
   AND public.project_org_retest_original_owner_lineage(p.id)
   AND (SELECT count(*) FROM public.agent_missions mm WHERE mm.project_id=p.id)<=96
   AND NOT public.project_provider_request_pending(p.id)
   AND (SELECT coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0)
    FROM public.agent_missions spent WHERE spent.project_id=p.id)<=600000
 );
$valid$;
REVOKE ALL ON FUNCTION public.project_org_bounded_recovery_window_valid(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_bounded_recovery_window_valid(uuid) TO service_role;

CREATE FUNCTION public.project_org_bounded_recovery_claim_authorized(
 p_project uuid,p_release text,p_generation bigint,p_deployment text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $claim$
 SELECT EXISTS(
  SELECT 1 FROM public.project_bounded_recovery_receipts r
  JOIN public.work_projects p ON p.id=r.project_id
  JOIN public.agent_missions m ON m.id=p.active_mission_id
   AND m.project_id=p.id AND m.status='running'
   AND m.calls=0 AND m.deadline=p.deadline
   AND m.project_kind IN ('management','organization_work')
  JOIN public.mission_assignments j ON j.mission_id=m.id
   AND j.status='queued' AND j.attempts=0
   AND j.lease IS NULL AND j.lease_until IS NULL
   AND j.available_at<=clock_timestamp()
  JOIN public.project_organization_nodes n ON n.id::text=m.project_evidence->>'organizationNodeId'
   AND n.project_id=p.id AND n.agent_id=j.agent_id
   AND n.status='active' AND n.deadline=p.deadline
  JOIN public.project_retest_production_release_gate g ON g.project_id=p.id
   AND g.state='active' AND g.alias_name='katie-mu.vercel.app'
   AND g.release_sha=p_release AND g.generation=p_generation
   AND g.deployment_id=p_deployment
  WHERE p.id=p_project AND p.id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
   AND p.status='running' AND p.phase='development'
   AND r.release_sha=p_release AND r.release_generation=p_generation
   AND r.deployment_id=p_deployment
   AND p.deadline>clock_timestamp()+interval '5 minutes'
   AND public.project_org_bounded_recovery_window_valid(p.id)
   AND public.project_provider_continued(p.id)
   AND public.project_provider_continued_assignment(j.id)
   AND (SELECT count(*) FROM public.mission_assignments assigned WHERE assigned.mission_id=m.id)=1
   AND (SELECT count(*) FROM public.agent_missions mm WHERE mm.project_id=p.id)<=96
   AND NOT EXISTS(SELECT 1 FROM public.agent_missions later
    WHERE later.project_id=p.id AND later.created_at>m.created_at)
   AND ((m.project_kind='management'
    AND n.kind<>'worker' AND n.management_level IN ('project_director','functional_director','manager','supervisor')
    AND j.role='work' AND j.job_key='plan'
    AND EXISTS(SELECT 1 FROM public.project_organization_assignments b WHERE b.assignment_id=j.id
      AND b.node_id=n.id AND b.contract_hash=encode(sha256(convert_to(public.project_canonical(n.acceptance),'UTF8')),'hex'))
    AND (
     (m.id=r.active_mission_id AND j.id=r.active_assignment_id
      AND j.attempts=0 AND m.created_at<r.authorized_at)
     OR (m.created_at>=r.authorized_at
      AND (
       EXISTS(SELECT 1 FROM public.agent_missions prev
        JOIN public.mission_assignments prev_job ON prev_job.mission_id=prev.id
         AND prev_job.status='completed'
        JOIN public.project_organization_decisions d ON d.assignment_id=prev_job.id
         AND d.project_id=p.id AND d.id::text=prev_job.result->>'decisionId'
        WHERE prev.project_id=p.id AND prev.status='completed'
         AND prev.created_at=(SELECT max(earlier.created_at) FROM public.agent_missions earlier
            WHERE earlier.project_id=p.id AND earlier.created_at<m.created_at))
       OR EXISTS(SELECT 1 FROM public.agent_missions prev
        JOIN public.mission_assignments prev_job ON prev_job.mission_id=prev.id
         AND prev_job.status='failed' AND prev_job.attempts>0
        JOIN public.project_organization_nodes prior ON prior.id::text=prev.project_evidence->>'organizationNodeId'
         AND prior.project_id=p.id
        WHERE prev.project_id=p.id AND prev.status='blocked'
         AND prev.created_at=(SELECT max(earlier.created_at) FROM public.agent_missions earlier
            WHERE earlier.project_id=p.id AND earlier.created_at<m.created_at)
         AND (
          (n.id=prior.id AND n.decision_needed AND
           (SELECT count(*) FROM public.agent_missions f WHERE f.project_id=p.id
            AND f.project_kind='management' AND f.status IN ('blocked','stopped')
            AND f.project_evidence->>'organizationNodeId'=prior.id::text
            AND f.created_at>=r.authorized_at)<=2)
          OR (n.id=prior.parent_id AND n.decision_needed
           AND EXISTS(SELECT 1 FROM public.project_organization_exceptions e
             WHERE e.project_id=p.id AND e.origin_id=prior.id AND e.owner_id=n.id
              AND e.reason='objective' AND e.status='open'
              AND e.detail='Management session failed twice; saved decisions and charges retained.'
              AND e.created_at>=prev.created_at AND e.created_at<=m.created_at))
         ))
      ))
    ))
    OR (m.project_kind='organization_work'
     AND n.kind='worker' AND j.role='work'
     AND EXISTS(SELECT 1 FROM public.project_organization_work w
      WHERE w.project_id=p.id AND w.mission_id=m.id AND w.node_id=n.id AND w.status='running')
     AND m.project_evidence->>'approvedScopeHash'=p.approved_hash))
 );
$claim$;
REVOKE ALL ON FUNCTION public.project_org_bounded_recovery_claim_authorized(uuid,text,bigint,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_bounded_recovery_claim_authorized(uuid,text,bigint,text) TO service_role;

-- Read-only owner offer exposes current exact historic identity/expiry and
-- remaining, NOT guessed new deadline, spending or additional retry authority.
CREATE FUNCTION public.project_org_bounded_recovery_offer(p_owner uuid,p_project uuid,p_release text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $offer$
DECLARE p work_projects;a project_provider_execution;g project_retest_production_release_gate;
 m83 agent_missions;j83 mission_assignments;m84 agent_missions;j84 mission_assignments;
 receipt project_bounded_recovery_receipts;ev project_events;prior project_execution_windows;
 state_hash text;historical_hash text;used bigint;
BEGIN
 SELECT * INTO p FROM public.work_projects WHERE id=p_project;
 SELECT * INTO a FROM public.project_provider_execution WHERE project_id=p_project;
 SELECT * INTO g FROM public.project_retest_production_release_gate WHERE project_id=p_project;
 SELECT * INTO m83 FROM public.agent_missions WHERE id='2289146a-5728-40e7-bc05-79c5c0bed12d'::uuid AND project_id=p_project;
 SELECT * INTO j83 FROM public.mission_assignments WHERE id='95118a8e-8db5-465c-a8d7-98e35631ba30'::uuid AND mission_id=m83.id;
 SELECT * INTO m84 FROM public.agent_missions WHERE id='18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid AND project_id=p_project;
 SELECT * INTO j84 FROM public.mission_assignments WHERE id='bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid AND mission_id=m84.id;
 SELECT * INTO prior FROM public.project_execution_windows WHERE id=a.window_id;
 SELECT * INTO receipt FROM public.project_bounded_recovery_receipts WHERE project_id=p_project;
 SELECT * INTO ev FROM public.project_events e WHERE e.project_id=p_project AND e.event='block'
  AND e.created_at=p.updated_at AND e.data->'impediment'->>'minimumAction'
   LIKE '%18819669-d4cf-4010-a455-19f5bcbf93cb%'
  ORDER BY e.created_at DESC LIMIT 1;
 IF p.id IS NULL OR p_project IS DISTINCT FROM 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  OR p_owner IS NULL OR p_owner IS DISTINCT FROM a.owner_id
  OR NOT public.standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
  OR p.approved_hash IS DISTINCT FROM '4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
  OR p.approval_hash IS DISTINCT FROM p.approved_hash
  OR NOT public.project_org_retest_original_owner_lineage(p.id)
  OR NOT public.project_org_retest_exact_scope_grants(p.id)
  OR p.organization_version<>1 OR p.phase<>'development'
  OR p.max_missions<>96 OR p.token_allowance<>600000
  OR g.project_id IS NULL OR g.state<>'active' OR g.release_sha IS DISTINCT FROM p_release
  OR g.generation<=0 OR g.alias_name<>'katie-mu.vercel.app'
  OR g.deployment_id !~ '^dpl_[A-Za-z0-9]+$'
  OR (SELECT count(*) FROM public.project_organization_nodes n WHERE n.project_id=p.id AND n.status='active')<>13
  OR m83.id IS NULL OR j83.id IS NULL OR m84.id IS NULL OR j84.id IS NULL
  OR m83.status<>'blocked' OR m83.calls<>0 OR m83.project_kind<>'management'
  OR j83.status<>'failed' OR j83.attempts<>1 OR j83.lease IS NOT NULL
  OR j83.result->>'detail' IS DISTINCT FROM
   'Required management decision evidence exceeds bounded context; do not omit current contracts, unresolved exceptions, or necessary assignment results.'
  OR j83.result->'diagnostic'->>'stage'<>'work'
  OR m84.project_kind<>'management'
  OR j84.id IS NULL OR j84.role<>'work' OR j84.job_key<>'plan'
  OR j84.payload->>'organizationNodeId'<>'c486ade1-2a9c-4cd5-a80b-90c032e4e03e'
  OR j84.agent_id IS DISTINCT FROM 'c10c9dc2-d69a-46fe-9129-866fa7f5faa6'::uuid
  OR NOT EXISTS(SELECT 1 FROM public.project_organization_assignments b
     WHERE b.assignment_id=j84.id AND b.node_id='c486ade1-2a9c-4cd5-a80b-90c032e4e03e'::uuid)
 THEN RAISE EXCEPTION 'Original owner, scope, preserved failures, or live release changed';END IF;
 IF receipt.project_id IS NOT NULL THEN
  IF receipt.owner_id IS DISTINCT FROM p_owner OR receipt.release_sha IS DISTINCT FROM p_release
   OR receipt.release_generation IS DISTINCT FROM g.generation
   OR receipt.deployment_id IS DISTINCT FROM g.deployment_id
  THEN RAISE EXCEPTION 'Recovery receipt belongs to another release';END IF;
  RETURN jsonb_build_object('projectId',p.id,'stage','authorized',
   'releaseSha',p_release,'releaseGeneration',g.generation,'deploymentId',g.deployment_id,
   'scopeHash',receipt.scope_hash,'priorCutoff',receipt.prior_cutoff,
   'cutoff',receipt.cutoff,'authorizationId',receipt.authorization_id,
   'authorizedAt',receipt.authorized_at,'historicalMissions',84,
   'maxMissions',96,'tokenAllowance',600000,'additionalPaidRetries',0,
   'activeMissionId',receipt.active_mission_id,
   'assignmentId',receipt.active_assignment_id,'nodeCount',13);
 END IF;
 SELECT coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0)
  INTO used FROM public.agent_missions WHERE project_id=p.id;
 IF p.status<>'blocked' OR p.deadline<>'2026-11-22T14:00:00Z'::timestamptz
  OR p.updated_at IS NULL OR p.progress_since IS NULL
  OR p.active_mission_id IS DISTINCT FROM m84.id
  OR p.lease IS NOT NULL OR p.lease_until IS NOT NULL
  OR p.detail IS DISTINCT FROM
   'No new completed artifact or external execution transition for 00:45:00 in development. Work is blocked; saved results and charges are retained.'
  OR ev.id IS NULL
  OR a.window_id IS DISTINCT FROM '2b04302e-8815-4c61-89aa-e35b9baffa82'::uuid
  OR a.deadline IS DISTINCT FROM p.deadline
  OR a.approved_scope IS DISTINCT FROM p.approved_hash
  OR prior.id IS NULL OR prior.owner_id IS DISTINCT FROM p_owner
  OR prior.cutoff IS DISTINCT FROM p.deadline
  OR prior.release_sha IS DISTINCT FROM a.continuation_release_sha
  OR m84.status<>'blocked' OR m84.calls<>0
  OR m84.deadline IS DISTINCT FROM p.deadline
  OR j84.status<>'queued' OR j84.attempts<>0
  OR j84.lease IS NOT NULL OR j84.lease_until IS NOT NULL
  OR j84.result IS NOT NULL OR j84.available_at>clock_timestamp()
  OR m84.created_at<=m83.created_at OR used>600000
  OR (SELECT count(*) FROM public.agent_missions m WHERE m.project_id=p.id)<>84
  OR (SELECT count(*) FROM public.mission_assignments j WHERE j.mission_id=m84.id)<>1
  OR (SELECT count(*) FROM public.project_organization_nodes n
    WHERE n.project_id=p.id AND n.status='active' AND n.deadline=p.deadline)<>13
  OR NOT public.project_provider_continued(p.id)
  OR public.project_provider_request_pending(p.id)
  OR EXISTS(SELECT 1 FROM public.project_work_packages w WHERE w.project_id=p.id)
 THEN RAISE EXCEPTION 'Original expired 84-mission blocked state required';END IF;
 historical_hash:=encode(sha256(convert_to(public.project_canonical(jsonb_build_object(
  'mission',to_jsonb(m83),'assignment',to_jsonb(j83))),'UTF8')),'hex');
 state_hash:=encode(sha256(convert_to(concat_ws('|',p.id,p.status,p.updated_at,p.progress_since,
  p.deadline,p.active_mission_id,m84.id,m84.status,m84.calls,m84.deadline,
  j84.id,j84.status,j84.attempts,j84.available_at,m83.id,m83.status,j83.id,j83.status,
  historical_hash,a.window_id,g.release_sha,g.generation,g.deployment_id,ev.id),'UTF8')),'hex');
 RETURN jsonb_build_object('projectId',p.id,'stage','authorize',
  'releaseSha',p_release,'releaseGeneration',g.generation,'deploymentId',g.deployment_id,
  'scopeHash',p.approved_hash,'priorCutoff',p.deadline,'cutoff',null,
  'stateHash',state_hash,'historicalM83Hash',historical_hash,
  'historicalMissions',84,'maxMissions',96,'tokenAllowance',600000,
  'usedTokens',used,'remainingTokens',600000-used,'additionalPaidRetries',0,
  'remainingMissions',12,'activeMissionId',m84.id,'assignmentId',j84.id,
  'nodeCount',13,'maxWindowHours',72,'authorizationId',null);
END
$offer$;
REVOKE ALL ON FUNCTION public.project_org_bounded_recovery_offer(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_bounded_recovery_offer(uuid,uuid,text) TO service_role;

CREATE FUNCTION public.project_org_bounded_recovery_authorize(
 p_owner uuid,p_project uuid,p_release text,p_generation bigint,p_deployment text,
 p_authorization uuid,p_cutoff timestamptz,p_state_hash text,
 p_mission uuid,p_assignment uuid,p_max_missions integer,p_token_allowance integer,
 p_additional_retries integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $authorize$
DECLARE p work_projects;a project_provider_execution;g project_retest_production_release_gate;
 m84 agent_missions;j84 mission_assignments;offer jsonb;newtime timestamptz;
 n project_organization_nodes; prior_window uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 SELECT * INTO p FROM public.work_projects WHERE id=p_project FOR UPDATE;
 SELECT * INTO a FROM public.project_provider_execution WHERE project_id=p_project FOR UPDATE;
 SELECT * INTO g FROM public.project_retest_production_release_gate WHERE project_id=p_project FOR UPDATE;
 SELECT * INTO m84 FROM public.agent_missions WHERE id=p_mission AND project_id=p_project FOR UPDATE;
 SELECT * INTO j84 FROM public.mission_assignments WHERE id=p_assignment AND mission_id=p_mission FOR UPDATE;
 IF p_authorization IS NULL OR p_max_missions<>96 OR p_token_allowance<>600000 OR p_additional_retries<>0
  OR p_mission IS DISTINCT FROM '18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid
  OR p_assignment IS DISTINCT FROM 'bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid
  OR p_cutoff IS NULL OR NOT isfinite(p_cutoff)
  OR p_cutoff<=clock_timestamp()+interval '30 minutes'
  OR p_cutoff>clock_timestamp()+interval '72 hours'
  OR p_generation IS DISTINCT FROM g.generation OR p_deployment IS DISTINCT FROM g.deployment_id
  OR g.state<>'active' OR p_release IS DISTINCT FROM g.release_sha
 THEN RAISE EXCEPTION 'Exact authenticated owner cutoff, resource ceiling and release approval required';END IF;
 offer:=public.project_org_bounded_recovery_offer(p_owner,p_project,p_release);
 IF offer->>'stage' IS DISTINCT FROM 'authorize'
  OR offer->>'stateHash' IS DISTINCT FROM p_state_hash
  OR offer->>'releaseSha' IS DISTINCT FROM p_release
  OR (offer->>'releaseGeneration')::bigint IS DISTINCT FROM p_generation
  OR offer->>'deploymentId' IS DISTINCT FROM p_deployment
  OR offer->>'activeMissionId' IS DISTINCT FROM p_mission::text
  OR offer->>'assignmentId' IS DISTINCT FROM p_assignment::text
 THEN RAISE EXCEPTION 'Blocked project snapshot changed or approval already consumed';END IF;
 prior_window:=a.window_id;
 INSERT INTO public.project_execution_windows(id,project_id,owner_id,release_sha,decision_id,
  prior_cutoff,cutoff,prior_release_sha)
 VALUES(p_authorization,p.id,p_owner,a.continuation_release_sha,a.continuation_decision_id,
  p.deadline,p_cutoff,a.continuation_release_sha);
 INSERT INTO public.project_bounded_recovery_receipts(
  project_id,authorization_id,owner_id,window_id,release_sha,release_generation,deployment_id,
  scope_hash,prior_window_id,prior_cutoff,cutoff,historical_missions,max_missions,
  token_allowance,additional_paid_retries,active_mission_id,active_assignment_id,
  historical_m83_hash,blocked_event_id,state_hash)
 VALUES(p.id,p_authorization,p_owner,p_authorization,p_release,p_generation,p_deployment,
  p.approved_hash,prior_window,p.deadline,p_cutoff,84,96,600000,0,m84.id,j84.id,
  offer->>'historicalM83Hash',(SELECT id FROM public.project_events e
   WHERE e.project_id=p.id AND e.event='block' AND e.created_at=p.updated_at
   ORDER BY e.created_at DESC LIMIT 1),p_state_hash);
 -- Contracts must be recorded first: existing immutable hierarchy guard
 -- independently checks same-transaction window amendments.
 FOR n IN SELECT * FROM public.project_organization_nodes WHERE project_id=p.id ORDER BY depth,id FOR UPDATE LOOP
  INSERT INTO public.project_organization_contract_changes(
   project_id,node_id,window_id,prior_deadline,deadline,prior_tools,tools,prior_submission)
  VALUES(p.id,n.id,p_authorization,n.deadline,p_cutoff,n.tools,n.tools,n.completion_submission);
  UPDATE public.project_organization_nodes SET deadline=p_cutoff WHERE id=n.id;
 END LOOP;
 UPDATE public.project_provider_execution SET deadline=p_cutoff,window_id=p_authorization
  WHERE project_id=p.id;
 newtime:=clock_timestamp();
 UPDATE public.work_projects SET deadline=p_cutoff,status='running',
  progress_since=newtime,updated_at=newtime,impediment=NULL,
  detail='Authenticated owner resumed original Mission84 under a new bounded execution window.'
  WHERE id=p.id AND status='blocked' AND active_mission_id=m84.id
   AND lease IS NULL AND lease_until IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original blocked parent changed before signed recovery';END IF;
 UPDATE public.agent_missions SET deadline=p_cutoff,status='running',updated_at=newtime
  WHERE id=m84.id AND status='blocked' AND calls=0;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original Mission84 failed authorization changed';END IF;
 IF NOT public.project_org_bounded_recovery_window_valid(p.id)
  OR NOT public.project_org_retest_claim_release_authorized_epoch(p.id,p_release,p_generation,p_deployment)
 THEN RAISE EXCEPTION 'New owner window cannot admit original Mission84 via normal scheduler';END IF;
 INSERT INTO public.project_events(project_id,event,data)
 VALUES(p.id,'original_project_bounded_recovery_authorized',
  jsonb_build_object('authorizationId',p_authorization,'ownerId',p_owner,
   'scopeHash',p.approved_hash,'priorCutoff',offer->>'priorCutoff',
   'cutoff',p_cutoff,'releaseSha',p_release,'generation',p_generation,
   'deploymentId',p_deployment,'missionId',m84.id,'assignmentId',j84.id,
   'historicalMissions',84,'maxMissions',96,'tokenAllowance',600000,
   'additionalPaidRetries',0,'watchdogRefreshedAt',newtime));
 RETURN jsonb_build_object('projectId',p.id,'stage','recovered','existing',false,
  'authorizationId',p_authorization,'authorizedAt',newtime,
  'releaseSha',p_release,'releaseGeneration',p_generation,'deploymentId',p_deployment,
  'scopeHash',p.approved_hash,'priorCutoff',offer->>'priorCutoff',
  'cutoff',p_cutoff,'maxMissions',96,'tokenAllowance',600000,
  'additionalPaidRetries',0,'historicalMissions',84,'nodeCount',13,
  'activeMissionId',m84.id,'assignmentId',j84.id);
END
$authorize$;
REVOKE ALL ON FUNCTION public.project_org_bounded_recovery_authorize(uuid,uuid,text,bigint,text,uuid,timestamptz,text,uuid,uuid,integer,integer,integer)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_bounded_recovery_authorize(uuid,uuid,text,bigint,text,uuid,timestamptz,text,uuid,uuid,integer,integer,integer)
 TO service_role;

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
   or public.project_org_retest_renewed_assignment(m.id,j.id)
   or (j.id='bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid
     and m.id='18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid
     and public.project_org_bounded_recovery_window_valid(a.project_id))) end)
  and public.project_provider_continued(a.project_id));
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
  OR public.project_org_bounded_recovery_claim_authorized(p_project,p_release,p_generation,p_deployment)
 );
$function$;
COMMIT;

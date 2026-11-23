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

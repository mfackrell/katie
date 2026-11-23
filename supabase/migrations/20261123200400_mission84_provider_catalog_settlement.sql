
-- Mission 84 ONLY. Repair the catalog settlement/pending-window self-deadlock
-- and provide exact owner consent for one further scheduler attempt.
-- Never change the original approved cutoff, historical attempts, budgets or source.
BEGIN;
DO $baseline$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.project_org_bounded_recovery_window_valid(uuid)'::regprocedure)
   <> 'c12d984097ba837ae537e2dd21f6c892'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.project_org_bounded_recovery_claim_authorized(uuid,text,bigint,text)'::regprocedure)
   <> '4980653137802bededb838c20cbaf83c'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.project_org_retest_set_release_gate(uuid,text,text,text,bigint)'::regprocedure)
   <> '0828675abebe9c24a175c4996385afec'
 THEN RAISE EXCEPTION 'Mission84 source guard mismatch; refuse SQL replacement';END IF;
END $baseline$;

CREATE TABLE public.project_m84_provider_release_handoffs (
 project_id uuid PRIMARY KEY REFERENCES public.work_projects(id),
 owner_window uuid NOT NULL,
 source_release text NOT NULL,
 source_generation bigint NOT NULL,
 source_deployment text NOT NULL,
 release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
 generation bigint NOT NULL,
 deployment_id text NOT NULL CHECK (deployment_id ~ '^dpl_[A-Za-z0-9]+$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.project_m84_catalog_reconciliations (
 project_id uuid PRIMARY KEY REFERENCES public.work_projects(id),
 request_id uuid NOT NULL UNIQUE REFERENCES public.project_provider_requests(id),
 assignment_id uuid NOT NULL,
 original_lease uuid NOT NULL,
 stop_event_id uuid NOT NULL REFERENCES public.project_events(id),
 observed_error text NOT NULL CHECK (observed_error='Trial provider result could not be confirmed'),
 catalog_receipt text NOT NULL CHECK (catalog_receipt='model-catalog'),
 evidence_source text NOT NULL,
 original_started_at timestamptz NOT NULL,
 reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.project_m84_provider_retry_receipts (
 project_id uuid PRIMARY KEY REFERENCES public.work_projects(id),
 authorization_id uuid NOT NULL UNIQUE,
 owner_id uuid NOT NULL,
 mission_id uuid NOT NULL,
 assignment_id uuid NOT NULL,
 original_request_id uuid NOT NULL REFERENCES public.project_provider_requests(id),
 original_lease uuid NOT NULL,
 prior_attempts integer NOT NULL CHECK(prior_attempts=1),
 prior_calls integer NOT NULL CHECK(prior_calls=0),
 release_sha text NOT NULL,
 release_generation bigint NOT NULL,
 deployment_id text NOT NULL,
 scope_hash text NOT NULL,
 cutoff timestamptz NOT NULL,
 state_hash text NOT NULL,
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.project_m84_provider_release_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_m84_catalog_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_m84_provider_retry_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_m84_provider_release_handoffs,public.project_m84_catalog_reconciliations,public.project_m84_provider_retry_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER m84_release_immutable BEFORE UPDATE OR DELETE ON public.project_m84_provider_release_handoffs
 FOR EACH ROW EXECUTE FUNCTION public.project_org_change_immutable();
CREATE TRIGGER m84_catalog_immutable BEFORE UPDATE OR DELETE ON public.project_m84_catalog_reconciliations
 FOR EACH ROW EXECUTE FUNCTION public.project_org_change_immutable();
CREATE TRIGGER m84_retry_immutable BEFORE UPDATE OR DELETE ON public.project_m84_provider_retry_receipts
 FOR EACH ROW EXECUTE FUNCTION public.project_org_change_immutable();

CREATE FUNCTION public.project_org_m84_provider_release_valid(p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $f$
 SELECT EXISTS(
  SELECT 1 FROM public.project_bounded_recovery_receipts r
  JOIN public.project_retest_production_release_gate g ON g.project_id=r.project_id
  WHERE r.project_id=p_project
    AND g.state='active' AND g.alias_name='katie-mu.vercel.app'
    AND r.owner_id='04ed6c05-a586-4a56-ba81-1b50e378746b'::uuid
    AND r.cutoff>clock_timestamp()
    AND ( (g.release_sha=r.release_sha AND g.generation=r.release_generation AND g.deployment_id=r.deployment_id)
      OR EXISTS(
       SELECT 1 FROM public.project_m84_provider_release_handoffs h
       WHERE h.project_id=r.project_id AND h.owner_window=r.authorization_id
        AND h.source_release=r.release_sha AND h.source_generation=r.release_generation
        AND h.source_deployment=r.deployment_id
        AND h.release_sha=g.release_sha AND h.generation=g.generation
        AND h.deployment_id=g.deployment_id
      ) )
 );
$f$;

-- Release handoff does not renew owner authority, create a retry, or run inference.
-- The operator must independently verify the new canonical alias and READY deployment.
CREATE FUNCTION public.project_org_m84_record_release_handoff(
 p_project uuid,p_old_release text,p_old_generation bigint,p_old_deployment text,
 p_release text,p_generation bigint,p_deployment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $f$
DECLARE r project_bounded_recovery_receipts;g project_retest_production_release_gate;
 p work_projects; h project_m84_provider_release_handoffs;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 SELECT * INTO p FROM public.work_projects WHERE id=p_project FOR UPDATE;
 SELECT * INTO r FROM public.project_bounded_recovery_receipts WHERE project_id=p_project;
 SELECT * INTO g FROM public.project_retest_production_release_gate WHERE project_id=p_project FOR UPDATE;
 SELECT * INTO h FROM public.project_m84_provider_release_handoffs WHERE project_id=p_project;
 IF h.project_id IS NOT NULL THEN RAISE EXCEPTION 'Mission84 release handoff already recorded';END IF;
 IF p_project IS DISTINCT FROM 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
 OR p.status<>'stopped' OR p.phase<>'development'
 OR p.deadline IS DISTINCT FROM '2026-11-26T19:45:00Z'::timestamptz
 OR p.active_mission_id IS DISTINCT FROM '18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid
 OR p.max_missions<>96 OR p.token_allowance<>600000
 OR r.authorization_id IS DISTINCT FROM '403d2604-3789-4c95-ac1d-adf0895fb6ed'::uuid
 OR r.owner_id IS DISTINCT FROM '04ed6c05-a586-4a56-ba81-1b50e378746b'::uuid
 OR r.release_sha IS DISTINCT FROM p_old_release OR r.release_generation IS DISTINCT FROM p_old_generation
 OR r.deployment_id IS DISTINCT FROM p_old_deployment OR r.cutoff IS DISTINCT FROM p.deadline
 OR r.additional_paid_retries<>0
 OR g.state<>'active' OR g.alias_name<>'katie-mu.vercel.app'
 OR g.release_sha IS DISTINCT FROM p_release OR g.generation IS DISTINCT FROM p_generation
 OR g.deployment_id IS DISTINCT FROM p_deployment
 OR p_generation<>p_old_generation+2 OR p_release=p_old_release
 OR (SELECT count(*) FROM public.agent_missions WHERE project_id=p_project)<>84
 OR (SELECT count(*) FROM public.project_work_packages WHERE project_id=p_project)<>0
 THEN RAISE EXCEPTION 'Exact release/operator identity or original approval changed';END IF;
 INSERT INTO public.project_m84_provider_release_handoffs
 (project_id,owner_window,source_release,source_generation,source_deployment,release_sha,generation,deployment_id)
 VALUES(p_project,r.authorization_id,p_old_release,p_old_generation,p_old_deployment,p_release,p_generation,p_deployment);
 INSERT INTO public.project_events(project_id,event,data)
 VALUES(p_project,'mission84_provider_release_handoff',jsonb_build_object(
 'sourceRelease',p_old_release,'sourceGeneration',p_old_generation,'sourceDeployment',p_old_deployment,
 'release',p_release,'generation',p_generation,'deployment',p_deployment,'window',r.authorization_id));
 RETURN jsonb_build_object('projectId',p_project,'releaseSha',p_release,
  'releaseGeneration',p_generation,'deploymentId',p_deployment,'recorded',true);
END $f$;

-- The Vercel error at 2026-11-23T19:50:45.062Z is uniquely emitted AFTER
-- OpenAI models.list() returned a valid array of strings, BEFORE the SQL
-- catalog receipt could be committed. It proves application-observed GET
-- success, NOT a paid inference or an OpenAI-generated request ID.
-- Fixed historical identity; never a general-purpose receipt-fabrication RPC.
CREATE FUNCTION public.project_org_m84_reconcile_observed_catalog(
 p_project uuid,p_release text,p_generation bigint,p_deployment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $f$
DECLARE p work_projects;m agent_missions;j mission_assignments;q project_provider_requests;
 e project_events;z project_m84_catalog_reconciliations;g project_retest_production_release_gate;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 SELECT * INTO p FROM public.work_projects WHERE id=p_project FOR UPDATE;
 SELECT * INTO g FROM public.project_retest_production_release_gate WHERE project_id=p_project FOR UPDATE;
 SELECT * INTO m FROM public.agent_missions WHERE id='18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid FOR UPDATE;
 SELECT * INTO j FROM public.mission_assignments WHERE id='bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid FOR UPDATE;
 SELECT * INTO q FROM public.project_provider_requests WHERE id='58d5926a-7160-42c1-9a04-540351e777dc'::uuid FOR UPDATE;
 SELECT * INTO e FROM public.project_events WHERE project_id=p_project AND event='provider_execution_stopped'
  AND created_at='2026-11-23T19:50:45.007540Z'::timestamptz AND data->>'assignment'=j.id::text;
 SELECT * INTO z FROM public.project_m84_catalog_reconciliations WHERE project_id=p_project;
 IF z.project_id IS NOT NULL THEN
  IF q.resolved_at IS NOT NULL AND q.provider_receipt='model-catalog'
   THEN RETURN jsonb_build_object('stage','reconciled','existing',true,'requestId',q.id);
  END IF;
  RAISE EXCEPTION 'Catalog reconciliation receipt inconsistent';
 END IF;
 IF p.id IS NULL OR p_project IS DISTINCT FROM m.project_id OR p.status<>'stopped'
 OR p.phase<>'development' OR p.deadline IS DISTINCT FROM '2026-11-26T19:45:00Z'::timestamptz
 OR m.status<>'running' OR m.calls<>0 OR m.project_id IS DISTINCT FROM p.id
 OR j.id IS NULL OR j.mission_id IS DISTINCT FROM m.id
 OR j.status<>'queued' OR j.attempts<>1 OR j.lease IS NOT NULL OR j.lease_until IS NOT NULL
 OR j.detail IS DISTINCT FROM 'Worker lease expired; prior model-call reservation remains charged.'
 OR q.execution_attempt IS DISTINCT FROM 'df8a5e69-cd8a-4d1b-a666-aba8f9c53df3'
 OR q.project_id IS DISTINCT FROM p.id OR q.mission_id IS DISTINCT FROM m.id
 OR q.assignment_id IS DISTINCT FROM j.id OR q.worker_id IS DISTINCT FROM j.agent_id
 OR q.operation<>'model-list' OR q.provider_receipt IS NOT NULL OR q.resolved_at IS NOT NULL
 OR q.started_at IS DISTINCT FROM '2026-11-23T19:50:44.360597Z'::timestamptz
 OR q.request_hash IS DISTINCT FROM '24b9b813bb17dce66ff93cd7994df4bd33405f521a819c3d1683cdbd84b4ae5a'
 OR e.id IS NULL OR (SELECT count(*) FROM public.project_provider_requests x
   WHERE x.project_id=p.id AND x.resolved_at IS NULL)<>1
 OR EXISTS(SELECT 1 FROM public.project_provider_requests x
   WHERE x.assignment_id=j.id AND x.operation='inference')
 OR g.state<>'active' OR g.release_sha IS DISTINCT FROM p_release
 OR g.generation IS DISTINCT FROM p_generation OR g.deployment_id IS DISTINCT FROM p_deployment
 OR NOT public.project_org_m84_provider_release_valid(p.id)
 OR EXISTS(SELECT 1 FROM public.project_m84_provider_retry_receipts WHERE project_id=p.id)
 OR (SELECT count(*) FROM public.project_work_packages WHERE project_id=p.id)<>0
 THEN RAISE EXCEPTION 'Original Mission84 catalog result cannot be conclusively reconciled';END IF;
 INSERT INTO public.project_m84_catalog_reconciliations
 (project_id,request_id,assignment_id,original_lease,stop_event_id,observed_error,catalog_receipt,evidence_source,original_started_at)
 VALUES(p.id,q.id,j.id,q.execution_attempt::uuid,e.id,'Trial provider result could not be confirmed','model-catalog',
 'Vercel dpl_4mDDTZqvvGi7VgkbsRCL97Xuhkj7 /api/internal/missions/run request 5j8zq-1795463439167-46739714445f 2026-11-23T19:50:45.062Z; source lib/missions/model.ts trialProviderRequest',q.started_at);
 UPDATE public.project_provider_requests SET provider_receipt='model-catalog',resolved_at=clock_timestamp()
 WHERE id=q.id AND resolved_at IS NULL AND provider_receipt IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original catalog row changed during reconciliation';END IF;
 INSERT INTO public.project_events(project_id,event,data)
 VALUES(p.id,'mission84_catalog_runtime_evidence_reconciled',jsonb_build_object(
 'requestId',q.id,'sourceError','Trial provider result could not be confirmed',
 'originalLease',q.execution_attempt,'originalStartedAt',q.started_at,'externalResponseId',null,
 'paidInference',false,'evidenceClass','application_returned_valid_catalog_before_persistence_rejection'));
 RETURN jsonb_build_object('stage','reconciled','existing',false,'requestId',q.id,
  'receipt','model-catalog','paidInference',false);
END $f$;

CREATE FUNCTION public.project_org_m84_provider_retry_offer(
 p_owner uuid,p_project uuid,p_release text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $f$
DECLARE p work_projects;r project_bounded_recovery_receipts;
 m agent_missions;j mission_assignments;g project_retest_production_release_gate;
 q project_provider_requests;c project_m84_catalog_reconciliations;
 t project_m84_provider_retry_receipts;fingerprint text;
BEGIN
 SELECT * INTO p FROM public.work_projects WHERE id=p_project;
 SELECT * INTO r FROM public.project_bounded_recovery_receipts WHERE project_id=p_project;
 SELECT * INTO g FROM public.project_retest_production_release_gate WHERE project_id=p_project;
 SELECT * INTO m FROM public.agent_missions WHERE id='18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid AND project_id=p_project;
 SELECT * INTO j FROM public.mission_assignments WHERE id='bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid AND mission_id=m.id;
 SELECT * INTO q FROM public.project_provider_requests WHERE id='58d5926a-7160-42c1-9a04-540351e777dc'::uuid;
 SELECT * INTO c FROM public.project_m84_catalog_reconciliations WHERE project_id=p_project;
 SELECT * INTO t FROM public.project_m84_provider_retry_receipts WHERE project_id=p_project;
 IF p_project IS DISTINCT FROM 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid OR p.id IS NULL
 OR p_owner IS DISTINCT FROM r.owner_id OR NOT public.standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 OR p.approved_hash IS DISTINCT FROM '4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
 OR p.approval_hash IS DISTINCT FROM p.approved_hash
 OR p.organization_version<>1 OR p.phase<>'development'
 OR p.deadline IS DISTINCT FROM r.cutoff OR r.cutoff<clock_timestamp()+interval '5 minutes'
 OR p.max_missions<>96 OR p.token_allowance<>600000 OR r.additional_paid_retries<>0
 OR (SELECT count(*) FROM public.agent_missions x WHERE x.project_id=p.id)<>84
 OR (SELECT count(*) FROM public.project_organization_nodes n
  WHERE n.project_id=p.id AND n.status='active' AND n.deadline=p.deadline)<>13
 OR g.state<>'active' OR g.release_sha IS DISTINCT FROM p_release
 OR g.alias_name<>'katie-mu.vercel.app' OR g.generation<=0
 OR NOT public.project_org_m84_provider_release_valid(p.id)
 OR NOT public.project_org_retest_original_owner_lineage(p.id)
 OR NOT public.project_org_bounded_recovery_window_valid(p.id)
 OR c.request_id IS DISTINCT FROM q.id OR q.resolved_at IS NULL OR q.provider_receipt<>'model-catalog'
 OR m.id IS NULL OR j.id IS NULL OR m.calls<>0 OR m.status<>'running'
 OR EXISTS(SELECT 1 FROM public.project_provider_requests x WHERE x.assignment_id=j.id AND x.operation='inference')
 OR public.project_provider_request_pending(p.id)
 OR EXISTS(SELECT 1 FROM public.project_work_packages w WHERE w.project_id=p.id)
 THEN RAISE EXCEPTION 'Exact reconciled Mission84 and valid owner release required';END IF;
 IF t.project_id IS NOT NULL THEN
  RETURN jsonb_build_object('projectId',p.id,'stage','authorized','releaseSha',t.release_sha,
   'releaseGeneration',t.release_generation,'deploymentId',t.deployment_id,
   'scopeHash',t.scope_hash,'cutoff',t.cutoff,'authorizationId',t.authorization_id,
   'missionId',t.mission_id,'assignmentId',t.assignment_id,
   'originalAttempts',t.prior_attempts,'historicalMissions',84,'maxMissions',96,
   'tokenAllowance',600000,'nodeCount',13,'newPaidAttempts',1);
 END IF;
 IF p.status<>'stopped' OR p.active_mission_id IS DISTINCT FROM m.id
 OR j.status<>'queued' OR j.attempts<>1 OR j.lease IS NOT NULL OR j.lease_until IS NOT NULL
 OR j.detail IS DISTINCT FROM 'Worker lease expired; prior model-call reservation remains charged.'
 OR q.execution_attempt IS DISTINCT FROM c.original_lease::text OR j.result IS NOT NULL
 THEN RAISE EXCEPTION 'Expired original running lease and stopped parent required';END IF;
 fingerprint:=encode(sha256(convert_to(concat_ws('|',p.id,p.status,p.deadline,p.updated_at,p.progress_since,
  m.id,m.status,m.calls,j.id,j.status,j.attempts,j.lease,j.lease_until,
  q.id,q.request_hash,q.resolved_at,c.reconciled_at,g.release_sha,g.generation,g.deployment_id),'UTF8')),'hex');
 RETURN jsonb_build_object('projectId',p.id,'stage','authorize','releaseSha',p_release,
  'releaseGeneration',g.generation,'deploymentId',g.deployment_id,'scopeHash',p.approved_hash,
  'cutoff',p.deadline,'stateHash',fingerprint,'authorizationId',null,
  'missionId',m.id,'assignmentId',j.id,'originalRequestId',q.id,
  'originalAttempts',1,'originalCalls',0,'historicalMissions',84,'maxMissions',96,
  'tokenAllowance',600000,'nodeCount',13,'newPaidAttempts',1);
END $f$;

CREATE FUNCTION public.project_org_m84_provider_retry_authorize(
 p_owner uuid,p_project uuid,p_release text,p_generation bigint,p_deployment text,
 p_mission uuid,p_assignment uuid,p_authorization uuid,p_state_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $f$
DECLARE p work_projects;m agent_missions;j mission_assignments;
 g project_retest_production_release_gate;offer jsonb;stamp timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 SELECT * INTO p FROM public.work_projects WHERE id=p_project FOR UPDATE;
 SELECT * INTO g FROM public.project_retest_production_release_gate WHERE project_id=p_project FOR UPDATE;
 SELECT * INTO m FROM public.agent_missions WHERE id=p_mission AND project_id=p_project FOR UPDATE;
 SELECT * INTO j FROM public.mission_assignments WHERE id=p_assignment AND mission_id=p_mission FOR UPDATE;
 IF p_authorization IS NULL OR p_mission IS DISTINCT FROM '18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid
 OR p_assignment IS DISTINCT FROM 'bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid
 OR g.state<>'active' OR g.release_sha IS DISTINCT FROM p_release
 OR g.generation IS DISTINCT FROM p_generation OR g.deployment_id IS DISTINCT FROM p_deployment
 THEN RAISE EXCEPTION 'Fresh authenticated exact release authorization required';END IF;
 offer:=public.project_org_m84_provider_retry_offer(p_owner,p_project,p_release);
 IF offer->>'stage' IS DISTINCT FROM 'authorize'
 OR offer->>'stateHash' IS DISTINCT FROM p_state_hash
 OR (offer->>'releaseGeneration')::bigint IS DISTINCT FROM p_generation
 OR offer->>'deploymentId' IS DISTINCT FROM p_deployment
 OR offer->>'missionId' IS DISTINCT FROM p_mission::text
 OR offer->>'assignmentId' IS DISTINCT FROM p_assignment::text
 THEN RAISE EXCEPTION 'Mission84 owner offer changed or already consumed';END IF;
 stamp:=clock_timestamp();
 INSERT INTO public.project_m84_provider_retry_receipts
 (project_id,authorization_id,owner_id,mission_id,assignment_id,original_request_id,
  original_lease,prior_attempts,prior_calls,release_sha,release_generation,
  deployment_id,scope_hash,cutoff,state_hash)
 VALUES(p.id,p_authorization,p_owner,m.id,j.id,
  '58d5926a-7160-42c1-9a04-540351e777dc'::uuid,(SELECT original_lease FROM public.project_m84_catalog_reconciliations WHERE project_id=p.id),1,0,
  p_release,p_generation,p_deployment,p.approved_hash,p.deadline,p_state_hash);
 UPDATE public.mission_assignments
 SET status='queued',lease=NULL,lease_until=NULL,available_at=stamp,updated_at=stamp,
  detail='Original catalog response reconciled; one additional authenticated owner retry queued.'
 WHERE id=j.id AND status='queued' AND attempts=1 AND lease IS NULL AND lease_until IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original assignment was changed under approval lock';END IF;
 UPDATE public.work_projects SET status='running',progress_since=stamp,updated_at=stamp,
  detail='Owner authorized one additional Mission84 attempt under original deadline.',impediment=NULL
 WHERE id=p.id AND status='stopped' AND active_mission_id=m.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original stopped project changed';END IF;
 IF NOT public.project_org_retest_claim_release_authorized_epoch(p.id,p_release,p_generation,p_deployment)
 THEN RAISE EXCEPTION 'Approved Mission84 retry is ineligible for normal scheduler claim';END IF;
 INSERT INTO public.project_events(project_id,event,data)
 VALUES(p.id,'mission84_one_additional_owner_retry_authorized',jsonb_build_object(
  'authorizationId',p_authorization,'requestId','58d5926a-7160-42c1-9a04-540351e777dc',
  'originalLease',(SELECT original_lease FROM public.project_m84_catalog_reconciliations WHERE project_id=p.id),'originalAttempts',1,'originalCalls',0,
  'newPaidAttempts',1,'releaseSha',p_release,'generation',p_generation,'deploymentId',p_deployment,
  'watchdogRefreshedAt',stamp,'cutoff',p.deadline));
 RETURN jsonb_build_object('projectId',p.id,'stage','authorized','existing',false,
  'authorizationId',p_authorization,'authorizedAt',stamp,
  'releaseSha',p_release,'releaseGeneration',p_generation,'deploymentId',p_deployment,
  'scopeHash',p.approved_hash,'cutoff',p.deadline,'missionId',m.id,'assignmentId',j.id,
  'originalAttempts',1,'newPaidAttempts',1,'historicalMissions',84,'maxMissions',96,
  'tokenAllowance',600000,'nodeCount',13);
END $f$;

REVOKE ALL ON FUNCTION public.project_org_m84_provider_release_valid(uuid),
 public.project_org_m84_record_release_handoff(uuid,text,bigint,text,text,bigint,text),
 public.project_org_m84_reconcile_observed_catalog(uuid,text,bigint,text),
 public.project_org_m84_provider_retry_offer(uuid,uuid,text),
 public.project_org_m84_provider_retry_authorize(uuid,uuid,text,bigint,text,uuid,uuid,uuid,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_m84_provider_release_valid(uuid),
 public.project_org_m84_record_release_handoff(uuid,text,bigint,text,text,bigint,text),
 public.project_org_m84_reconcile_observed_catalog(uuid,text,bigint,text),
 public.project_org_m84_provider_retry_offer(uuid,uuid,text),
 public.project_org_m84_provider_retry_authorize(uuid,uuid,text,bigint,text,uuid,uuid,uuid,text)
 TO service_role;

-- Narrow reviewed function replacements; preserve all prior predicates except the exact pending-receipt exception and release handoff.
CREATE OR REPLACE FUNCTION public.project_org_bounded_recovery_window_valid(p_project uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
   AND public.project_org_m84_provider_release_valid(p.id)
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
   AND ( NOT public.project_provider_request_pending(p.id)
      OR ( p.status='running' AND p.active_mission_id=r.active_mission_id
       AND j84.status='running' AND j84.attempts IN (1,2)
       AND j84.lease IS NOT NULL AND j84.lease_until>clock_timestamp()
       AND (SELECT count(*) FROM public.project_provider_requests pending
         WHERE pending.project_id=p.id AND pending.resolved_at IS NULL)=1
       AND EXISTS (SELECT 1 FROM public.project_provider_requests pending
         WHERE pending.project_id=p.id AND pending.mission_id=m84.id
          AND pending.assignment_id=j84.id AND pending.worker_id=j84.agent_id
          AND pending.execution_attempt=j84.lease::text
          AND pending.operation IN ('model-list','inference')
          AND pending.provider_receipt IS NULL AND pending.resolved_at IS NULL)
      ) )
   AND (SELECT coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0)
    FROM public.agent_missions spent WHERE spent.project_id=p.id)<=600000
 );
$function$
;
CREATE OR REPLACE FUNCTION public.project_org_bounded_recovery_claim_authorized(p_project uuid, p_release text, p_generation bigint, p_deployment text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT EXISTS(
  SELECT 1 FROM public.project_bounded_recovery_receipts r
  JOIN public.work_projects p ON p.id=r.project_id
  JOIN public.agent_missions m ON m.id=p.active_mission_id
   AND m.project_id=p.id AND m.status='running'
   AND m.calls=0 AND m.deadline=p.deadline
   AND m.project_kind IN ('management','organization_work')
  JOIN public.mission_assignments j ON j.mission_id=m.id
   AND j.status='queued' AND (j.attempts=0 OR (
      j.attempts=1 AND m.id=r.active_mission_id AND j.id=r.active_assignment_id
      AND EXISTS(SELECT 1 FROM public.project_m84_provider_retry_receipts retry
       WHERE retry.project_id=p.id AND retry.assignment_id=j.id AND retry.mission_id=m.id
        AND retry.prior_attempts=1 AND retry.prior_calls=0
        AND retry.release_sha=p_release AND retry.release_generation=p_generation
        AND retry.deployment_id=p_deployment AND retry.cutoff=p.deadline)))
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
   AND public.project_org_m84_provider_release_valid(p.id)
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
      AND (j.attempts=0 OR
       (j.attempts=1 AND EXISTS(SELECT 1 FROM public.project_m84_provider_retry_receipts retry
         WHERE retry.project_id=p.id AND retry.assignment_id=j.id
          AND retry.release_sha=p_release AND retry.release_generation=p_generation
          AND retry.deployment_id=p_deployment))) AND m.created_at<r.authorized_at)
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
$function$
;

-- Only this exact stopped, proven-nonbillable Mission84 may cross the gate while queued.
CREATE OR REPLACE FUNCTION public.project_org_retest_set_release_gate(p_project uuid, p_release text, p_deployment text, p_action text, p_expected_generation bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare g project_retest_production_release_gate;p work_projects;stamp timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 select * into p from work_projects where id=p_project for update;
 select * into g from project_retest_production_release_gate where project_id=p_project for update;
 if p_expected_generation is null or p_expected_generation<0
  or (g.project_id is null and p_expected_generation<>0)
  or (g.project_id is not null and g.generation is distinct from p_expected_generation)
 then raise exception 'Observed release gate generation changed under operator lock';end if;
 if p.id is null or p.id is distinct from 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  or p_release is null or p_release !~ '^[0-9a-f]{40}$'
  or p_deployment is null or p_deployment !~ '^dpl_[A-Za-z0-9]+$'
  or p_action is null or p_action not in ('active','closed')
  or p.max_missions<>96 or p.token_allowance<>600000
  or p.approved_hash is distinct from '4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
  or not exists(select 1 from project_blocked_management_retest_receipts r
    where r.project_id=p_project and r.historical_missions=78)
 then raise exception 'Exact original project release authority required';end if;
 if p_action='closed' and (g.project_id is null or g.state<>'active'
   or g.release_sha is distinct from p_release or g.deployment_id is distinct from p_deployment)
 then raise exception 'Only active exact deployment can be sealed before promotion';end if;
 if p_action='active' and g.project_id is not null and g.state<>'closed'
 then raise exception 'Prior release must be closed before a new SHA is activated';end if;
 -- A bound but unleased original management mission still has a valid
 -- one-time owner grant. Closing and reopening this gate would invalidate
 -- its immutable generation without any supported rebinding operation.
 -- Fail CLOSED before any release mutation; let normal cron claim it, or
 -- terminalize the expired unleased window under its existing exact epoch.
 if p_action='closed' and exists(
  select 1 from project_retest_claim_release_receipts receipt
  join agent_missions m on m.id=receipt.mission_id
  join mission_assignments j on j.id=receipt.assignment_id and j.mission_id=m.id
  join work_projects wp on wp.id=receipt.project_id
  where receipt.project_id=p_project
   and receipt.mission_id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
   and receipt.assignment_id='85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
   and receipt.bound_release_sha=g.release_sha
   and receipt.bound_deployment_id=g.deployment_id
   and receipt.bound_release_generation=g.generation
   and wp.active_mission_id=m.id
   -- The normal project cron may have blocked an expired owner window
   -- before mission cron can terminally settle this still-unclaimed job.
   -- Do not let CLOSE invalidate that bound generation on either status.
   and wp.status in ('running','blocked') and m.status in ('running','blocked')
   and j.status='queued' and j.attempts=0
   and j.lease is null and j.lease_until is null
 ) then raise exception 'Bound original mission79 is unleased; close only after normal claim or expiry settlement';end if;
 -- Closing a generation must NEVER race a paid worker that already holds a
 -- source-bound lease. An expired lease can be cleared/requeued by the worker
 -- scheduler while the original worker is still in-flight, so reject every
 -- non-completed attempted assignment in the renewed mission lineage, even
 -- when lease is null. Terminal completed jobs cannot start new inference.
 -- The global state/claim advisory locks serialize this check with leasing.
 if exists(
  select 1 from agent_missions m
  join mission_assignments j on j.mission_id=m.id
  left join project_retest_future_window_receipts w on w.project_id=m.project_id
  where m.project_id=p_project
   and (m.id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
     or (w.project_id is not null and m.created_at>=w.authorized_at))
   and j.attempts>0
   and NOT (j.id='85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid and m.id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid and j.status='queued' and j.attempts=1 and j.lease is null and j.lease_until is null and m.status='running' and m.calls=1 and p.status='blocked' and p.active_mission_id=m.id and p.deadline>clock_timestamp()+interval '5 minutes' and exists (select 1 from project_mission79_retry_receipts r where r.project_id=p.id and r.assignment_id=j.id and r.mission_id=m.id and r.release_sha=g.release_sha and r.release_generation=g.generation - CASE WHEN g.state='closed' THEN 1 ELSE 0 END and r.deployment_id=g.deployment_id and r.prior_attempts=1 and r.prior_calls=1) and not project_provider_request_pending(p.id))
   -- An already STOPPED, fully reconciled, nonbillable Mission84 catalog
   -- may be transferred to the exact new production release without allowing
   -- a new inference, consuming a retry or relaxing any other release fence.
   and NOT (
    p_action='closed'
    and j.id='bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid
    and m.id='18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid
    and j.status='queued' and j.attempts=1
    and j.lease is null and j.lease_until is null
    and m.status='running' and m.calls=0
    and p.status='stopped' and p.active_mission_id=m.id
    and p.deadline>clock_timestamp()+interval '5 minutes'
    and exists(select 1 from public.project_bounded_recovery_receipts r
      where r.project_id=p.id and r.release_sha=g.release_sha
       and r.release_generation=g.generation and r.deployment_id=g.deployment_id
       and r.cutoff=p.deadline and r.additional_paid_retries=0)
    and exists(select 1 from public.project_m84_catalog_reconciliations c
      join public.project_provider_requests q on q.id=c.request_id
      where c.project_id=p.id and c.assignment_id=j.id
       and q.project_id=p.id and q.mission_id=m.id
       and q.operation='model-list' and q.provider_receipt='model-catalog'
       and q.resolved_at is not null)
    and not public.project_provider_request_pending(p.id)
   )
   and (j.lease is not null or j.lease_until is not null
    or j.status not in ('completed','failed')
    or (j.status='failed' and exists(
      select 1 from project_provider_requests request
      where request.assignment_id=j.id and request.resolved_at is null)))
 ) or project_provider_request_pending(p_project)
 then raise exception 'Undrained owner-renewed worker attempt or unresolved provider request; release gate transition denied';end if;
 stamp:=clock_timestamp();
 if g.project_id is null then
  if p_action<>'active' then raise exception 'Initial release requires verified READY alias';end if;
  insert into project_retest_production_release_gate
   (project_id,release_sha,deployment_id,state,generation,updated_at)
   values(p_project,p_release,p_deployment,'active',1,stamp);
 else
  update project_retest_production_release_gate
   set release_sha=p_release,deployment_id=p_deployment,state=p_action,
       generation=g.generation+1,updated_at=stamp where project_id=p_project;
 end if;
 insert into project_events(project_id,event,data)
 values(p_project,'mission79_release_gate_transition',
  jsonb_build_object('action',p_action,'releaseSha',p_release,
    'deploymentId',p_deployment,'alias','katie-mu.vercel.app',
    'priorGeneration',g.generation,'recordedAt',stamp));
 return jsonb_build_object('projectId',p_project,'state',p_action,
  'releaseSha',p_release,'deploymentId',p_deployment,'recordedAt',stamp);
end
$function$
;
COMMIT;

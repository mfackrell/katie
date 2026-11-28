-- Exact retained native final-review checkpoint. All prior receipts, costs,
-- attempts, contracts and scope remain authoritative and auditable.
CREATE TABLE public.project_package_checkpoint_continuations (
 project_id uuid PRIMARY KEY REFERENCES public.work_projects(id),
 package_id uuid NOT NULL REFERENCES public.project_work_packages(id),
 authorization_id uuid NOT NULL UNIQUE REFERENCES public.project_execution_windows(id),
 owner_id uuid NOT NULL, mission_id uuid NOT NULL REFERENCES public.agent_missions(id),
 assignment_id uuid NOT NULL REFERENCES public.mission_assignments(id),
 release_sha text NOT NULL, release_generation bigint NOT NULL, deployment_id text NOT NULL,
 prior_cutoff timestamptz NOT NULL, cutoff timestamptz NOT NULL,
 proof jsonb NOT NULL, terms jsonb NOT NULL, state_hash text NOT NULL,
 prior_state jsonb NOT NULL, renewed_fingerprint text NOT NULL,
 authorization_txid bigint NOT NULL DEFAULT txid_current(),
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.project_package_checkpoint_continuations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_package_checkpoint_continuations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.project_package_checkpoint_continuations TO service_role;
CREATE TRIGGER checkpoint_continuation_immutable BEFORE UPDATE OR DELETE ON public.project_package_checkpoint_continuations FOR EACH ROW EXECUTE FUNCTION public.project_org_change_immutable();

-- The original dispatch table is keyed by assignment, not run. Do not
-- overwrite its immutable first-run binding or permit generic redispatch.
CREATE TABLE public.project_package_checkpoint_dispatches (
 authorization_id uuid PRIMARY KEY REFERENCES public.project_package_checkpoint_continuations(authorization_id),
 task_id uuid NOT NULL UNIQUE REFERENCES public.agent_tasks(id),
 run_id text NOT NULL UNIQUE CHECK(run_id~'^[1-9][0-9]{0,19}$'),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.project_package_checkpoint_dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_package_checkpoint_dispatches FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER checkpoint_dispatch_immutable BEFORE UPDATE OR DELETE ON public.project_package_checkpoint_dispatches FOR EACH ROW EXECUTE FUNCTION public.project_org_change_immutable();

CREATE FUNCTION public.project_org_package_checkpoint_terms() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path TO public,pg_temp AS $$
 SELECT '{"maxMissions":124,"developmentAttempts":5,"codingDispatches":5,"managerMissions":10,"nativeInferencePerDispatch":12,"nativeInferenceLimit":60,"compositionLimit":5,"reviewLimit":5,"paidInferenceLimit":80,"finalReviewDispatches":1,"finalReviewInferenceLimit":12,"additionalPaidRetries":0,"automaticRetries":0,"nativeAutomaticRepairs":0,"tokenAllowance":600000,"additionalTokens":0,"spendMode":"provider-account","dollarCeilingMicrousd":null,"stopAt":"verified-protected-preview"}'::jsonb
$$;

CREATE FUNCTION public.project_org_package_checkpoint_snapshot(p_project uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $$
DECLARE p work_projects; w project_work_packages; r project_package_execution_receipts; a project_provider_execution; m agent_missions; j mission_assignments; t agent_tasks;
BEGIN
 SELECT * INTO p FROM work_projects WHERE id=p_project;
 SELECT * INTO r FROM project_package_execution_receipts WHERE project_id=p_project;
 SELECT * INTO w FROM project_work_packages WHERE id=r.package_id AND project_id=p_project;
 SELECT * INTO a FROM project_provider_execution WHERE project_id=p_project;
 SELECT * INTO m FROM agent_missions WHERE id='aeffa160-d240-46d1-b240-dc0ac7f488d5' AND project_id=p_project;
 SELECT * INTO j FROM mission_assignments WHERE id='1c940466-c034-4e21-8dc5-d2ecf1212098' AND mission_id=m.id;
 SELECT * INTO t FROM agent_tasks WHERE id=j.id;
 IF p.id IS DISTINCT FROM 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid OR w.id IS DISTINCT FROM 'f88d4d10-dfe4-479e-a2cf-41b3e8209e47'::uuid
 OR r.authorization_id IS DISTINCT FROM 'c7c2f1d4-8b8d-4ae9-af5b-dff5eab9d667'::uuid
 OR a.owner_id IS DISTINCT FROM r.owner_id OR p.status IS DISTINCT FROM 'blocked' OR p.phase IS DISTINCT FROM 'development'
 OR p.active_mission_id IS NOT NULL OR p.lease IS NOT NULL OR p.lease_until IS NOT NULL
 OR p.organization_version<>1 OR p.milestone_index<>0 OR p.cycles<>4 OR p.max_cycles<>5 OR p.max_missions<>118 OR p.token_allowance<>600000
 OR p.verified_sha IS NOT NULL OR p.preview IS NOT NULL
 OR p.deadline IS DISTINCT FROM r.cutoff OR a.deadline IS DISTINCT FROM r.cutoff OR w.deadline IS DISTINCT FROM r.cutoff
 OR r.cutoff IS DISTINCT FROM '2026-11-26T19:45:00Z'::timestamptz OR r.cutoff>clock_timestamp()
 OR p.approved_hash IS DISTINCT FROM r.scope_hash OR p.approval_hash IS DISTINCT FROM r.scope_hash OR a.approved_scope IS DISTINCT FROM r.scope_hash
 OR project_org_package_execution_fingerprint(w.id) IS DISTINCT FROM r.contract_fingerprint
 OR w.status IS DISTINCT FROM 'queued' OR m.status IS DISTINCT FROM 'blocked' OR m.project_kind IS DISTINCT FROM 'development'
 OR j.status IS DISTINCT FROM 'failed' OR j.role IS DISTINCT FROM 'development' OR j.attempts<>1
 OR t.status IS DISTINCT FROM 'blocked' OR t.repository_full_name IS DISTINCT FROM 'mfackrell/katie'
 OR t.external->>'attempted' IS DISTINCT FROM 'true' OR t.external->>'issueNumber' IS DISTINCT FROM '1191'
 OR t.external->>'providerExecutionRelease' IS DISTINCT FROM 'dee56dfec88a87e3f026604ff9e208fd41a860b1'
 OR t.external->'receipt'->>'run_id' IS DISTINCT FROM '45863524946'
 OR t.external->'receipt'->>'outcome' IS DISTINCT FROM 'BLOCKED'
 OR t.external->'receipt'->'providerExecutionEvidence'->>'failure' IS DISTINCT FROM 'NATIVE_HOST_DENIED: native final-review failed; evidence retained'
 OR t.external->'receipt'->'providerExecutionEvidence'->>'candidateHead' IS DISTINCT FROM '7b0a415189ffd849bbaa645ce1bea499693bee94'
 OR t.external->'receipt'->'providerExecutionEvidence'->>'responses' IS DISTINCT FROM '12'
 OR t.external->'receipt'->'providerExecutionEvidence'->>'unknownUsage' IS DISTINCT FROM '0'
 OR NOT project_provider_continued(p_project)
 OR EXISTS(SELECT 1 FROM project_package_checkpoint_continuations WHERE project_id=p_project)
 OR (SELECT count(*) FROM agent_missions WHERE project_id=p_project)<>116
 OR (SELECT count(*) FROM agent_missions WHERE project_id=p_project AND id=ANY(r.historical_mission_ids))<>104
 OR (SELECT count(*) FROM project_work_packages WHERE project_id=p_project)<>1
 OR (SELECT count(*) FROM project_work_package_attempts WHERE package_id=w.id)<>4
 OR NOT EXISTS(SELECT 1 FROM project_work_package_attempts WHERE package_id=w.id AND mission_id=m.id AND attempt=4)
 OR (SELECT count(*) FROM mission_assignments WHERE mission_id=m.id AND role IN('compose','review') AND status='queued' AND attempts=0)<>2
 OR (SELECT count(*) FROM project_worker_contracts WHERE package_id=w.id)<>3
 OR EXISTS(SELECT 1 FROM project_worker_contracts WHERE package_id=w.id AND deadline IS DISTINCT FROM p.deadline)
 OR EXISTS(SELECT 1 FROM project_organization_nodes WHERE project_id=p_project AND deadline IS DISTINCT FROM p.deadline)
 OR EXISTS(SELECT 1 FROM agent_missions WHERE project_id=p_project AND status IN('running','awaiting_approval'))
 OR EXISTS(SELECT 1 FROM mission_assignments x JOIN agent_missions y ON y.id=x.mission_id WHERE y.project_id=p_project AND (x.lease IS NOT NULL OR x.lease_until IS NOT NULL))
 OR project_provider_request_pending(p_project)
 OR (SELECT count(*) FROM project_provider_dispatches WHERE task_id=j.id)<>1
 OR NOT EXISTS(SELECT 1 FROM project_provider_dispatches WHERE task_id=j.id AND run_id='45863524946')
 OR (SELECT count(*) FROM project_provider_requests WHERE assignment_id=j.id)<>24
 OR (SELECT count(*) FROM project_provider_requests WHERE assignment_id=j.id AND execution_attempt='45863524946' AND operation='inference' AND resolved_at IS NOT NULL AND provider_receipt IS NOT NULL)<>12
 OR (SELECT count(*) FROM project_provider_requests WHERE assignment_id=j.id AND execution_attempt='45863524946' AND operation='input-count' AND resolved_at IS NOT NULL AND provider_receipt IS NOT NULL)<>12
 OR (SELECT count(*) FROM project_provider_requests WHERE project_id=p_project AND operation='inference' AND NOT mission_id=ANY(r.historical_mission_ids))<>22
 OR NOT EXISTS(SELECT 1 FROM project_runs WHERE project_id=p_project AND mission_id=m.id AND binding->>'scopeHash'=p.approved_hash AND binding->>'baseSha'='97b1e385aea70a8543aadef7fc5e8051de996e37' AND binding->>'contractHash'='5f09fae90b19ccb618c7dd2ab25adfba4b2be4b11ae68cb1608b06f70237ac6d')
 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('project',to_jsonb(p),'package',to_jsonb(w),'rootReceipt',to_jsonb(r),'providerAuthority',to_jsonb(a),
 'mission',to_jsonb(m),'assignment',to_jsonb(j),'task',to_jsonb(t),
 'run',(SELECT to_jsonb(x) FROM project_runs x WHERE x.mission_id=m.id),
 'missions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM agent_missions x WHERE x.project_id=p_project),
 'jobs',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM mission_assignments x JOIN agent_missions y ON y.id=x.mission_id WHERE y.project_id=p_project),
 'requests',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM project_provider_requests x WHERE x.project_id=p_project),
 'nodes',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM project_organization_nodes x WHERE x.project_id=p_project),
 'contracts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM project_worker_contracts x WHERE x.package_id=w.id));
END $$;

CREATE FUNCTION public.project_org_package_checkpoint_offer(p_owner uuid,p_project uuid,p_release text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $$
DECLARE s jsonb; g project_retest_production_release_gate; w project_work_packages; r project_package_execution_receipts; p work_projects; cutoff timestamptz; h text;
BEGIN
 s:=project_org_package_checkpoint_snapshot(p_project);
 SELECT * INTO p FROM work_projects WHERE id=p_project;
 SELECT * INTO r FROM project_package_execution_receipts WHERE project_id=p_project;
 SELECT * INTO w FROM project_work_packages WHERE id=r.package_id;
 SELECT * INTO g FROM project_retest_production_release_gate WHERE project_id=p_project;
 IF s IS NULL OR p_owner IS NULL OR p_owner IS DISTINCT FROM r.owner_id OR standalone_verify_scope(p_owner,p.actor_id,p.chat_id) IS DISTINCT FROM true
 OR g.state IS DISTINCT FROM 'active' OR g.alias_name IS DISTINCT FROM 'katie-mu.vercel.app' OR g.generation<>71 OR g.release_sha IS DISTINCT FROM p_release OR p_release='dee56dfec88a87e3f026604ff9e208fd41a860b1'
 THEN RAISE EXCEPTION 'Exact drained checkpoint and authenticated corrected production owner required'; END IF;
 cutoff:=date_trunc('hour',clock_timestamp())+interval '24 hours';
 h:=encode(sha256(convert_to(project_canonical(jsonb_build_object('snapshot',s,'gate',to_jsonb(g),'cutoff',cutoff,'terms',project_org_package_checkpoint_terms(),'candidate','7b0a415189ffd849bbaa645ce1bea499693bee94','checkpoint','a3a853e00278d719a14f843c4abdbae04b7ab141')),'UTF8')),'hex');
 RETURN jsonb_build_object('stage','authorize','projectId',p.id,'packageId',w.id,'priorAuthorizationId',r.authorization_id,
 'releaseSha',g.release_sha,'releaseGeneration',g.generation,'deploymentId',g.deployment_id,'scopeHash',w.scope_hash,'cutoff',cutoff,'stateHash',h,
 'contractFingerprint',r.contract_fingerprint,'managerId',w.manager_id,'coderId',w.worker_id,'writerId',w.writer_id,'reviewerId',w.reviewer_id,'paths',w.paths,
 'developmentPaths',(SELECT c.contract->'paths' FROM project_worker_contracts c WHERE c.package_id=w.id AND c.role='development'),'terms',r.terms,
 'checkpointRecovery',jsonb_build_object('priorCutoff',r.cutoff,'missionId','aeffa160-d240-46d1-b240-dc0ac7f488d5','assignmentId','1c940466-c034-4e21-8dc5-d2ecf1212098','priorRunId','45863524946','candidateSha','7b0a415189ffd849bbaa645ce1bea499693bee94','checkpointSha','a3a853e00278d719a14f843c4abdbae04b7ab141','sourceTreeSha','ae1fb9b658acb4bf3445464d3a37e62aeb457123','usedMissions',116,'usedAttempts',4,'paidInferences',22,'nativeInferences',12,'terms',project_org_package_checkpoint_terms()));
END $$;

CREATE FUNCTION public.project_org_package_checkpoint_authorize(p_owner uuid,p_project uuid,p_package uuid,p_release text,p_generation bigint,p_deployment text,p_authorization uuid,p_state_hash text,p_terms jsonb,p_cutoff timestamptz,p_consent boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $$
DECLARE o jsonb; s jsonb; a project_provider_execution; r project_package_execution_receipts; stamp timestamptz; proof jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 PERFORM 1 FROM work_projects WHERE id=p_project FOR UPDATE;
 PERFORM 1 FROM project_retest_production_release_gate WHERE project_id=p_project FOR UPDATE;
 PERFORM 1 FROM project_work_packages WHERE id=p_package AND project_id=p_project FOR UPDATE;
 PERFORM 1 FROM project_worker_contracts WHERE package_id=p_package ORDER BY id FOR UPDATE;
 PERFORM 1 FROM project_organization_nodes WHERE project_id=p_project ORDER BY id FOR UPDATE;
 o:=project_org_package_checkpoint_offer(p_owner,p_project,p_release);
 IF p_consent IS DISTINCT FROM true OR p_authorization IS NULL OR p_package::text IS DISTINCT FROM o->>'packageId'
 OR p_generation IS DISTINCT FROM (o->>'releaseGeneration')::bigint OR p_deployment IS DISTINCT FROM o->>'deploymentId'
 OR p_state_hash IS DISTINCT FROM o->>'stateHash' OR p_terms IS DISTINCT FROM project_org_package_checkpoint_terms()
 OR p_cutoff IS DISTINCT FROM (o->>'cutoff')::timestamptz OR p_cutoff<=clock_timestamp()+interval '5 minutes'
 THEN RAISE EXCEPTION 'Stale, changed or unsigned checkpoint authorization'; END IF;
 s:=project_org_package_checkpoint_snapshot(p_project);
 SELECT * INTO a FROM project_provider_execution WHERE project_id=p_project;
 SELECT * INTO r FROM project_package_execution_receipts WHERE project_id=p_project;
 stamp:=clock_timestamp();
 proof:=jsonb_build_object('authorizationId',p_authorization,'priorRunId','45863524946','candidateSha','7b0a415189ffd849bbaa645ce1bea499693bee94','checkpointSha','a3a853e00278d719a14f843c4abdbae04b7ab141','sourceTreeSha','ae1fb9b658acb4bf3445464d3a37e62aeb457123');
 INSERT INTO project_execution_windows(id,project_id,owner_id,release_sha,decision_id,prior_cutoff,cutoff,prior_release_sha,authorized_at)
 VALUES(p_authorization,p_project,p_owner,a.continuation_release_sha,a.continuation_decision_id,a.deadline,p_cutoff,a.continuation_release_sha,stamp);
 INSERT INTO project_organization_contract_changes(project_id,node_id,window_id,prior_deadline,deadline,prior_tools,tools,prior_submission,transaction_id)
 SELECT project_id,id,p_authorization,deadline,p_cutoff,tools,tools,completion_submission,txid_current() FROM project_organization_nodes WHERE project_id=p_project;
 UPDATE project_organization_nodes SET deadline=p_cutoff WHERE project_id=p_project;
 UPDATE project_worker_contracts SET deadline=p_cutoff WHERE package_id=p_package;
 UPDATE project_work_packages SET deadline=p_cutoff,status='running' WHERE id=p_package;
 UPDATE project_provider_execution SET deadline=p_cutoff,window_id=p_authorization WHERE project_id=p_project;
 INSERT INTO project_package_checkpoint_continuations(project_id,package_id,authorization_id,owner_id,mission_id,assignment_id,release_sha,release_generation,deployment_id,prior_cutoff,cutoff,proof,terms,state_hash,prior_state,renewed_fingerprint,authorized_at)
 VALUES(p_project,p_package,p_authorization,p_owner,'aeffa160-d240-46d1-b240-dc0ac7f488d5','1c940466-c034-4e21-8dc5-d2ecf1212098',p_release,p_generation,p_deployment,r.cutoff,p_cutoff,proof,p_terms,p_state_hash,s,project_org_package_execution_fingerprint(p_package),stamp);
 UPDATE work_projects SET deadline=p_cutoff,max_missions=(p_terms->>'maxMissions')::int,status='running',active_mission_id='aeffa160-d240-46d1-b240-dc0ac7f488d5',
 detail='Authenticated retained checkpoint continuation: final review only, then existing acceptance and delivery.',progress_since=stamp,progress_signature=NULL,error_signature=NULL,repeated_errors=0,impediment=NULL,updated_at=stamp WHERE id=p_project;
 UPDATE agent_missions SET status='running',deadline=p_cutoff,project_evidence=project_evidence||jsonb_build_object('providerContinuationWindow',p_authorization,'checkpointRecoveryAuthorizationId',p_authorization),updated_at=stamp WHERE id='aeffa160-d240-46d1-b240-dc0ac7f488d5';
 UPDATE mission_assignments SET status='waiting_external' WHERE id='1c940466-c034-4e21-8dc5-d2ecf1212098';
 UPDATE agent_tasks SET status='dispatching',external=external||jsonb_build_object('checkpointRecoveryAuthorizationId',p_authorization,'checkpointRecoveryCandidate','7b0a415189ffd849bbaa645ce1bea499693bee94') WHERE id='1c940466-c034-4e21-8dc5-d2ecf1212098';
 IF NOT project_org_package_execution_live(p_project) OR NOT project_org_package_execution_assignment('1c940466-c034-4e21-8dc5-d2ecf1212098') THEN RAISE EXCEPTION 'Renewed checkpoint authority does not satisfy existing execution fences'; END IF;
 INSERT INTO project_events(project_id,event,data) VALUES(p_project,'package_checkpoint_authorized',o||jsonb_build_object('authorizationId',p_authorization,'authorizedAt',stamp));
 RETURN o||jsonb_build_object('stage','authorized','authorizationId',p_authorization,'authorizedAt',stamp);
END $$;

CREATE FUNCTION public.project_org_package_checkpoint_live(p_project uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM project_package_checkpoint_continuations c
 JOIN project_package_execution_receipts r ON r.project_id=c.project_id AND r.package_id=c.package_id AND r.owner_id=c.owner_id
 JOIN work_projects p ON p.id=c.project_id
 JOIN project_work_packages w ON w.id=c.package_id AND w.project_id=p.id
 JOIN project_provider_execution a ON a.project_id=p.id AND a.owner_id=c.owner_id AND a.window_id=c.authorization_id
 JOIN project_execution_windows x ON x.id=c.authorization_id AND x.project_id=p.id AND x.owner_id=c.owner_id
 JOIN project_retest_production_release_gate g ON g.project_id=p.id
 WHERE p.id=p_project AND p.status='running' AND p.phase IN('development','delivery','browser_check','assessment')
 AND p.deadline=c.cutoff AND a.deadline=c.cutoff AND w.deadline=c.cutoff AND x.cutoff=c.cutoff AND c.cutoff>clock_timestamp()
 AND g.state='active' AND g.alias_name='katie-mu.vercel.app' AND g.release_sha=c.release_sha AND g.generation=c.release_generation AND g.deployment_id=c.deployment_id
 AND p.approved_hash=r.scope_hash AND p.approval_hash=r.scope_hash AND a.approved_scope=r.scope_hash
 AND p.max_missions=(c.terms->>'maxMissions')::int AND p.max_cycles=5 AND p.cycles=4 AND p.token_allowance=600000
 AND c.terms=project_org_package_checkpoint_terms() AND project_provider_continued(p.id)
 AND project_org_package_execution_fingerprint(w.id)=c.renewed_fingerprint
 AND (SELECT count(*) FROM agent_missions WHERE project_id=p.id AND id=ANY(r.historical_mission_ids))=104
 AND (SELECT count(*) FROM agent_missions WHERE project_id=p.id)<=p.max_missions
 AND (SELECT count(*) FROM project_work_package_attempts WHERE package_id=w.id)=4
 AND (SELECT count(*) FROM project_work_packages WHERE project_id=p.id)=1
 AND (p.phase='development' AND p.milestone_index=0 OR p.phase<>'development' AND p.milestone_index=1 AND p.verified_sha=c.proof->>'candidateSha' AND w.status='accepted'))
$$;

CREATE FUNCTION public.project_org_package_checkpoint_dispatch_live(p_task uuid,p_authorization uuid,p_release text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM project_package_checkpoint_continuations c JOIN agent_tasks t ON t.id=c.assignment_id
 WHERE c.assignment_id=p_task AND c.authorization_id=p_authorization AND c.release_sha=p_release
 AND project_org_package_checkpoint_live(c.project_id) AND project_org_package_execution_assignment(p_task)
 AND t.status IN('dispatching','submitted') AND t.external->>'checkpointRecoveryAuthorizationId'=c.authorization_id::text
 AND t.external->>'checkpointRecoveryCandidate'=c.proof->>'candidateSha' AND t.external->>'providerExecutionRelease'=c.release_sha
 AND t.external->>'checkpointRecoveryDispatchClaimedAt' IS NOT NULL
 AND t.external->'receipt'->>'run_id'=c.proof->>'priorRunId')
$$;

CREATE FUNCTION public.project_org_package_checkpoint_dispatch_offer(p_task uuid,p_lease uuid,p_release text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $$
DECLARE c project_package_checkpoint_continuations; t agent_tasks;
BEGIN
 SELECT * INTO c FROM project_package_checkpoint_continuations WHERE assignment_id=p_task AND release_sha=p_release;
 SELECT * INTO t FROM agent_tasks WHERE id=p_task;
 IF c.project_id IS NULL OR NOT project_org_package_checkpoint_live(c.project_id) OR NOT project_org_package_coding_authorized(p_task,p_lease)
 OR t.status IS DISTINCT FROM 'dispatching' OR t.external->>'checkpointRecoveryAuthorizationId' IS DISTINCT FROM c.authorization_id::text
 OR t.external->>'checkpointRecoveryDispatchClaimedAt' IS NOT NULL OR t.external->'receipt'->>'run_id' IS DISTINCT FROM c.proof->>'priorRunId'
 OR project_provider_request_pending(c.project_id)
 OR (SELECT count(*) FROM project_provider_dispatches WHERE task_id=p_task)<>1
 THEN RAISE EXCEPTION 'Exact unclaimed final-review continuation required'; END IF;
 RETURN jsonb_build_object('proof',c.proof,'cutoff',c.cutoff,'priorRelease',c.prior_state->'task'->'external'->>'providerExecutionRelease','issueNumber',1191);
END $$;

CREATE FUNCTION public.project_org_package_checkpoint_claim_dispatch(p_task uuid,p_lease uuid,p_authorization uuid,p_release text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $$
DECLARE o jsonb; t agent_tasks;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 PERFORM 1 FROM agent_tasks WHERE id=p_task FOR UPDATE;
 o:=project_org_package_checkpoint_dispatch_offer(p_task,p_lease,p_release);
 IF p_authorization::text IS DISTINCT FROM o->'proof'->>'authorizationId' THEN RETURN 'false'::jsonb; END IF;
 UPDATE agent_tasks SET external=external||jsonb_build_object('checkpointRecoveryDispatchClaimedAt',clock_timestamp(),'providerExecutionRelease',p_release) WHERE id=p_task RETURNING * INTO t;
 RETURN to_jsonb(t);
END $$;


CREATE OR REPLACE FUNCTION public.project_org_package_completion_limit(p_project uuid, p_key text, p_original integer)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 select coalesce((select (c.terms->>p_key)::int from project_package_checkpoint_continuations c where c.project_id=p_project and c.cutoff>clock_timestamp()),(select (s.terms->>p_key)::int
  from project_package_completion_receipts s
  join project_package_execution_receipts r on r.project_id=s.project_id
  join project_package_corrective_receipts root on root.receipt_id=s.root_authorization_id and root.ordinal=0
  where s.project_id=p_project and s.package_id=r.package_id and s.owner_id=r.owner_id
   and s.cutoff=r.cutoff and s.original_terms=r.terms and s.terms=project_org_package_completion_terms()
   and root.project_id=s.project_id and root.package_id=r.package_id and root.owner_id=r.owner_id
   and root.terms=r.terms and root.corrective_terms=project_org_package_corrective_terms()
   and s.cutoff>clock_timestamp()),p_original)
$function$;

CREATE OR REPLACE FUNCTION public.project_org_package_release_matches(p_project uuid, p_release text, p_generation bigint, p_deployment text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 select case when exists(select 1 from project_package_checkpoint_continuations c where c.project_id=p_project) then exists(select 1 from project_package_checkpoint_continuations c where c.project_id=p_project and c.release_sha=p_release and c.release_generation=p_generation and c.deployment_id=p_deployment) when exists(select 1 from project_package_corrective_receipts x where x.project_id=p_project) then exists(
 select 1 from (select x.* from project_package_corrective_receipts x where x.project_id=p_project order by ordinal desc limit 1) latest
 where latest.release_sha=p_release and latest.release_generation=p_generation and latest.deployment_id=p_deployment)
 else exists(select 1 from project_package_execution_receipts r
 left join project_package_execution_release_receipts s on s.project_id=r.project_id and s.prior_authorization_id=r.authorization_id and s.package_id=r.package_id and s.owner_id=r.owner_id
 where r.project_id=p_project and (
  (s.project_id is null and r.release_sha=p_release and r.release_generation=p_generation and r.deployment_id=p_deployment)
  or (s.project_id is not null and s.release_sha=p_release and s.release_generation=p_generation and s.deployment_id=p_deployment))) end
$function$;

CREATE OR REPLACE FUNCTION public.project_org_package_execution_live(p_project uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 select case when exists(select 1 from project_package_checkpoint_continuations where project_id=p_project) then project_org_package_checkpoint_live(p_project) else exists(select 1 from project_package_execution_receipts r join work_projects p on p.id=r.project_id
 join project_work_packages w on w.id=r.package_id and w.project_id=p.id
 join project_retest_production_release_gate g on g.project_id=p.id join project_provider_execution a on a.project_id=p.id
 where p.id=p_project and p.status='running' and p.phase='development' and p.milestone_index=0 and p.max_missions=project_org_package_completion_limit(p.id,'maxMissions',112) and p.max_cycles=project_org_package_completion_limit(p.id,'developmentAttempts',3)
 and p.approved_hash=r.scope_hash and p.approval_hash=r.scope_hash and a.approved_scope=r.scope_hash and a.owner_id=r.owner_id
 and p.deadline=r.cutoff and w.deadline=r.cutoff and a.deadline=r.cutoff and r.cutoff>clock_timestamp()
 and g.state='active' and project_org_package_release_matches(p.id,g.release_sha,g.generation,g.deployment_id) and g.alias_name='katie-mu.vercel.app'
 and p.token_allowance=600000 and project_provider_continued(p.id)
 and project_org_package_execution_fingerprint(w.id)=r.contract_fingerprint
 and (select count(*) from agent_missions where project_id=p.id and id=any(r.historical_mission_ids))=104
 and (select count(*) from agent_missions where project_id=p.id)<=project_org_package_completion_limit(p.id,'maxMissions',112)
 and (select count(*) from project_work_packages where project_id=p.id)=1
 and (select count(*) from project_work_package_attempts where package_id=w.id)<=project_org_package_completion_limit(p.id,'developmentAttempts',3)) end
$function$;

CREATE OR REPLACE FUNCTION public.project_org_package_execution_assignment(p_job uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 select exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
 join work_projects p on p.active_mission_id=m.id and p.id=m.project_id
 join project_package_execution_receipts r on r.project_id=p.id join project_work_packages w on w.id=r.package_id
 join project_organization_nodes n on n.id=case j.role when 'development' then w.worker_id when 'compose' then w.writer_id when 'review' then w.reviewer_id when 'work' then w.manager_id end
 where j.id=p_job and n.agent_id=j.agent_id and n.status in('active','accepted') and n.deadline>clock_timestamp()
 and m.status='running' and m.deadline>clock_timestamp() and not m.id=any(r.historical_mission_ids)
 and m.project_evidence->>'packageExecutionAuthorizationId'=r.authorization_id::text
 and project_org_package_execution_live(p.id) and project_provider_continued_assignment(j.id)
 and (not exists(select 1 from project_package_checkpoint_continuations where project_id=p.id) or exists(select 1 from project_package_checkpoint_continuations c where c.project_id=p.id and (m.id=c.mission_id or m.project_kind='management' and m.project_evidence->>'previousMissionId'=c.mission_id::text or m.project_kind='assessment' and m.project_evidence->>'checkpointRecoveryAuthorizationId'=c.authorization_id::text)))
 and ((m.project_kind='development' and w.status='running' and j.role in('development','compose','review')
   and exists(select 1 from project_work_package_attempts pa where pa.package_id=w.id and pa.mission_id=m.id and pa.attempt between 1 and project_org_package_completion_limit(p.id,'developmentAttempts',3)))
 or (m.project_kind='assessment' and p.phase='assessment' and w.status='accepted' and j.role in('compose','review') and exists(select 1 from project_package_checkpoint_continuations c where c.project_id=p.id and m.project_evidence->>'checkpointRecoveryAuthorizationId'=c.authorization_id::text and p.verified_sha=c.proof->>'candidateSha' and p.preview->'browserAcceptance'->>'passed'='true'))
 or (m.project_kind='management' and w.status in('review','rejected') and j.role='work'
   and m.project_evidence->>'organizationNodeId'=w.manager_id::text
   and exists(select 1 from project_work_package_attempts pa where pa.package_id=w.id and pa.mission_id::text=m.project_evidence->>'previousMissionId'))))
$function$;

CREATE OR REPLACE FUNCTION public.project_org_package_execution_request(p_job uuid, p_attempt text, p_operation text, p_scope text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare j mission_assignments; m agent_missions; r project_package_execution_receipts; n int;
begin
 select * into j from mission_assignments where id=p_job;
 select * into m from agent_missions where id=j.mission_id;
 select * into r from project_package_execution_receipts where project_id=m.project_id;
 if r.project_id is null or not project_org_package_execution_assignment(p_job) or project_provider_request_pending(r.project_id) then return false;end if;
 if (select count(*) from project_provider_requests q where q.project_id=r.project_id and q.operation='inference' and not q.mission_id=any(r.historical_mission_ids))>=project_org_package_completion_limit(r.project_id,'paidInferenceLimit',47) then return false;end if;
 if p_scope is null then
  if j.role not in('work','compose','review') or j.status<>'running' or j.lease::text is distinct from p_attempt or j.lease_until<=clock_timestamp()
  or p_operation not in('model-list','inference') or (exists(select 1 from project_provider_requests q where q.assignment_id=j.id and q.operation=p_operation) and not project_org_package_paid_retry_allowed(j.id,p_attempt,p_operation))
  or (p_operation='inference' and not exists(select 1 from project_provider_requests q where q.assignment_id=j.id and q.execution_attempt=p_attempt and q.operation='model-list' and q.resolved_at is not null)) then return false;end if;
  return true;
 end if;
 if j.role<>'development' or p_scope is distinct from r.scope_hash or p_operation not in('input-count','inference')
 or not (exists(select 1 from project_provider_dispatches where task_id=j.id and run_id=p_attempt)
 or exists(select 1 from project_package_checkpoint_dispatches where task_id=j.id and run_id=p_attempt)) then return false;end if;
 if exists(select 1 from project_package_checkpoint_continuations c where c.project_id=r.project_id) then
  if not exists(select 1 from project_package_checkpoint_continuations c where c.assignment_id=j.id
    and p_attempt<>c.proof->>'priorRunId' and project_org_package_checkpoint_dispatch_live(j.id,c.authorization_id,c.release_sha))
   or not exists(select 1 from project_package_checkpoint_dispatches d join project_package_checkpoint_continuations c on c.authorization_id=d.authorization_id where d.task_id=j.id and d.run_id=p_attempt and c.assignment_id=j.id)
   or (select count(*) from project_provider_requests q join mission_assignments x on x.id=q.assignment_id where q.project_id=r.project_id and q.operation='inference' and x.role='development')>=project_org_package_completion_limit(r.project_id,'nativeInferenceLimit',36)
  then return false;end if;
  select count(*) into n from project_provider_requests q where q.assignment_id=j.id and q.execution_attempt=p_attempt and q.operation=p_operation;
 else
  select count(*) into n from project_provider_requests q where q.assignment_id=j.id and q.operation=p_operation;
 end if;
 if n>=12 then return false;end if;
 if p_operation='inference' and (select count(*) from project_provider_requests q where q.assignment_id=j.id and q.execution_attempt=p_attempt and q.operation='input-count' and q.resolved_at is not null)<=n then return false;end if;
 return true;
end $function$;

CREATE OR REPLACE FUNCTION public.project_provider_dispatch_start(p_task uuid, p_scope text, p_run text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if not project_provider_dispatch_live(p_task,p_scope)
 or exists(select 1 from project_provider_requests q join agent_missions m on m.project_id=q.project_id
  join mission_assignments j on j.mission_id=m.id where j.id=p_task and q.resolved_at is null)
 or not exists(select 1 from agent_tasks where id=p_task and external->>'attempted'='true') then return false;end if;
 if exists(select 1 from project_package_checkpoint_continuations c where c.assignment_id=p_task) then
 if not exists(select 1 from project_package_checkpoint_continuations c where c.assignment_id=p_task and p_run~'^[0-9]+$' and p_run<>c.proof->>'priorRunId' and project_org_package_checkpoint_dispatch_live(p_task,c.authorization_id,c.release_sha))
 or (select count(*) from project_provider_dispatches where task_id=p_task)<>1 then return false;end if;
 insert into project_package_checkpoint_dispatches(authorization_id,task_id,run_id)
 select authorization_id,p_task,p_run from project_package_checkpoint_continuations where assignment_id=p_task on conflict do nothing;
 return found;
 end if;
 insert into project_provider_dispatches(task_id,run_id) values(p_task,p_run) on conflict do nothing;
 return found;
end $function$;

CREATE OR REPLACE FUNCTION public.project_org_package_execution_schedule(p_project uuid, p_lease uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare p work_projects; r project_package_execution_receipts; w project_work_packages; m agent_missions; schedule_result jsonb; attempts int; mgmt int;
begin
 select * into p from work_projects where id=p_project and status='running' and lease=p_lease and p_lease is not null and lease_until>now();
 if p.id is null then raise exception 'Project lease required';end if;
 select * into r from project_package_execution_receipts where project_id=p.id;
 select * into w from project_work_packages where id=r.package_id;
 if not project_org_package_execution_live(p.id) then return jsonb_build_object('blocked','Package execution authorization expired or changed');end if;
 if project_provider_request_pending(p.id) then return jsonb_build_object('waiting',true,'detail','Awaiting existing provider settlement');end if;
 if exists(select 1 from project_package_checkpoint_continuations where project_id=p.id) then
  if p.phase in('delivery','browser_check','assessment') then return null;end if;
  if p.active_mission_id is null or w.status in('rejected','repair','queued') then return jsonb_build_object('blocked','Checkpoint continuation cannot regenerate or repair the accepted source');end if;
  if exists(select 1 from agent_missions m0 where m0.id=p.active_mission_id and m0.status in('blocked','failed','stopped')) then return jsonb_build_object('blocked','Final-review continuation failed; no automatic retry or regeneration');end if;
 end if;
 select count(*) into attempts from project_work_package_attempts where package_id=w.id;
 select count(*) into mgmt from agent_missions where project_id=p.id and project_kind='management' and not id=any(r.historical_mission_ids);
 if p.active_mission_id is null then
  if w.status='queued' and attempts<project_org_package_completion_limit(p.id,'developmentAttempts',3) and (select count(*) from agent_missions where project_id=p.id)<p.max_missions then return null;end if;
  return jsonb_build_object('blocked','No further authorized package attempt');
 end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id;
 if m.project_evidence->>'packageExecutionAuthorizationId' is distinct from r.authorization_id::text then raise exception 'Unexpected active package mission';end if;
 if m.project_kind='management' then
  if m.status in('blocked','failed','stopped') then return jsonb_build_object('blocked','Package management failed; no automatic retry');end if;
  return jsonb_build_object('waiting',true);
 end if;
 if m.project_kind<>'development' or not exists(select 1 from project_work_package_attempts where package_id=w.id and mission_id=m.id) then raise exception 'Unexpected package attempt';end if;
 if w.status='accepted' then return null;end if;
 if m.status not in('completed','blocked','stopped','failed') then return null;end if;
 if w.status='rejected' and attempts>=project_org_package_completion_limit(p.id,'developmentAttempts',3) then return jsonb_build_object('blocked','Authorized package correction attempts exhausted');end if;
 if w.status<>'repair' and (mgmt>=project_org_package_completion_limit(p.id,'managerMissions',5) or (select count(*) from agent_missions where project_id=p.id)>=p.max_missions) then return jsonb_build_object('blocked','Authorized package management capacity exhausted');end if;
 schedule_result:=project_org_schedule_before_exception_recovery(p_project,p_lease);
 if schedule_result->>'missionId' is not null then
  update agent_missions mm set project_evidence=mm.project_evidence||jsonb_build_object('packageExecutionAuthorizationId',r.authorization_id)
   where mm.id::text=schedule_result->>'missionId' and mm.project_id=p.id and mm.project_kind='management'
   and mm.project_evidence->>'organizationNodeId'=w.manager_id::text and mm.project_evidence->>'previousMissionId'=m.id::text
   and not mm.id=any(r.historical_mission_ids);
  if not found then raise exception 'Scheduler attempted work outside exact package management';end if;
 end if;
 return coalesce(schedule_result,jsonb_build_object('blocked','Package manager decision unavailable'));
end $function$;

CREATE OR REPLACE FUNCTION public.project_org_package_corrective_gate_allowed(p_project uuid, p_action text, p_release text, p_deployment text, p_generation bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare g project_retest_production_release_gate; prev project_package_execution_release_receipts; last_receipt project_package_corrective_receipts;
 old_release text; old_deployment text; old_generation bigint;
begin
 if project_org_package_checkpoint_snapshot(p_project) is not null then
  select * into g from project_retest_production_release_gate where project_id=p_project;
  if g.generation=p_generation and g.release_sha='dee56dfec88a87e3f026604ff9e208fd41a860b1' and g.deployment_id='dpl_7Ui6Bfdkr5S4BmqcrmVAAphbGfvh' then
   return (p_action='closed' and g.state='active' and g.generation=69 and p_release=g.release_sha and p_deployment=g.deployment_id)
    or (p_action='active' and g.state='closed' and g.generation=70 and p_release<>g.release_sha and p_deployment<>g.deployment_id);
  end if;
 end if;
 if project_org_package_pending_retry_handoff_allowed(p_project,p_action,p_release,p_deployment,p_generation) then return true;end if;
 if project_org_package_corrective_checkpoint(p_project) is null and project_org_package_completion_checkpoint(p_project) is null then return false;end if;
 select * into g from project_retest_production_release_gate where project_id=p_project;
 select * into prev from project_package_execution_release_receipts where project_id=p_project;
 select * into last_receipt from project_package_corrective_receipts where project_id=p_project order by ordinal desc limit 1;
 if last_receipt.project_id is not null and last_receipt.ordinal>=6 then return false;end if;
 old_release:=coalesce(last_receipt.release_sha,prev.release_sha);
 old_deployment:=coalesce(last_receipt.deployment_id,prev.deployment_id);
 old_generation:=coalesce(last_receipt.release_generation,prev.release_generation);
 if g.generation is distinct from p_generation or g.release_sha is distinct from old_release or g.deployment_id is distinct from old_deployment then return false;end if;
 return (p_action='closed' and g.state='active' and g.generation=old_generation and p_release=old_release and p_deployment=old_deployment)
 or (p_action='active' and g.state='closed' and g.generation=old_generation+1 and p_release<>old_release and p_deployment<>old_deployment);
end $function$;

CREATE OR REPLACE FUNCTION public.finish_work_project_lifecycle(p_id uuid, p_lease uuid, p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$ declare p work_projects;mid uuid;kind text;seq integer;contract jsonb;binding jsonb;dev uuid;lead uuid;reviewer uuid;goal text;scope_data jsonb;wp project_work_packages;agents uuid[];begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));select * into p from work_projects where id=p_id for update;
 if not found or p.status<>'running' or p.lease is distinct from p_lease or p.lease_until<=now() or p.deadline<=now() then return false;end if;
 if exists(select 1 from project_package_checkpoint_continuations where project_id=p.id) then
  if p_action in('child','advance','preview','browser','complete') and not project_org_package_checkpoint_live(p.id) then raise exception 'Live checkpoint authority required';end if;
  if p_action='retry' then raise exception 'No regeneration or repair authorized by checkpoint continuation';end if;
  if p_action='advance' and not exists(select 1 from project_package_checkpoint_continuations c where c.project_id=p.id and c.mission_id=p.active_mission_id and c.proof->>'candidateSha'=p_data->>'head') then raise exception 'Exact retained candidate required';end if;
 end if;
 if p_action='child' then
  if exists(select 1 from project_package_checkpoint_continuations where project_id=p.id) then
   if p.phase<>'assessment' or p_data->>'kind' is distinct from 'assessment' or p.preview->'browserAcceptance'->>'passed' is distinct from 'true' or p.preview->>'headSha' is distinct from p.verified_sha
   or (select count(*) from agent_missions where project_id=p.id)>=p.max_missions
   or exists(select 1 from agent_missions m0 join project_package_checkpoint_continuations c on c.project_id=m0.project_id where c.project_id=p.id and m0.project_kind='assessment' and m0.created_at>=c.authorized_at)
   then raise exception 'Only one independent assessment of the deployed retained candidate is authorized';end if;
   p_data:=p_data||jsonb_build_object('evidence',coalesce(p_data->'evidence','{}'::jsonb)||jsonb_build_object('packageExecutionAuthorizationId',(select authorization_id from project_package_execution_receipts where project_id=p.id),'checkpointRecoveryAuthorizationId',(select authorization_id from project_package_checkpoint_continuations where project_id=p.id)));
  elsif project_org_package_execution_required(p.id) then
   if not project_org_package_execution_live(p.id) or p_data->>'kind' is distinct from 'development'
   or (select count(*) from agent_missions where project_id=p.id)>=p.max_missions
   or not exists(select 1 from project_package_execution_receipts rr join project_work_packages ww on ww.id=rr.package_id where rr.project_id=p.id and ww.status='queued'
    and (select count(*) from project_work_package_attempts where package_id=ww.id)<project_org_package_completion_limit(p.id,'developmentAttempts',3))
   then raise exception 'Exact package execution authority required';end if;
   p_data:=p_data||jsonb_build_object('evidence',coalesce(p_data->'evidence','{}'::jsonb)||jsonb_build_object('packageExecutionAuthorizationId',(select authorization_id from project_package_execution_receipts where project_id=p.id)));
  end if;
  if p.active_mission_id is not null then raise exception 'A milestone is already bound';end if;
  seq:=(select count(*)+1 from project_runs where project_id=p.id);if seq>p.max_missions then update work_projects set status='blocked',detail='Project milestone allowance exhausted.' where id=p.id;else
   kind:=p_data->>'kind';goal:=p_data->>'objective';if kind is distinct from p.phase or kind not in ('research','specification','development','assessment') or length(goal) not between 1 and 12000 then raise exception 'Invalid project milestone';end if;
   if kind='development' and (p.approved_hash is distinct from p.approval_hash or p.approved_hash is null or p.cycles>=p.max_cycles or p.phase<>'development') then raise exception 'Approved coding allowance required';end if;
   agents:=p.team;
   if kind='assessment' and exists(select 1 from project_package_checkpoint_continuations where project_id=p.id) then
    select array[(select agent_id from project_organization_nodes where id=w.writer_id),(select agent_id from project_organization_nodes where id=w.reviewer_id)] into agents from project_work_packages w join project_package_checkpoint_continuations c on c.package_id=w.id where c.project_id=p.id;
    if cardinality(agents)<>2 or agents[1] is null or agents[2] is null or agents[1]=agents[2] then raise exception 'Independent assessment workers required';end if;
   end if;
   if kind='development' and p.organization_version=1 then
    select * into wp from project_work_packages where project_id=p.id and milestone_index=p.milestone_index and status='queued' and scope_hash=p.approved_hash;
    if wp.id is null or wp.deadline<=now() or not exists(select 1 from project_organization_nodes org where id=wp.manager_id and org.kind='manager' and status='active')
    or exists(select 1 from project_work_package_dependencies d join project_work_packages x on x.id=d.depends_on where d.package_id=wp.id and x.status<>'accepted')
    then raise exception 'Director-commissioned executable package required';end if;
    if exists(select 1 from project_organization_nodes org where id in(wp.worker_id,wp.writer_id,wp.reviewer_id) and (parent_id<>wp.manager_id or org.kind<>'worker' or status not in ('active','accepted'))) then raise exception 'Package reporting authority changed';end if;
    agents:=array[(select agent_id from project_organization_nodes where id=wp.writer_id),(select agent_id from project_organization_nodes where id=wp.reviewer_id),(select agent_id from project_organization_nodes where id=wp.worker_id)];
    goal:=goal||E'\nDIRECTOR WORK PACKAGE (within approved milestone):\n'||wp.contract::text;
    if length(goal)>12000 then raise exception 'Work package exceeds bounded mission context';end if;
   end if;
   mid:=gen_random_uuid();
   if wp.id is not null and project_org_package_execution_required(p.id) then
    -- Deduplicate only the mission team. Preserve all three role positions.
    perform create_mission(mid,goal,ARRAY(SELECT x FROM unnest(agents) WITH ORDINALITY q(x,i) GROUP BY x ORDER BY min(i)),120,p.repository_id);
   else perform create_mission(mid,goal,agents,120,case when kind='development' then p.repository_id else null end);end if;
   if wp.id is not null then
    insert into project_work_package_attempts values(wp.id,(select count(*)+1 from project_work_package_attempts where package_id=wp.id),mid,coalesce(p.verified_sha,p.baseline_sha));
    update project_work_packages set status='running' where id=wp.id;
   end if;
   if length(coalesce((p_data->'evidence')::text,''))>30000 then raise exception 'Project evidence exceeds bounded context; narrow the acceptance package without dropping original requirements';end if;
   update agent_missions set token_allowance=case when project_provider_mode(p.id) then token_allowance else least(120000,p.token_allowance,coalesce(wp.token_limit-(project_package_usage(wp.id)->>'tokens')::bigint,120000))::int end,project_id=p.id,project_kind=kind,project_evidence=p_data->'evidence' where id=mid;update agent_missions m set project_evidence=coalesce(m.project_evidence,'{}'::jsonb)||
   jsonb_build_object('providerContinuationDecision',a.continuation_decision_id,'providerContinuationRelease',a.continuation_release_sha,'providerContinuationWindow',a.window_id)
   from project_provider_execution a where m.id=mid and m.project_id=p.id and a.project_id=p.id and project_provider_continued(p.id);
  perform control_mission(mid,'start');
   if kind='development' then
    contract:=p.spec->'milestones'->p.milestone_index->'contract';if contract is null then raise exception 'Approved milestone contract missing';end if;
    binding:=jsonb_build_object('version',1,'projectId',p.id,'baseSha',coalesce(p.verified_sha,p.baseline_sha),'baselineSha',p.baseline_sha,'allowedPaths',case when wp.id is null then p.spec->'allowedPaths' else (select sc.contract->'paths' from project_worker_contracts sc where sc.package_id=wp.id and sc.role='development') end,'contractHash',encode(sha256(convert_to(project_canonical(contract),'UTF8')),'hex'),'contract',contract,'scopeHash',p.approved_hash);
    if wp.id is not null then binding:=binding||jsonb_build_object('cumulativePaths',p.spec->'allowedPaths');end if;
    update agent_missions set deadline=least(p.deadline,coalesce(wp.deadline,p.deadline)) where id=mid;
    update mission_assignments set status='completed',result='{"output":"Server-owned approved project milestone; no planning inference was claimed."}' where mission_id=mid and job_key='plan';
    lead:=agents[1];reviewer:=agents[2];dev:=agents[3];
    insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload) values(mid,'implement','development',dev,'Implement the approved milestone in the full mission objective. Preserve all previous verified work. Run focused checks and satisfy the approved browser contract. Deliver an isolated draft PR only.','{}','{"capability":"development"}'),(mid,'compose','compose',lead,'Report the actual verified milestone result, draft PR, immutable commit and browser checks concisely. Do not reconstruct code or invent actions.',array['implement'],'{}'),(mid,'review','review',reviewer,'Verify the actual approved milestone against its original scope and immutable external evidence.',array['compose'],'{}');
    if wp.id is not null then update mission_assignments j set instruction=c.contract->>'instruction' from project_worker_contracts c where c.package_id=wp.id and c.role=j.role and j.mission_id=mid;end if;
    update work_projects set cycles=cycles+1 where id=p.id;
   elsif kind='assessment' and exists(select 1 from project_package_checkpoint_continuations where project_id=p.id) then
    update agent_missions set deadline=least(deadline,p.deadline) where id=mid;
    update mission_assignments set status='completed',result='{"output":"Server-owned assessment plan: independently verify the deployed retained candidate against the existing approved final contract."}' where mission_id=mid and job_key='plan';
    insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload)
     select mid,c.role,c.role,case c.role when 'compose' then agents[1] else agents[2] end,c.contract->>'instruction',case c.role when 'compose' then array['plan'] else array['compose'] end,'{}'::jsonb
     from project_worker_contracts c join project_package_checkpoint_continuations r on r.package_id=c.package_id where r.project_id=p.id and c.role in('compose','review');
   end if;
   insert into project_runs(project_id,mission_id,kind,ordinal,milestone_index,binding) values(p.id,mid,kind,seq,p.milestone_index,binding);
   update work_projects set active_mission_id=mid,detail='Working on '||kind||' milestone.',updated_at=now() where id=p.id;
  end if;
 elsif p_action='spec' then
  if p.verified_sha is not null and p_data->>'baseline' is distinct from p.baseline_sha then raise exception 'Verified cumulative project baseline cannot be replaced by current main';end if;
  if p.phase<>'approval' and not exists(select 1 from agent_missions where id=p.active_mission_id and status='completed') then raise exception 'Reviewed specification required';end if;
  if p.approved_hash is not null then raise exception 'Approved specification is immutable';end if;
  update project_runs set outcome=jsonb_build_object('specification_reviewed',true) where mission_id=p.active_mission_id and outcome is null;
  scope_data:=jsonb_build_object('objective',p.objective,'clarifications',p.clarifications,'spec',p_data->'spec','repository',p.repository_id,'repository_name',(select repository_full_name from repo_sync_runs where id=p.repository_id),'baseline',p_data->>'baseline','max_cycles',p.max_cycles,'max_missions',p.max_missions,'token_allowance',p.token_allowance,'deadline',p.deadline);
  if project_provider_mode(p.id) then scope_data:=scope_data-'token_allowance';end if;
  update work_projects set spec=p_data->'spec',repository_full_name=(select repository_full_name from repo_sync_runs where id=p.repository_id),baseline_sha=p_data->>'baseline',approval_hash=encode(sha256(convert_to(project_canonical(scope_data),'UTF8')),'hex'),active_mission_id=null,status=case when repository_id is null then 'awaiting_input' else 'awaiting_approval' end,phase='approval',detail=p_data->>'detail' where id=p.id;
 elsif p_action='advance' then
  if p.organization_version=1 and p.phase='development' and not exists(select 1 from project_work_packages w join project_work_package_attempts a on a.package_id=w.id join mission_assignments j on j.mission_id=a.mission_id and j.role='development' where a.mission_id=p.active_mission_id and w.status='accepted' and w.evidence->>'head'=p_data->>'head' and w.evidence->>'assignmentId'=j.id::text and w.evidence->'result'=j.result) then raise exception 'Responsible director acceptance required before progression';end if;
  if not exists(select 1 from agent_missions where id=p.active_mission_id and status='completed') then raise exception 'Reviewed milestone completion required';end if;
  update project_runs set outcome=case when outcome is not null then p_data||jsonb_build_object('priorRecoveryOutcome',outcome) else p_data end where mission_id=p.active_mission_id and (outcome is null or exists(select 1 from project_package_checkpoint_continuations c where c.project_id=p.id and c.mission_id=p.active_mission_id));
  if p.phase='development' then
   if p_data->>'head'!~'^[a-f0-9]{40}$' or not exists(
    select 1 from mission_assignments j join project_runs r on r.mission_id=j.mission_id where j.mission_id=p.active_mission_id and j.role='development' and j.status='completed'
    and r.binding->>'scopeHash'=p.approved_hash and j.result->'verification'->>'testedHeadSha'=p_data->>'head' and j.result->'verification'->>'reviewedHeadSha'=p_data->>'head'
    and j.result->'verification'->>'observedHeadSha'=p_data->>'head'
    and j.result->'verification'->'projectAcceptance'->>'passed'='true'
    and j.result->'verification'->'projectAcceptance'->>'headSha'=p_data->>'head'
    and j.result->'verification'->'projectAcceptance'->>'contractHash'=r.binding->>'contractHash'
    and j.result->'verification'->'projectAcceptance'->>'projectId'=p.id::text
   ) then raise exception 'Immutable reviewed head and approved browser evidence required';end if;
   update work_projects set status=case when project_org_package_execution_required(p.id) and not exists(select 1 from project_package_checkpoint_continuations where project_id=p.id) then 'paused' else status end,verified_sha=p_data->>'head',milestone_index=milestone_index+1,phase=case when milestone_index+1>=jsonb_array_length(spec->'milestones') then 'delivery' else 'development' end,active_mission_id=null,detail='Verified coding increment saved.' where id=p.id;
  elsif p.phase='research' then update work_projects set phase='specification',active_mission_id=null,detail='Research reviewed. Developing the specification.' where id=p.id;
  else raise exception 'Unsupported milestone progression';end if;
 elsif p_action='preview' then
  if p.phase not in ('delivery','assessment') or p_data->>'immutable' is distinct from 'true' or p_data->>'headSha' is distinct from p.verified_sha or not exists(select 1 from project_runs r join agent_missions m on m.id=r.mission_id where r.project_id=p.id and r.kind='development' and m.status='completed' and r.outcome->>'head'=p.verified_sha) then raise exception 'Verified integrated preview required';end if;
  if p.active_mission_id is not null then update project_runs set outcome=jsonb_build_object('superseded',true,'reason','Deployment changed after assessment') where mission_id=p.active_mission_id and outcome is null;end if;
  update work_projects set preview=p_data,phase='browser_check',active_mission_id=null,detail='Same-head deployment found. Running the approved contract against the actual deployed application.' where id=p.id;
 elsif p_action='browser' then
  if p.phase<>'browser_check' or p.preview->>'immutable' is distinct from 'true' or p_data->>'passed' is distinct from 'true' or p_data->>'projectId' is distinct from p.id::text or p_data->>'headSha' is distinct from p.verified_sha or p_data->>'deploymentId' is distinct from p.preview->>'deploymentId' or p_data->>'statusId' is distinct from p.preview->>'statusId' or p_data->>'url' is distinct from p.preview->>'url' or p_data->>'contractHash' is distinct from encode(sha256(convert_to(project_canonical(p.spec->'finalContract'),'UTF8')),'hex') or jsonb_array_length(p_data->'checks') is distinct from jsonb_array_length(p.spec->'finalContract'->'scenarios') or exists(select 1 from jsonb_array_elements(p_data->'checks') with ordinality c(v,n) where c.v->>'passed' is distinct from 'true' or c.v->>'name' is distinct from p.spec->'finalContract'->'scenarios'->(c.n::int-1)->>'name') then raise exception 'Actual deployment-bound final browser acceptance required';end if;
  update work_projects set preview=preview||jsonb_build_object('browserAcceptance',p_data),phase='assessment',detail='Actual deployed browser contract passed. Performing independent whole-project assessment.' where id=p.id;
 elsif p_action='complete' then
  if p.phase<>'assessment' or p.preview->>'immutable' is distinct from 'true' or p.preview->'browserAcceptance'->>'passed' is distinct from 'true' or p.preview->'browserAcceptance'->>'headSha' is distinct from p.verified_sha or p.preview->'browserAcceptance'->>'deploymentId' is distinct from p.preview->>'deploymentId' or p.preview->'browserAcceptance'->>'statusId' is distinct from p.preview->>'statusId' or p.preview->>'headSha' is distinct from p.verified_sha or not exists(select 1 from agent_missions where id=p.active_mission_id and status='completed' and length(result)>0) or exists(select 1 from project_runs r join agent_missions m on m.id=r.mission_id where r.project_id=p.id and r.kind='development' and r.outcome is null and m.status<>'blocked') then raise exception 'Independent integrated project assessment required';end if;
  update project_runs set outcome=p_data where mission_id=p.active_mission_id;update work_projects set status='completed',result=p_data->>'result',detail='Integrated result independently approved and delivered to the original chat.' where id=p.id;
 elsif p_action in ('block','input','retry','wait','error') then
  if p_action='retry' then
   if p.organization_version=1 then
    update project_work_packages w set status='queued' from project_work_package_attempts a where a.package_id=w.id and a.mission_id=p.active_mission_id and w.status='repair';
    if not found then raise exception 'Responsible director must authorize bounded repair';end if;
   end if;
   if p.cycles>=p.max_cycles then update work_projects set status='blocked',detail='Project coding-cycle allowance exhausted.' where id=p.id;else
    update project_runs set outcome=p_data where mission_id=p.active_mission_id and outcome is null;
    update work_projects set phase='development',milestone_index=least(milestone_index,jsonb_array_length(spec->'milestones')-1),active_mission_id=null,detail=p_data->>'detail' where id=p.id;
   end if;
  elsif p_action='error' then update work_projects set failures=failures+1,status=case when failures>=2 then 'blocked' else status end,detail=p_data->>'detail' where id=p.id;
  elsif p_action='input' then update work_projects set status='awaiting_input',detail=p_data->>'detail' where id=p.id;
  elsif p_action='block' then update work_projects set status='blocked',detail=p_data->>'detail' where id=p.id;
  else update work_projects set detail=coalesce(p_data->>'detail',detail) where id=p.id;end if;
 else raise exception 'Unknown project outcome';end if;
 insert into project_events(project_id,event,data) values(p.id,p_action,p_data);
 update work_projects set lease=null,lease_until=null,failures=case when p_action='error' then failures else 0 end,updated_at=now() where id=p.id;
 select * into strict p from work_projects where id=p.id;
 if p.status='awaiting_approval' and p.spec is not null then perform project_publish(p.id,project_scope_proposal(p.id));elsif p_action<>'wait' or p.status<>'running' then perform project_publish(p.id,coalesce(p.result,p.detail,p.status));end if;
 return true;
end $function$;

CREATE OR REPLACE FUNCTION public.project_smart_admit(p_job uuid, p_tokens bigint DEFAULT 0)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare j mission_assignments;m agent_missions;p work_projects;c project_worker_contracts;w project_organization_nodes;a managed_agents;used bigint;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_job;select * into m from agent_missions where id=j.mission_id;
 select * into p from work_projects where id=m.project_id;
 if p.id is null or p.organization_version<>1 or m.project_kind='management' then return;end if;
 select x.* into c from project_worker_contracts x where x.id=(select contract_id from project_worker_admissions where assignment_id=j.id);
 if c.id is null then
 if j.payload ?| array['development_input','reviewModelCheckpoint'] then raise exception 'Preseeded SMART execution metadata is forbidden';end if;
 select x.* into c from project_worker_contracts x left join project_work_package_attempts t on t.package_id=x.package_id
 left join project_organization_work ow on ow.id=x.work_id where x.role=j.role and (t.mission_id=m.id or ow.mission_id=m.id or x.target_assignment=j.id or (m.project_kind='assessment' and j.role in('compose','review') and exists(select 1 from project_package_checkpoint_continuations r where r.project_id=p.id and r.package_id=x.package_id and m.project_evidence->>'checkpointRecoveryAuthorizationId'=r.authorization_id::text and project_org_package_execution_assignment(j.id))));
 if c.id is null then raise exception 'Immediate manager SMART admission required before worker execution';end if;
 if (select count(*) from project_worker_admissions where contract_id=c.id)>=(case when c.package_id=(select s.package_id from project_package_completion_receipts s where s.project_id=p.id) then project_org_package_completion_limit(p.id,'developmentAttempts',c.max_assignments) else c.max_assignments end) then raise exception 'SMART assignment capacity exhausted';end if;
 if (case when j.role='development' then 'development' when j.role in ('plan','compose','review','revise') then 'analysis' else case when j.payload->>'capability'='writing' then 'analysis' else j.payload->>'capability' end end) is distinct from (case when c.role='development' then 'development' when c.role in ('plan','compose','review','revise') then 'analysis' else case when c.contract->>'capability'='writing' then 'analysis' else c.contract->>'capability' end end) then raise exception 'SMART runtime capability mismatch';end if;
 if j.instruction is distinct from c.contract->>'instruction' then raise exception 'Worker instruction differs from SMART contract';end if;
 insert into project_worker_admissions values(j.id,c.id,project_smart_fingerprint(j),now());
 end if;
 select * into w from project_organization_nodes where id=c.worker_id;select * into a from managed_agents where id=w.agent_id;
 if not coalesce((case when j.role='development' then 'development' when j.role in ('plan','compose','review','revise') then 'analysis' when j.payload->>'capability'='writing' then 'analysis' else j.payload->>'capability' end)=any(w.tools),false) then raise exception 'Current delegated worker capability required';end if;
 if c.project_id is distinct from p.id or w.agent_id is distinct from j.agent_id or w.kind<>'worker' or w.parent_id is distinct from c.manager_id
 or w.status not in ('active','accepted') or c.scope_hash is distinct from p.approved_hash
 or c.agent_version is distinct from a.version or c.deadline<=now() or w.deadline<=now()
 or (c.contract->'estimate'->>'seconds')::bigint>extract(epoch from least(c.deadline,w.deadline,p.deadline)-now())
 or c.parent_hash is distinct from (select encode(sha256(convert_to(objective,'UTF8')),'hex') from project_organization_nodes where id=c.manager_id and kind='manager' and status in ('active','accepted'))
 or (select fingerprint from project_worker_admissions where assignment_id=j.id) is distinct from project_smart_fingerprint(j)
 then raise exception 'SMART authority changed or expired';end if;
 if project_provider_mode(p.id) then return;end if;
 select coalesce(sum(tokens),0) into used from (
 select greatest(mc.reserved_tokens,coalesce(mc.actual_tokens,0)) tokens from mission_calls mc join project_worker_admissions b on b.assignment_id=mc.job_id where b.contract_id=c.id
 union all select greatest(bc.reserved_tokens,coalesce(bc.actual_tokens,0)) from benchmark_budget_calls bc join benchmark_budget_accounts ba on ba.id=bc.account_id join project_worker_admissions b on b.assignment_id=ba.developer_task_id where b.contract_id=c.id and bc.legacy_mission_call_id is null) usage;
 if used+p_tokens>c.token_limit then raise exception 'SMART cumulative token authority exhausted';end if;
end $function$;

CREATE OR REPLACE FUNCTION public.project_org_package_execution_commands(p_job uuid, p_lease uuid, p_commands jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare w project_work_packages; r project_package_execution_receipts; m agent_missions; j mission_assignments;
 expected_action text; saved jsonb; inference_count int;
begin
 select * into j from mission_assignments where id=p_job;
 select * into m from agent_missions where id=j.mission_id;
 select * into r from project_package_execution_receipts where project_id=m.project_id;
 select * into w from project_work_packages where id=r.package_id;
 if not project_org_package_execution_assignment(p_job) or j.role<>'work' or m.project_kind<>'management'
 or p_lease is null or j.lease is distinct from p_lease or j.lease_until<=clock_timestamp() or j.status<>'running'
 then raise exception 'Exact live package manager lease required';end if;
 if jsonb_typeof(p_commands) is distinct from 'array' or jsonb_array_length(p_commands) not between 1 and 2
 then raise exception 'Package decision requires one applicable command and at most one ready';end if;
 select count(*) into inference_count from project_provider_requests q where q.assignment_id=j.id and q.operation='inference' and q.resolved_at is not null and q.provider_receipt is not null;
 if project_provider_request_pending(r.project_id) or inference_count<>m.calls or inference_count<1 or ((inference_count>2
 or (inference_count=2 and not exists(select 1 from project_package_completion_receipts s where s.project_id=r.project_id and s.failed_assignment_id=j.id and s.failed_mission_id=m.id)))
 and not project_org_package_invalid_retry_settlement_allowed(j.id,inference_count))
 then raise exception 'Exact settled package inference count required';end if;
 saved:=project_org_package_response_commands(p_job,p_lease);
 if p_commands is distinct from saved then raise exception 'Decision must equal the immutable captured provider command batch';end if;
 if exists(select 1 from project_package_checkpoint_continuations where project_id=r.project_id) and w.status<>'review' then raise exception 'Checkpoint continuation permits evaluation only';end if;
 expected_action:=case w.status when 'review' then 'evaluate_package' when 'rejected' then 'repair_package' end;
 if expected_action is null or (select count(*) from jsonb_array_elements(p_commands) c where c->>'action'=expected_action)<>1
 or exists(select 1 from jsonb_array_elements(p_commands) c where c->>'action' is distinct from 'ready' and (c->>'action' is distinct from expected_action or c->>'packageId' is distinct from w.id::text))
 or (expected_action='repair_package' and (select count(*) from project_work_package_attempts where package_id=w.id)>=project_org_package_completion_limit(r.project_id,'developmentAttempts',3))
 then raise exception 'Only evaluation or bounded correction of the existing package is authorized';end if;
end $function$;

REVOKE ALL ON FUNCTION public.project_org_package_checkpoint_terms() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_org_package_checkpoint_terms() TO service_role;

REVOKE ALL ON FUNCTION public.project_org_package_checkpoint_snapshot(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_org_package_checkpoint_snapshot(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.project_org_package_checkpoint_offer(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_org_package_checkpoint_offer(uuid,uuid,text) TO service_role;

REVOKE ALL ON FUNCTION public.project_org_package_checkpoint_authorize(uuid,uuid,uuid,text,bigint,text,uuid,text,jsonb,timestamptz,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_org_package_checkpoint_authorize(uuid,uuid,uuid,text,bigint,text,uuid,text,jsonb,timestamptz,boolean) TO service_role;

REVOKE ALL ON FUNCTION public.project_org_package_checkpoint_live(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_org_package_checkpoint_live(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.project_org_package_checkpoint_dispatch_live(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_org_package_checkpoint_dispatch_live(uuid,uuid,text) TO service_role;

REVOKE ALL ON FUNCTION public.project_org_package_checkpoint_dispatch_offer(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_org_package_checkpoint_dispatch_offer(uuid,uuid,text) TO service_role;

REVOKE ALL ON FUNCTION public.project_org_package_checkpoint_claim_dispatch(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_org_package_checkpoint_claim_dispatch(uuid,uuid,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.project_org_coding_capacity_resource_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF OLD.id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
 AND ((OLD.max_missions=96 AND (SELECT count(*) FROM agent_missions WHERE project_id=OLD.id)>=96)
   OR EXISTS(SELECT 1 FROM project_coding_capacity_receipts WHERE project_id=OLD.id))
 AND (NEW.max_missions IS DISTINCT FROM OLD.max_missions OR NEW.token_allowance IS DISTINCT FROM OLD.token_allowance OR NEW.deadline IS DISTINCT FROM OLD.deadline)
 AND NOT (OLD.max_missions=96 AND OLD.status='blocked' AND OLD.detail='Approved project mission limit reached'
  AND NEW.token_allowance=OLD.token_allowance AND NEW.deadline=OLD.deadline
  AND EXISTS(SELECT 1 FROM project_coding_capacity_receipts r WHERE r.project_id=OLD.id AND NEW.max_missions=r.approved_max_missions))
 AND NOT (OLD.max_missions=100 AND NEW.max_missions=101 AND OLD.status='blocked'
  AND NEW.token_allowance=OLD.token_allowance AND NEW.deadline=OLD.deadline
  AND EXISTS(SELECT 1 FROM project_coding_capacity_resume_receipts s WHERE s.project_id=OLD.id
   AND s.authorization_txid=txid_current() AND s.source_mission_id=OLD.active_mission_id
   AND s.prior_max_missions=OLD.max_missions AND s.approved_max_missions=NEW.max_missions))
 AND NOT (OLD.max_missions=101 AND NEW.max_missions=102 AND OLD.status='blocked'
  AND NEW.token_allowance=OLD.token_allowance AND NEW.deadline=OLD.deadline
  AND EXISTS(SELECT 1 FROM project_coding_capacity_resume_receipts s WHERE s.project_id=OLD.id
   AND s.historical_missions=99 AND s.authorization_txid=txid_current() AND s.source_mission_id=OLD.active_mission_id
   AND s.prior_max_missions=OLD.max_missions AND s.approved_max_missions=NEW.max_missions))
 AND NOT (OLD.max_missions=102 AND NEW.max_missions=103 AND OLD.status='blocked'
  AND NEW.token_allowance=OLD.token_allowance AND NEW.deadline=OLD.deadline
  AND EXISTS(SELECT 1 FROM project_coding_capacity_resume_receipts s WHERE s.project_id=OLD.id
   AND s.historical_missions=102 AND s.authorization_txid=txid_current() AND s.source_mission_id=OLD.active_mission_id
   AND s.prior_max_missions=OLD.max_missions AND s.approved_max_missions=NEW.max_missions))
 AND NOT (OLD.max_missions=103 AND NEW.max_missions=104 AND OLD.status='blocked'
  AND NEW.token_allowance=OLD.token_allowance AND NEW.deadline=OLD.deadline
  AND EXISTS(SELECT 1 FROM project_coding_capacity_resume_receipts s WHERE s.project_id=OLD.id
   AND s.historical_missions=103 AND s.authorization_txid=txid_current() AND s.source_mission_id=OLD.active_mission_id
   AND s.prior_max_missions=OLD.max_missions AND s.approved_max_missions=NEW.max_missions))
 AND NOT (OLD.status='paused' AND OLD.max_missions=104 AND NEW.max_missions=112 AND OLD.active_mission_id is null
 AND NEW.token_allowance=OLD.token_allowance AND NEW.deadline=OLD.deadline
 AND EXISTS(SELECT 1 FROM project_package_execution_receipts x WHERE x.project_id=OLD.id AND x.authorization_txid=txid_current()))
 AND NOT (OLD.status='blocked' AND OLD.max_missions=112 AND NEW.max_missions=118 AND OLD.max_cycles=3 AND NEW.max_cycles=5
 AND NEW.token_allowance=OLD.token_allowance AND NEW.deadline=OLD.deadline
 AND EXISTS(select 1 from project_package_completion_receipts s where s.project_id=OLD.id and s.authorization_txid=txid_current()
  and s.failed_mission_id=OLD.active_mission_id and s.terms=project_org_package_completion_terms()))
 AND NOT (OLD.status='blocked' AND OLD.max_missions=118 AND NEW.max_missions=124 AND OLD.active_mission_id IS NULL
  AND NEW.token_allowance=OLD.token_allowance AND NEW.max_cycles=OLD.max_cycles AND NEW.cycles=OLD.cycles
  AND EXISTS(select 1 from project_package_checkpoint_continuations c where c.project_id=OLD.id and c.authorization_txid=txid_current() and c.prior_cutoff=OLD.deadline and c.cutoff=NEW.deadline and c.mission_id=NEW.active_mission_id and c.terms=project_org_package_checkpoint_terms()))
 THEN RAISE EXCEPTION 'Original commissioning resources require the exact one-time owner receipt'; END IF;
 RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.project_smart_mission_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
 if exists(select 1 from mission_assignments j join project_worker_admissions a on a.assignment_id=j.id where j.mission_id=old.id)
 and (new.project_id is distinct from old.project_id or new.project_kind is distinct from old.project_kind or new.objective is distinct from old.objective or new.project_evidence is distinct from old.project_evidence or new.repository_id is distinct from old.repository_id or new.team is distinct from old.team)
 and not (new.project_id is not distinct from old.project_id and new.project_kind is not distinct from old.project_kind and new.objective is not distinct from old.objective and new.repository_id is not distinct from old.repository_id and new.team is not distinct from old.team and old.status='blocked' and new.status='running'
  and exists(select 1 from project_package_checkpoint_continuations c where c.mission_id=old.id and c.project_id=old.project_id and c.authorization_txid=txid_current() and new.deadline=c.cutoff and old.deadline=c.prior_cutoff
   and new.project_evidence=old.project_evidence||jsonb_build_object('providerContinuationWindow',c.authorization_id,'checkpointRecoveryAuthorizationId',c.authorization_id)))
 then raise exception 'Admitted SMART mission context is immutable';end if;
 if new.project_id is not null and new.project_kind<>'management' and (new.project_id is distinct from old.project_id or new.project_kind is distinct from old.project_kind) then
 perform project_smart_admit(j.id) from mission_assignments j where j.mission_id=new.id and j.status in ('running','waiting_external');end if;
 return new;
end $function$;

CREATE OR REPLACE FUNCTION public.project_provider_request_before_director_recovery(p_job uuid, p_attempt text, p_request uuid, p_operation text, p_hash text, p_scope text DEFAULT NULL::text, p_receipt text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare j mission_assignments; m agent_missions; checked_at timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_job;
 select * into m from agent_missions where id=j.mission_id;
 checked_at:=clock_timestamp();
 if j.id is null or m.project_id is null or p_request is null or p_attempt is null
 or p_operation is null or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
 or m.status<>'running' or m.deadline is null or m.deadline<=checked_at
 or not exists(select 1 from work_projects p join project_provider_execution a on a.project_id=p.id
  where p.id=m.project_id and p.active_mission_id=m.id and p.status='running'
  and p.deadline>checked_at and a.deadline>checked_at) then return false;end if;
 if p_scope is null then
  if p_operation not in ('model-list','inference') or j.lease::text is distinct from p_attempt
  or j.status<>'running' or j.lease_until is null or j.lease_until<=checked_at then return false;end if;
 else
  if p_operation not in ('input-count','inference') or not project_provider_dispatch_live(j.id,p_scope)
  or not (exists(select 1 from project_provider_dispatches where task_id=j.id and run_id=p_attempt)
  or exists(select 1 from project_package_checkpoint_dispatches d join project_package_checkpoint_continuations c on c.authorization_id=d.authorization_id where d.task_id=j.id and d.run_id=p_attempt and project_org_package_checkpoint_dispatch_live(j.id,c.authorization_id,c.release_sha))) then return false;end if;
 end if;
 if p_receipt is not null then
  if length(p_receipt) not between 1 and 256 then return false;end if;
  update project_provider_requests set provider_receipt=p_receipt,resolved_at=clock_timestamp()
   where id=p_request and project_id=m.project_id and mission_id=m.id and assignment_id=j.id and worker_id=j.agent_id
   and execution_attempt=p_attempt and operation=p_operation and request_hash=p_hash and resolved_at is null;
  return found;
 end if;
 if p_scope is null and (not project_provider_mission_live(j.id,j.lease)
  or (p_operation='inference' and m.calls>=m.max_calls)) then return false;end if;
 insert into project_provider_requests(id,project_id,mission_id,assignment_id,worker_id,execution_attempt,operation,request_hash)
  values(p_request,m.project_id,m.id,j.id,j.agent_id,p_attempt,p_operation,p_hash) on conflict do nothing;
 if not found then return false;end if;
 if p_scope is null and p_operation='inference' then update agent_missions set calls=calls+1 where id=m.id;end if;
 return true;
end $function$;

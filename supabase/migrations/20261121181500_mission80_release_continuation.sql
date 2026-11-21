-- P0 Mission80: preserve exact downstream project continuation after
-- completed, owner-authorized Mission79 retry. No new retry/owner permission.
-- Neither the original special Mission79 predicate nor the scheduler changes.
BEGIN;
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
  -- This additional branch admits the exact, owner-approved downstream QA
  -- management assignment, NOT any Mission79 retry or general-purpose grant.
  -- Historical retry receipts prove completion only; project-wide execution
  -- authority, immutable owner lineage and current release gate do the granting.
  OR EXISTS(
 SELECT 1 FROM public.work_projects p
 JOIN public.project_provider_execution a ON a.project_id=p.id
  AND a.approved_scope=p.approved_hash AND a.deadline=p.deadline
 JOIN public.project_retest_future_window_receipts q ON q.project_id=p.id
  AND q.owner_id=a.owner_id AND q.authorization_id=a.window_id
  AND q.cutoff=p.deadline AND q.scope_hash=p.approved_hash
 JOIN public.project_execution_windows owner_window ON owner_window.id=a.window_id
  AND owner_window.project_id=p.id AND owner_window.owner_id=a.owner_id
  AND owner_window.decision_id=a.continuation_decision_id AND owner_window.cutoff=p.deadline
 JOIN public.project_mission79_retry_receipts r ON r.project_id=p.id
  AND r.owner_id=a.owner_id AND r.cutoff=p.deadline AND r.scope_hash=p.approved_hash
  AND r.prior_attempts=1 AND r.prior_calls=1
 JOIN public.project_mission79_watchdog_recovery_receipts w ON w.project_id=p.id
  AND w.original_retry_authorization_id=r.authorization_id AND w.owner_id=a.owner_id
  AND w.mission_id=r.mission_id AND w.assignment_id=r.assignment_id
  AND w.cutoff=p.deadline AND w.scope_hash=p.approved_hash
 JOIN public.agent_missions m79 ON m79.id=r.mission_id AND m79.project_id=p.id
  AND m79.status='completed' AND m79.calls=2
 JOIN public.mission_assignments j79 ON j79.id=r.assignment_id AND j79.mission_id=m79.id
  AND j79.status='completed' AND j79.attempts=2 AND j79.lease IS NULL
 JOIN public.project_organization_decisions d79 ON d79.project_id=p.id
  AND d79.assignment_id=j79.id AND d79.id::text=j79.result->>'decisionId'
 JOIN public.agent_missions m80 ON m80.id='ce8dcc30-e316-49e7-934d-6add6c14a697'::uuid
  AND m80.project_id=p.id AND m80.status='running' AND m80.calls=0
  AND m80.project_kind='management' AND m80.deadline=p.deadline
 JOIN public.mission_assignments j80 ON j80.id='3d118a6c-d121-4d65-8c6e-ed5620660b82'::uuid
  AND j80.mission_id=m80.id AND j80.status='queued' AND j80.attempts=0
  AND j80.lease IS NULL AND j80.lease_until IS NULL
  AND j80.available_at<=clock_timestamp()
 JOIN public.project_organization_nodes director ON director.id::text=m80.project_evidence->>'organizationNodeId'
  AND director.project_id=p.id AND director.status='active' AND director.agent_id=j80.agent_id
  AND director.management_level='functional_director' AND director.area='independent_qa'
 JOIN public.project_retest_production_release_gate g ON g.project_id=p.id
  AND g.state='active' AND g.alias_name='katie-mu.vercel.app'
  AND g.release_sha=p_release AND g.generation=p_generation
  AND g.deployment_id=p_deployment
 WHERE p.id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  AND p.id=p_project AND p.status='running' AND p.active_mission_id=m80.id
  AND p.phase='development' AND p.deadline>clock_timestamp()
  AND p.approval_hash=p.approved_hash AND p.max_missions=96 AND p.token_allowance=600000
  AND r.mission_id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
  AND r.assignment_id='85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
  AND w.authorized_at<d79.created_at AND d79.created_at<m80.created_at
  AND m80.project_evidence->>'providerContinuationWindow'=a.window_id::text
  AND m80.project_evidence->>'providerContinuationDecision'=a.continuation_decision_id::text
  AND m80.project_evidence->>'providerContinuationRelease'=a.continuation_release_sha
  AND (SELECT count(*) FROM public.agent_missions x WHERE x.project_id=p.id)=80
  AND (SELECT count(*) FROM public.mission_assignments x WHERE x.mission_id=m80.id)=1
  AND (SELECT count(*) FROM public.project_organization_nodes x WHERE x.project_id=p.id AND x.status='active')=13
  AND public.project_org_retest_original_owner_lineage(p.id)
  AND public.project_provider_continued(p.id)
  AND public.project_provider_continued_assignment(j80.id)
  AND NOT public.project_provider_request_pending(p.id)
)
 );
$function$

COMMIT;

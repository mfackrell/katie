-- Bind the assessed snapshot at the existing atomic completion boundary.
-- Preserve the existing lock, leases, review gates, ledger and private lifecycle.
DO $patch$
DECLARE body text; anchor text := 'if action=''complete'' then';
BEGIN
 SELECT pg_get_functiondef('public.finish_work_project(uuid,uuid,text,jsonb)'::regprocedure) INTO body;
 IF position(anchor IN body)=0 THEN RAISE EXCEPTION 'Project assessment completion anchor missing'; END IF;
 body := replace(body, anchor, anchor || $gate$
  if not exists (
   select 1 from agent_missions m
   join project_runs r on r.project_id=p.id and r.kind='development'
    and r.outcome->>'head'=p.verified_sha
   where m.id=p.active_mission_id and m.project_id=p.id
    and m.project_kind='assessment' and m.status='completed'
    and p.verified_sha is not null and p.approved_hash is not null
    and m.project_evidence->>'approvedScopeHash'=p.approved_hash
    and m.project_evidence->'approvedFinalContract'=p.spec->'finalContract'
    and m.project_evidence->'preview'=p.preview
    and m.project_evidence#>>'{finalIntegratedEvidence,taskId}'=r.outcome->>'taskId'
    and m.project_evidence#>>'{finalIntegratedEvidence,head}'=p.verified_sha
    and m.project_evidence#>>'{finalIntegratedEvidence,verification,observedHeadSha}'=p.verified_sha
    and m.project_evidence#>>'{finalIntegratedEvidence,verification,testedHeadSha}'=p.verified_sha
    and m.project_evidence#>>'{finalIntegratedEvidence,verification,reviewedHeadSha}'=p.verified_sha
  ) then raise exception 'Final assessment is not bound to the accepted task, candidate and approved contract'; end if;
$gate$);
 EXECUTE body;
END $patch$;

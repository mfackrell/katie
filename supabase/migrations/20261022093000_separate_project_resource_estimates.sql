-- Phase 1: forecasts are advisory, spending authorizations are enforceable,
-- and operational watchdogs remain independent. Preserve all live budgets.
ALTER TABLE public.work_projects
 ADD COLUMN IF NOT EXISTS estimated_tokens bigint,
 ADD COLUMN IF NOT EXISTS estimate_rationale text,
 ADD COLUMN IF NOT EXISTS estimate_updated_at timestamptz,
 ADD COLUMN IF NOT EXISTS budget_authorization_source text NOT NULL DEFAULT 'legacy_default';
ALTER TABLE public.work_projects
 ADD CONSTRAINT work_projects_estimate_positive CHECK (estimated_tokens IS NULL OR estimated_tokens > 0),
 ADD CONSTRAINT work_projects_estimate_rationale_size CHECK (estimate_rationale IS NULL OR length(estimate_rationale) <= 4000),
 ADD CONSTRAINT work_projects_authorization_source_valid CHECK (budget_authorization_source IN ('legacy_default','user_approved','policy'));
COMMENT ON COLUMN public.work_projects.estimated_tokens IS
 'Non-binding forecast; exceeding this estimate alone MUST NOT change project status or admission.';
COMMENT ON COLUMN public.work_projects.token_allowance IS
 'Existing enforced authorization. Never change this field when recording an estimate.';
COMMENT ON COLUMN public.work_projects.max_missions IS
 'Existing operational safety watchdog, separate from forecast and spending authorization.';
COMMENT ON COLUMN public.work_projects.max_cycles IS
 'Existing operational safety watchdog, separate from forecast and spending authorization.';
COMMENT ON COLUMN public.work_projects.deadline IS
 'Existing execution time safeguard, separate from forecast and spending authorization.';

-- Backend-only estimate updates. This is intentionally NOT an authorization API.
CREATE OR REPLACE FUNCTION public.set_project_resource_estimate(
 p_id uuid, p_actor uuid, p_chat uuid, p_tokens bigint, p_rationale text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $fn$
DECLARE p work_projects;
BEGIN
 IF p_tokens IS NULL OR p_tokens <= 0 OR p_tokens > 1000000000000
    OR length(trim(coalesce(p_rationale,''))) NOT BETWEEN 10 AND 4000 THEN
  RAISE EXCEPTION 'Invalid project resource estimate';
 END IF;
 SELECT * INTO p FROM work_projects WHERE id=p_id AND actor_id=p_actor AND chat_id=p_chat FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Project not found in supplied scope'; END IF;
 UPDATE work_projects SET estimated_tokens=p_tokens,estimate_rationale=trim(p_rationale),
   estimate_updated_at=clock_timestamp(),updated_at=clock_timestamp()
 WHERE id=p.id RETURNING * INTO p;
 INSERT INTO project_events(project_id,event,data) VALUES
  (p.id,'resource_estimate_updated',jsonb_build_object(
   'estimatedTokens',p_tokens,'authorizedTokens',p.token_allowance,
   'authorizationSource',p.budget_authorization_source,'rationale',p.estimate_rationale));
 RETURN jsonb_build_object('projectId',p.id,'estimatedTokens',p.estimated_tokens,
  'authorizedTokens',p.token_allowance,'authorizationSource',p.budget_authorization_source,
  'safeguards',jsonb_build_object('maxMissions',p.max_missions,
      'maxCycles',p.max_cycles,'deadline',p.deadline));
END $fn$;
REVOKE ALL ON FUNCTION public.set_project_resource_estimate(uuid,uuid,uuid,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_project_resource_estimate(uuid,uuid,uuid,bigint,text)
 TO service_role;

-- Network or worker retries reuse an identical reviewed estimate without duplicating cost or records.
CREATE OR REPLACE FUNCTION public.record_reviewed_specialist_estimate(
 p_project uuid,p_mission uuid,p_specialist text,p_scope_hash text,p_estimate jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path TO 'public' AS $fn$
DECLARE m agent_missions; p work_projects; j_count integer;
BEGIN
 SELECT * INTO p FROM work_projects WHERE id=p_project FOR UPDATE;
 SELECT * INTO m FROM agent_missions WHERE id=p_mission AND project_id=p_project;
 IF NOT FOUND OR m.status<>'completed' OR m.result IS NULL THEN RETURN false; END IF;
 IF p.id IS NULL OR p.spec IS NULL OR p.approval_hash IS NULL OR
    p.approval_hash<>p_scope_hash THEN RETURN false; END IF;
 SELECT count(*) INTO j_count FROM mission_assignments
 WHERE mission_id=p_mission AND role='review' AND status='completed';
 IF j_count<1 THEN RETURN false; END IF;
 IF p_estimate IS NULL OR jsonb_typeof(p_estimate)<>'object'
   OR length(p_estimate::text)>20000 OR p_estimate->>'origin'<>'specialist_verified' THEN RETURN false; END IF;
 -- The submitted work packages must be verbatim from the reviewed mission output.
 IF NOT pg_input_is_valid(m.result,'jsonb') THEN RETURN false; END IF;
 IF (m.result::jsonb)->'packages' IS DISTINCT FROM p_estimate->'packages'
  OR (m.result::jsonb)->>'specialist' IS DISTINCT FROM p_specialist
  OR (m.result::jsonb)->>'scopeHash' IS DISTINCT FROM p_scope_hash THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM project_specialist_estimates WHERE mission_id=p_mission
  AND project_id=p_project AND specialist=p_specialist AND scope_hash=p_scope_hash
  AND estimate=p_estimate) THEN RETURN true; END IF;
 INSERT INTO project_specialist_estimates(project_id,mission_id,specialist,scope_hash,estimate)
 VALUES (p_project,p_mission,p_specialist,p_scope_hash,p_estimate)
 ON CONFLICT (mission_id) DO NOTHING;
 RETURN FOUND;
END $fn$;
REVOKE ALL ON FUNCTION public.record_reviewed_specialist_estimate(uuid,uuid,text,text,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_reviewed_specialist_estimate(uuid,uuid,text,text,jsonb)
 TO service_role;

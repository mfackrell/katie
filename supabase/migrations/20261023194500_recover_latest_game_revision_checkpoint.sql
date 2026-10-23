-- Restore the latest saved game composition OR revision into fresh independent review.
-- Does not waive independent review, reauthorize development, or reset spending.
CREATE OR REPLACE FUNCTION public.recover_game_specification_checkpoint(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE
  p work_projects;
  source_job mission_assignments;
  source_mission agent_missions;
  spent bigint;
  run_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
  SELECT * INTO p FROM work_projects WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR p.profile<>'game' OR p.phase<>'specification'
     OR p.status<>'blocked' OR p.approved_hash IS NOT NULL
     OR p.deadline<=now()+interval '10 minutes' THEN RETURN false; END IF;
  SELECT count(*) INTO run_count FROM project_runs WHERE project_id=p.id;
  SELECT coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0)
    INTO spent FROM agent_missions WHERE project_id=p.id;
  -- Do not admit a new review mission with inadequate aggregate allowance.\n  IF run_count>=p.max_missions OR p.token_allowance-spent<25000 THEN RETURN false; END IF;
  -- An active mission must have finished or expired; never steal a live lease.
  IF p.active_mission_id IS NOT NULL THEN
    SELECT * INTO source_mission FROM agent_missions
      WHERE id=p.active_mission_id AND project_id=p.id FOR UPDATE;
    IF NOT FOUND OR source_mission.status<>'blocked'
    THEN RETURN false; END IF;
  END IF;
  -- Source must be a persisted, completed specification composition, never a
  -- reviewer response or model-authored project metadata.
  SELECT j.* INTO source_job
    FROM mission_assignments j JOIN agent_missions m ON m.id=j.mission_id
    WHERE m.project_id=p.id AND m.project_kind='specification' AND m.status='blocked'
      AND j.role IN ('revise','compose') AND j.status='completed'
      AND jsonb_typeof(j.result->'text')='string'
      AND length(j.result->>'text') BETWEEN 100 AND 40000
    ORDER BY m.created_at DESC,j.created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM project_events WHERE project_id=p.id
    AND event='game_specification_checkpoint_recovered'
    AND data->>'sourceJobId'=source_job.id::text) THEN RETURN false; END IF;
  UPDATE work_projects SET status='running',active_mission_id=null,
    lease=null,lease_until=null,failures=0,
    detail='Resuming original saved specification checkpoint for fresh independent review.',
    updated_at=now() WHERE id=p.id;
  INSERT INTO project_events(project_id,event,data) VALUES
    (p.id,'game_specification_checkpoint_recovered',
      jsonb_build_object('sourceJobId',source_job.id,'sourceMissionId',source_job.mission_id,
       'chargedTokens',spent,'remainingTokens',p.token_allowance-spent,
       'recoveryType','saved_composition_fresh_review'));
  PERFORM project_publish(p.id,
   'Saved specification checkpoint recovered. Fresh independent review is required before any coding approval.');
  RETURN true;
END $function$;

-- Recovery changes mission ownership and scheduling; backend only.
REVOKE ALL ON FUNCTION public.recover_game_specification_checkpoint(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_game_specification_checkpoint(uuid) TO service_role;

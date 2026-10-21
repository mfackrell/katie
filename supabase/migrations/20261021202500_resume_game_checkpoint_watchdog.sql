-- Repair the race between a legitimate checkpoint recovery and the
-- historical three-failure project progress watchdog. Do not reset budgets.
CREATE OR REPLACE FUNCTION public.resume_game_checkpoint_watchdog(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE p work_projects; recovered_at timestamptz; charge bigint; run_count integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 SELECT * INTO p FROM work_projects WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR p.status<>'blocked' OR p.profile<>'game'
   OR p.phase<>'specification' OR p.approved_hash IS NOT NULL
   OR p.active_mission_id IS NOT NULL
   OR p.deadline<=now()+interval '10 minutes'
   OR p.detail NOT LIKE 'Progress watchdog: three consecutive failed specification attempts%' THEN RETURN false; END IF;
 SELECT max(created_at) INTO recovered_at FROM project_events
   WHERE project_id=p.id AND event='game_specification_checkpoint_recovered';
 IF recovered_at IS NULL OR EXISTS(SELECT 1 FROM project_runs
   WHERE project_id=p.id AND kind='specification' AND created_at>=recovered_at) THEN RETURN false; END IF;
 SELECT count(*) INTO run_count FROM project_runs WHERE project_id=p.id;
 SELECT coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0)
   INTO charge FROM agent_missions WHERE project_id=p.id;
 IF run_count>=p.max_missions OR p.token_allowance-charge<25000 THEN RETURN false; END IF;
 UPDATE work_projects SET status='running',lease=null,lease_until=null,failures=0,
   detail='Checkpoint recovery resumed after legacy progress watchdog; one new review attempt remains authorized.',
   updated_at=now() WHERE id=p.id;
 INSERT INTO project_events(project_id,event,data) VALUES
   (p.id,'game_checkpoint_watchdog_resumed',
    jsonb_build_object('recoveryAt',recovered_at,'chargedTokens',charge,'runs',run_count));
 RETURN true;
END $function$;
REVOKE ALL ON FUNCTION public.resume_game_checkpoint_watchdog(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resume_game_checkpoint_watchdog(uuid) TO service_role;

-- Bounded, backend-only lock wait measurements. Never persist mission IDs,
-- query text, request payloads or credentials. The existing lock key and
-- transaction semantics remain exactly unchanged.
CREATE OR REPLACE FUNCTION public.mission_state_lock_instrumented(p_operation text)
RETURNS void LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE started timestamptz:=clock_timestamp(); elapsed_ms numeric;
BEGIN
 IF p_operation NOT IN ('recover_game_specification_checkpoint','resume_game_checkpoint_watchdog') THEN
   RAISE EXCEPTION 'Unknown instrumented mission operation';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 elapsed_ms:=round(extract(epoch from (clock_timestamp()-started))*1000,1);
 IF elapsed_ms>=100 THEN
   RAISE LOG 'katie_mission_lock_wait operation=% wait_ms=%',p_operation,elapsed_ms;
 END IF;
END $function$;
REVOKE ALL ON FUNCTION public.mission_state_lock_instrumented(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mission_state_lock_instrumented(text) TO service_role;

-- Only these two recovery paths are instrumented in the first release;
-- expand based on actual data, after comparing logged lock waits with the
-- existing end-to-end RPC duration measurements.

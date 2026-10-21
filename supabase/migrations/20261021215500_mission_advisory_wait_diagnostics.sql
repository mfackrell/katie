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

-- Recompile only the named, existing routines, preserving their guards and
-- transaction logic. Abort if the expected lock statement is not unique.
DO $migration$
DECLARE fn text; original text; updated text; operation text; needle text:='PERFORM pg_advisory_xact_lock(hashtextextended(''katie.mission.state'',0));';
BEGIN
 FOREACH operation IN ARRAY ARRAY['recover_game_specification_checkpoint','resume_game_checkpoint_watchdog'] LOOP
   SELECT pg_get_functiondef(p.oid) INTO original FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname=operation AND p.pronargs=1;
   IF original IS NULL OR (length(original)-length(replace(original,needle,'')))<>length(needle) THEN
     RAISE EXCEPTION 'Expected unique advisory lock not found in %',operation;
   END IF;
   updated:=replace(original,needle,'PERFORM public.mission_state_lock_instrumented('''||operation||''');');
   EXECUTE updated;
 END LOOP;
END $migration$;

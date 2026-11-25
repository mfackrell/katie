-- Fix the observed 42702 production scheduler failure without changing owner,
-- release, lease, retry or package authorization. The local PL/pgSQL record
-- m conflicts with the expired-assignment subquery's table alias m.
DO $fix$
DECLARE d text; a text:='select 1 from agent_missions m where m.id=j0.mission_id and project_org_package_execution_required(m.project_id)'; b text:='select 1 from agent_missions expired_mission where expired_mission.id=j0.mission_id and project_org_package_execution_required(expired_mission.project_id)';
BEGIN
 d:=pg_get_functiondef('public.claim_mission_work_release_epoch(text,bigint,text)'::regprocedure);
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'Unexpected claim function source'; END IF;
 EXECUTE replace(d,a,b);
END $fix$;

-- The multi-agent capacity replacement dropped the original parent-project
-- completion fence. Restore it without changing its eight-assignment capacity,
-- independent review gates, accounting, or existing dispatch recovery.
DO $patch$
DECLARE body text; anchor text:='select * into j from mission_assignments where id=p_id for update;';
BEGIN
 SELECT pg_get_functiondef('public.commit_mission_work(uuid,uuid,jsonb,jsonb,text,text,text)'::regprocedure) INTO body;
 IF position(anchor IN body)=0 THEN RAISE EXCEPTION 'Mission completion fence anchor missing'; END IF;
 body:=replace(body,anchor,anchor||E'\n if p_lease is null or j.lease is null or j.lease_until is null or m.deadline is null then return false; end if;\n if m.project_id is not null and not exists(select 1 from work_projects p where p.id=m.project_id and p.status=''running'' and p.active_mission_id=m.id and p.deadline>now()) then return false;end if;');
 EXECUTE body;
END $patch$;

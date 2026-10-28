-- Explicit pauses are not failed execution time. Use the existing audited
-- paused->resume event as a separate inactivity anchor; do not label it progress
-- or change any project/mission deadline, approval, attempt, or charge.
DO $$ declare definition text; old_condition text:='elsif action=''wait'' and p.progress_since<=now()-stall_window then';
 new_condition text:=$replacement$elsif action='wait' and greatest(p.progress_since,
  coalesce((select max(e.created_at) from public.project_events e
   where e.project_id=p.id and e.event='resume' and e.data->>'previous_status'='paused'),p.progress_since))<=now()-stall_window then$replacement$;
begin
 select pg_get_functiondef('public.finish_work_project(uuid,uuid,text,jsonb)'::regprocedure) into definition;
 if strpos(definition,old_condition)=0 then raise exception 'Expected existing project watchdog condition missing';end if;
 execute replace(definition,old_condition,new_condition);
end $$;

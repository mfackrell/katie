DO $$ declare p work_projects;mid uuid;recovered uuid;scenario text;ok boolean;before_usage bigint;begin
 foreach scenario in array array['valid','essential','failed_worker','expired','budget','allowance','wrong_lease','development'] loop
  begin
   select * into strict p from work_projects where id='44444444-4444-4444-8444-444444444444';
   mid:=gen_random_uuid();perform create_mission(mid,'Give concise source-supported findings in at most 700 words.',p.team,120,null);perform control_mission(mid,'start');
   update agent_missions set status='blocked',project_id=p.id,project_kind='research',actual_tokens=1000,reserved_tokens=1200 where id=mid;
   update mission_assignments set status='completed' where mission_id=mid;
   insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,status,result) values
    (mid,'source','work',p.team[2],'Saved research','completed','{"text":"Authoritative evidence","sources":[]}'),
    (mid,'revision','revise',p.team[1],'Saved revised draft','completed','{"text":"Original draft with material rules"}'),
    (mid,'review_again','review',p.team[2],'Saved independent review','completed','{"verdict":"changes_requested","findings":["Remove peripheral details"],"clarification":null}');
   update work_projects set phase='research',status='blocked',active_mission_id=mid,lease=null,lease_until=null,token_allowance=600000 where id=p.id;
   if scenario='essential' then update mission_assignments set result=result||'{"clarification":{"essential":true}}' where mission_id=mid and job_key='review_again';end if;
   if scenario='failed_worker' then update mission_assignments set status='failed' where mission_id=mid and job_key='source';end if;
   if scenario='expired' then update agent_missions set deadline=now()-interval '1 second' where id=mid;end if;
   if scenario='budget' then update work_projects set token_allowance=60000 where id=p.id;update agent_missions set reserved_tokens=60000 where id=mid;end if;
   if scenario='allowance' then update work_projects set max_missions=(select count(*) from project_runs where project_id=p.id) where id=p.id;end if;
   if scenario='wrong_lease' then update work_projects set status='running',lease=gen_random_uuid(),lease_until=now()+interval '1 minute' where id=p.id;end if;
   if scenario='development' then update agent_missions set project_kind='development' where id=mid;end if;
   select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into before_usage from agent_missions where project_id=p.id;
   ok:=recover_project_research(p.id,null);
   if scenario='valid' then
    if not ok then raise exception 'Valid saved research not recovered';end if;
    select active_mission_id into recovered from work_projects where id=p.id;
    if recovered=mid or (select status from agent_missions where id=mid)<>'blocked' then raise exception 'Prior mission overwritten';end if;
    if (select sum(greatest(actual_tokens,reserved_tokens)) from agent_missions where project_id=p.id)<>before_usage then raise exception 'Research charges reset';end if;
    if (select deadline from agent_missions where id=recovered) is distinct from (select deadline from agent_missions where id=mid) then raise exception 'Research deadline reset';end if;
    if (select cycles from work_projects where id=p.id)<>p.cycles then raise exception 'Recovery consumed coding';end if;
    if not exists(select 1 from mission_assignments where mission_id=recovered and role='work' and status='completed' and result->>'text'='Authoritative evidence') then raise exception 'Saved evidence lost';end if;
    if exists(select 1 from mission_assignments where mission_id=recovered and role='development') then raise exception 'Research dispatched coding';end if;
    update work_projects set status='blocked' where id=p.id;update agent_missions set status='blocked' where id=recovered;
    if recover_project_research(p.id,null) then raise exception 'Recovery repeated';end if;
   elsif ok then raise exception 'Unsafe research recovery: %',scenario;end if;
   raise exception using errcode='P2004',message='rollback research fixture';
  exception when sqlstate 'P2004' then null;end;
 end loop;
 if has_function_privilege('anon','public.recover_project_research(uuid,uuid)','execute') or has_function_privilege('authenticated','public.recover_project_research(uuid,uuid)','execute') then raise exception 'Public research recovery access';end if;
end $$;

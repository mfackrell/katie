DO $$ declare p work_projects;m agent_missions;j uuid;scenario text;ok boolean;begin
 foreach scenario in array array['valid_legacy','valid_max_output','wrong_actor','software','content_filter','exhausted_attempt','expired','budget'] loop
  begin
   select * into strict p from work_projects where id='44444444-4444-4444-8444-444444444444';select * into strict m from agent_missions where id=p.active_mission_id;
   update work_projects set status='blocked',phase='specification',profile=case when scenario='software' then 'software' else 'game' end,token_allowance=600000 where id=p.id;
   update agent_missions set status='blocked',project_kind='specification',repository_id=null,project_evidence='{"projectProfile":"game"}',actual_tokens=1000,reserved_tokens=1200 where id=m.id;
   insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,status,attempts,result) values(m.id,'spec_output_fixture','compose',p.team[1],'Complete specification','failed',case when scenario='exhausted_attempt' then 2 else 1 end,jsonb_build_object('detail','Model output incomplete: incomplete')||case when scenario='valid_max_output' then '{"incompleteReason":"max_output_tokens"}'::jsonb when scenario='content_filter' then '{"incompleteReason":"content_filter"}'::jsonb else '{}'::jsonb end) returning id into j;
   if scenario='expired' then update agent_missions set deadline=now()-interval '1 second' where id=m.id;end if;
   if scenario='budget' then update agent_missions set reserved_tokens=token_allowance where id=m.id;end if;
   ok:=retry_game_specification(p.id,case when scenario='wrong_actor' then gen_random_uuid() else p.actor_id end,p.chat_id);
   if scenario in ('valid_legacy','valid_max_output') then
    if not ok or (select status from mission_assignments where id=j)<>'queued' or (select attempts from mission_assignments where id=j)<>1 then raise exception 'Valid first truncated game specification not recovered';end if;
    if (select calls from agent_missions where id=m.id)<>m.calls or (select actual_tokens from agent_missions where id=m.id)<>1000 or (select reserved_tokens from agent_missions where id=m.id)<>1200 or (select deadline from agent_missions where id=m.id) is distinct from m.deadline or (select cycles from work_projects where id=p.id)<>p.cycles then raise exception 'Specification retry reset a limit or charge';end if;
    if not exists(select 1 from project_events where project_id=p.id and event='game_specification_output_retry' and data->>'trigger'='explicit_resume' and data->>'classification'=case when scenario='valid_legacy' then 'legacy_unknown_explicit_resume' else 'max_output_tokens' end) then raise exception 'Explicit retry lost its truthful failure classification';end if;
    if scenario='valid_legacy' and (select result->>'incompleteReason' from mission_assignments where id=j) is not null then raise exception 'Unknown provider reason was fabricated';end if;
    if retry_game_specification(p.id,p.actor_id,p.chat_id) then raise exception 'Concurrent duplicate specification retry';end if;
   elsif ok then raise exception 'Unsafe specification retry: %',scenario;end if;
   raise exception using errcode='P2006',message='rollback output retry fixture';
  exception when sqlstate 'P2006' then null;end;
 end loop;
 if has_function_privilege('anon','public.retry_game_specification(uuid,uuid,uuid)','execute') or has_function_privilege('authenticated','public.retry_game_specification(uuid,uuid,uuid)','execute') then raise exception 'Public specification retry';end if;
end $$;

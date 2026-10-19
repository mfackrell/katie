DO $$ declare p work_projects;m agent_missions;j uuid;scenario text;ok boolean;begin
 foreach scenario in array array['valid','missing_legacy','wrong_failure','already_repaired'] loop
  begin
   select * into strict p from work_projects where id='44444444-4444-4444-8444-444444444444';select * into strict m from agent_missions where id=p.active_mission_id;
   update work_projects set status='blocked',phase='specification',profile='game',token_allowance=600000 where id=p.id;
   update agent_missions set status='blocked',project_kind='specification',repository_id=null,project_evidence='{"projectProfile":"game"}',actual_tokens=1000,reserved_tokens=1200 where id=m.id;
   insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,status,attempts,result) values(m.id,'shared_contract_fixture','compose',p.team[1],'Saved specification','failed',2,jsonb_build_object('specificationValidationFeedback',case when scenario='wrong_failure' then 'Missing material requirement' else 'Specification exceeds the bounded approval/evidence package; simplify the milestones without dropping requirements' end)) returning id into j;
   if scenario<>'missing_legacy' then insert into project_events(project_id,event,data) values(p.id,'game_specification_output_retry',jsonb_build_object('jobId',j,'classification','legacy_unknown_explicit_resume'));end if;
   if scenario='already_repaired' then insert into project_events(project_id,event,data) values(p.id,'game_specification_validation_retry',jsonb_build_object('jobId',j));end if;
   ok:=retry_game_specification(p.id,p.actor_id,p.chat_id);
   if scenario='valid' then
    if not ok or (select status from mission_assignments where id=j)<>'queued' or (select attempts from mission_assignments where id=j)<>2 then raise exception 'Valid shared-contract repair did not preserve attempts';end if;
    if (select calls from agent_missions where id=m.id)<>m.calls or (select actual_tokens from agent_missions where id=m.id)<>1000 or (select reserved_tokens from agent_missions where id=m.id)<>1200 or (select deadline from agent_missions where id=m.id) is distinct from m.deadline or (select cycles from work_projects where id=p.id)<>p.cycles then raise exception 'Shared-contract repair reset a charge or limit';end if;
    if not exists(select 1 from project_events where project_id=p.id and event='game_specification_validation_retry' and data->>'jobId'=j::text and data->>'classification'='shared_contract_size_validation') then raise exception 'Size repair not audited';end if;
    update work_projects set status='blocked' where id=p.id;update agent_missions set status='blocked' where id=m.id;update mission_assignments set status='failed' where id=j;
    if retry_game_specification(p.id,p.actor_id,p.chat_id) then raise exception 'Repeated size repair admitted';end if;
   elsif ok then raise exception 'Unsafe shared-contract repair: %',scenario;end if;
   raise exception using errcode='P2007',message='rollback shared-contract retry fixture';
  exception when sqlstate 'P2007' then null;end;
 end loop;
end $$;

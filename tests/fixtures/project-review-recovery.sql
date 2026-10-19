-- Each recovery case rolls back, preserving the original budget-race fixture.
DO $$ declare p work_projects;m agent_missions;j uuid;r jsonb;scenario text;begin
 foreach scenario in array array['valid','exhausted_attempt','substantive_failure','expired','exhausted_budget','exhausted_project','expired_mission','stopped','wrong_owner'] loop
  begin
   select * into strict p from work_projects where id='44444444-4444-4444-8444-444444444444';
   select * into strict m from agent_missions where id=p.active_mission_id;
   update work_projects set status='blocked',phase='specification' where id=p.id;
   update agent_missions set status='blocked',project_kind='specification',actual_tokens=1000,reserved_tokens=1200 where id=m.id;
   insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,status,attempts,result)
   values(m.id,'review_recovery_fixture','review',p.team[2],'Independently review the specification.','failed',case when scenario='exhausted_attempt' then 2 else 1 end,jsonb_build_object('detail',case when scenario='substantive_failure' then 'Independent review rejected missing requirements' else 'Invalid task conflict provenance' end)) returning id into j;
   if scenario='expired' then update work_projects set deadline=now()-interval '1 second' where id=p.id;end if;
   if scenario='exhausted_budget' then update agent_missions set reserved_tokens=token_allowance where id=m.id;end if;
   if scenario='exhausted_project' then update agent_missions set reserved_tokens=p.token_allowance where project_id=p.id and id<>m.id;end if;
   if scenario='expired_mission' then update agent_missions set deadline=now()-interval '1 second' where id=m.id;end if;
   if scenario='stopped' then update work_projects set status='stopped' where id=p.id;end if;
   if scenario='wrong_owner' then
    begin perform retry_project_review(p.id,gen_random_uuid(),p.chat_id);raise exception 'Wrong owner recovered a review';exception when no_data_found then null;end;
   else
    r:=retry_project_review(p.id,p.actor_id,p.chat_id);
    if scenario='valid' then
     if r->>'status'<>'running' or (select status from mission_assignments where id=j)<>'queued' or (select attempts from mission_assignments where id=j)<>1 then raise exception 'Valid review was not recovered with its attempt retained';end if;
     if (select actual_tokens from agent_missions where id=m.id)<>1000 or (select reserved_tokens from agent_missions where id=m.id)<>1200 or (select calls from agent_missions where id=m.id)<>m.calls or (select deadline from work_projects where id=p.id)<>p.deadline or (select cycles from work_projects where id=p.id)<>p.cycles then raise exception 'Recovery reset a charge, allowance or deadline';end if;
     if retry_project_review(p.id,p.actor_id,p.chat_id) is not null then raise exception 'Review recovery was admitted twice';end if;
     if not exists(select 1 from project_events where project_id=p.id and event='review_retry') then raise exception 'Review recovery was not audited';end if;
    elsif r is not null then raise exception 'Unsafe review recovery admitted: %',scenario;end if;
   end if;
   raise exception using errcode='P2003',message='rollback recovery fixture';
  exception when sqlstate 'P2003' then null;end;
 end loop;
end $$;

-- Context repair is restricted to the recovered read-only research mission.
DO $$ declare p work_projects;m agent_missions;j uuid;r jsonb;scenario text;begin
 foreach scenario in array array['valid_context','missing_recovery','development_context'] loop
  begin
   select * into strict p from work_projects where id='44444444-4444-4444-8444-444444444444';
   select * into strict m from agent_missions where id=p.active_mission_id;
   update work_projects set status='blocked',phase='research',token_allowance=600000 where id=p.id;
   update agent_missions set status='blocked',project_kind=case when scenario='development_context' then 'development' else 'research' end,project_evidence=case when scenario='missing_recovery' then '{}'::jsonb else '{"researchRecovery":{"sourceMissionId":"original-research"}}'::jsonb end,actual_tokens=1000,reserved_tokens=1200 where id=m.id;
   insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,status,attempts,result) values(m.id,'context_fixture','review',p.team[2],'Review saved research','failed',1,'{"detail":"Mission evidence exceeds bounded context. Narrow the objective or deliverable."}') returning id into j;
   r:=retry_project_review(p.id,p.actor_id,p.chat_id);
   if scenario='valid_context' then
    if r is null or (select status from mission_assignments where id=j)<>'queued' or (select attempts from mission_assignments where id=j)<>1 then raise exception 'Failed research context did not retry exactly once';end if;
    if (select result ? 'reviewContractFeedback' from mission_assignments where id=j) then raise exception 'Context failure corrupted draft-blind contract feedback';end if;
    if (select actual_tokens from agent_missions where id=m.id)<>1000 or (select calls from agent_missions where id=m.id)<>m.calls then raise exception 'Context retry reset charges';end if;
   elsif r is not null then raise exception 'Unsafe context retry admitted: %',scenario;end if;
   raise exception using errcode='P2005',message='rollback context retry fixture';
  exception when sqlstate 'P2005' then null;end;
 end loop;
end $$;

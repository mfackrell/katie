-- Behavioral integration acceptance for guarded specification resumes, rolled back
-- to leave the existing test fixtures and usage counters untouched.
do $$
declare p work_projects; m agent_missions; r mission_assignments; c jsonb; charged bigint; scenario text; ok boolean; n integer;
begin
 select * into strict p from work_projects where id='44444444-4444-4444-8444-444444444444';
 select * into strict m from agent_missions where id=p.active_mission_id;
 foreach scenario in array array['review_valid','review_wrong_actor','review_wrong_chat','review_no_calls','review_no_tokens','review_expired','review_unapproved_project'] loop
  begin
   update work_projects set status='blocked',phase='specification',profile='game',
    approval_hash=null,approved_hash=null,spec=null,token_allowance=600000,
    deadline=now()+interval '2 days',lease=null,lease_until=null,
    active_mission_id=m.id where id=p.id;
   update agent_missions set project_kind='specification',status='blocked',
    calls=2,routing_calls=1,actual_tokens=1000,reserved_tokens=1500,
    deadline=now()+interval '90 minutes' where id=m.id;
   update mission_assignments set status='completed',lease=null,lease_until=null where mission_id=m.id;
   update mission_assignments set result='{"text":"Complete saved independently reviewed candidate specification"}'::jsonb,
    status='completed' where mission_id=m.id and job_key='compose';
   update mission_assignments set status='failed',attempts=4,
    result='{"detail":"Model output incomplete: incomplete"}'::jsonb,
    detail='Model output incomplete: incomplete' where mission_id=m.id and role='review'
    returning * into r;
   if not found then raise exception 'Review fixture assignment missing';end if;
   if scenario='review_no_calls' then update agent_missions set calls=max_calls-1 where id=m.id;end if;
   if scenario='review_no_tokens' then update agent_missions set reserved_tokens=token_allowance-19999 where id=m.id;end if;
   if scenario='review_expired' then update agent_missions set deadline=now()+interval '2 minutes' where id=m.id;end if;
   if scenario='review_unapproved_project' then update work_projects set approval_hash=repeat('a',64) where id=p.id;end if;
   select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into charged from agent_missions where project_id=p.id;
   ok:=resume_incomplete_game_review(p.id,
     case when scenario='review_wrong_actor' then gen_random_uuid() else p.actor_id end,
     case when scenario='review_wrong_chat' then gen_random_uuid() else p.chat_id end);
   if scenario='review_valid' then
    if not ok then raise exception 'Valid review did not resume';end if;
    if (select status from mission_assignments where id=r.id)<>'queued' or (select attempts from mission_assignments where id=r.id)<>4 then raise exception 'Review attempts reset';end if;
    if (select status from agent_missions where id=m.id)<>'running'
      or (select status from work_projects where id=p.id)<>'running'
      or (select approved_hash from work_projects where id=p.id) is not null
      or (select approval_hash from work_projects where id=p.id) is not null then raise exception 'Unsafe review resume state';end if;
    if (select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) from agent_missions where project_id=p.id)<>charged then raise exception 'Review recovery altered charges';end if;
    if resume_incomplete_game_review(p.id,p.actor_id,p.chat_id) then raise exception 'Duplicate review recovery admitted';end if;
    c:=claim_mission_work();
    if c is null or (c->'job'->>'id')::uuid<>r.id then raise exception 'Recovered saved review not claimable';end if;
   elsif ok then raise exception 'Unsafe reviewer resume: %',scenario;end if;
   raise exception using errcode='P2008',message='roll back guarded review fixture';
  exception when sqlstate 'P2008' then null;end;
 end loop;

 foreach scenario in array array['oversized_valid','oversized_wrong_actor','oversized_wrong_chat','oversized_budget','oversized_deadline','oversized_approval'] loop
  begin
   update work_projects set status='blocked',phase='specification',profile='game',
    active_mission_id=null,approval_hash=null,approved_hash=null,spec=null,
    detail='Project milestone context exceeds its bounded input. Narrow the specification; original requirements have not been truncated.',
    token_allowance=600000,deadline=now()+interval '2 days',lease=null,lease_until=null where id=p.id;
   update agent_missions set status='completed' where id in (select mission_id from project_runs where project_id=p.id and kind='research');
   if scenario='oversized_budget' then update work_projects set token_allowance=60000 where id=p.id;end if;
   if scenario='oversized_deadline' then update work_projects set deadline=now()+interval '10 minutes' where id=p.id;end if;
   if scenario='oversized_approval' then update work_projects set approved_hash=repeat('a',64) where id=p.id;end if;
   select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into charged from agent_missions where project_id=p.id;
   ok:=resume_oversized_game_specification(p.id,
     case when scenario='oversized_wrong_actor' then gen_random_uuid() else p.actor_id end,
     case when scenario='oversized_wrong_chat' then gen_random_uuid() else p.chat_id end);
   if scenario='oversized_valid' then
    if not ok then raise exception 'Valid oversized recovery did not resume';end if;
    if (select status from work_projects where id=p.id)<>'running'
      or (select active_mission_id from work_projects where id=p.id) is not null
      or (select approved_hash from work_projects where id=p.id) is not null then raise exception 'Oversized recovery skipped safeguard';end if;
    if (select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) from agent_missions where project_id=p.id)<>charged then raise exception 'Oversized recovery reset charges';end if;
    if resume_oversized_game_specification(p.id,p.actor_id,p.chat_id) then raise exception 'Repeated oversized recovery';end if;
    c:=claim_work_project();
    if c is null or c->>'id'<>p.id::text then raise exception 'Recovered project not claimable';end if;
   elsif ok then raise exception 'Unsafe oversized resume: %',scenario;end if;
   raise exception using errcode='P2008',message='roll back oversized specification fixture';
  exception when sqlstate 'P2008' then null;end;
 end loop;
 if has_function_privilege('anon','public.resume_incomplete_game_review(uuid,uuid,uuid)','execute')
    or has_function_privilege('authenticated','public.resume_incomplete_game_review(uuid,uuid,uuid)','execute')
    or has_function_privilege('anon','public.resume_oversized_game_specification(uuid,uuid,uuid)','execute')
    or has_function_privilege('authenticated','public.resume_oversized_game_specification(uuid,uuid,uuid)','execute')
 then raise exception 'Recovery RPCs exposed to browser callers';end if;
end $$;

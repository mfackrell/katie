-- Behavioral integration acceptance for guarded specification resumes, rolled back
-- to leave the existing test fixtures and usage counters untouched.
do $$
declare p work_projects; m agent_missions; r mission_assignments; c jsonb; charged bigint; scenario text; ok boolean; n integer; continuation uuid; claim_job uuid;
begin
 select * into strict p from work_projects where id='44444444-4444-4444-8444-444444444444';
 select * into strict m from agent_missions where id=p.active_mission_id;
 foreach scenario in array array['review_valid','review_low_capacity','review_wrong_actor','review_wrong_chat','review_no_budget','review_no_missions','review_expired','review_unapproved_project'] loop
  begin
   update work_projects set status='blocked',phase='specification',profile='game',
    approval_hash=null,approved_hash=null,spec=null,token_allowance=600000,
    deadline=now()+interval '2 days',lease=null,lease_until=null,
    active_mission_id=m.id where id=p.id;
   update agent_missions set project_kind='specification',status='blocked',
    calls=2,routing_calls=1,actual_tokens=1000,reserved_tokens=1500,project_evidence='{"projectProfile":"game"}',
    deadline=now()+interval '90 minutes' where id=m.id;
   update mission_assignments set status='completed',lease=null,lease_until=null where mission_id=m.id;
   update mission_assignments set result='{"text":"Complete saved independently reviewed candidate specification"}'::jsonb,
    status='completed',dependencies='{}' where mission_id=m.id and job_key='compose';
   update mission_assignments set status='failed',attempts=4,
    result='{"detail":"Model output incomplete: incomplete"}'::jsonb,
    detail='Model output incomplete: incomplete' where mission_id=m.id and role='review'
    returning * into r;
   if not found then raise exception 'Review fixture assignment missing';end if;
   if scenario='review_no_budget' then update work_projects set token_allowance=60000 where id=p.id;update agent_missions set reserved_tokens=60000 where id=m.id;end if;
   if scenario='review_no_missions' then update work_projects set max_missions=(select count(*) from project_runs where project_id=p.id) where id=p.id;end if;
   if scenario='review_expired' then update agent_missions set deadline=now()-interval '2 minutes' where id=m.id;end if;
   if scenario='review_low_capacity' then
    update agent_missions set reserved_tokens=60000 where id=m.id;
    update work_projects set token_allowance=(select sum(greatest(actual_tokens,reserved_tokens))+10000 from agent_missions where project_id=p.id) where id=p.id;
   end if;
   if scenario='review_unapproved_project' then update work_projects set approval_hash=repeat('a',64) where id=p.id;end if;
   select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into charged from agent_missions where project_id=p.id;
   ok:=resume_incomplete_game_review(p.id,
     case when scenario='review_wrong_actor' then gen_random_uuid() else p.actor_id end,
     case when scenario='review_wrong_chat' then gen_random_uuid() else p.chat_id end);
   if scenario in ('review_valid','review_expired','review_low_capacity') then
    if not ok then raise exception 'Valid review did not resume';end if;
    select active_mission_id into continuation from work_projects where id=p.id;
    if continuation=m.id then raise exception 'Expired source was reset rather than continued';end if;
    if (select attempts from mission_assignments where id=r.id)<>4
      or (select status from agent_missions where id=m.id)<>'blocked'
      or (select status from mission_assignments where id=r.id)<>'failed' then raise exception 'Source history changed';end if;
    if (select status from work_projects where id=p.id)<>'running'
      or (select approved_hash from work_projects where id=p.id) is not null
      or (select approval_hash from work_projects where id=p.id) is not null then raise exception 'Unsafe review resume state';end if;
    if (select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) from agent_missions where project_id=p.id)<>charged then raise exception 'Review recovery altered charges';end if;
    if resume_incomplete_game_review(p.id,p.actor_id,p.chat_id) then raise exception 'Duplicate review recovery admitted';end if;
    c:=claim_mission_work();claim_job:=(c->'job'->>'id')::uuid;
    if c is null or c->'job'->>'role'<>'review' or (c->'mission'->>'id')::uuid<>continuation then raise exception 'Saved review not claimable';end if;
    if scenario='review_low_capacity' then
     if reserve_mission_call(claim_job,(c->'job'->>'lease')::uuid,gen_random_uuid(),'unaffordable-review',12000) then raise exception 'Unaffordable request admitted';end if;
     if exists(select 1 from project_events where project_id=p.id and event='review_continuation_dispatched') then raise exception 'Denied admission spent dispatch marker';end if;
     perform commit_mission_work(claim_job,(c->'job'->>'lease')::uuid,'{"admissionDenied":true,"remainingTokens":10000,"detail":"No eligible model request fits"}', '[]','failed','blocked');
     update work_projects set status='blocked' where id=p.id;
     if resume_pending_game_review(p.id,p.actor_id,p.chat_id) then raise exception 'Unchanged denial was retried';end if;
     update work_projects set token_allowance=token_allowance+20000 where id=p.id;
     if not resume_pending_game_review(p.id,p.actor_id,p.chat_id) then raise exception 'Pending continuation was permanently consumed';end if;
     if (select active_mission_id from work_projects where id=p.id)<>continuation then raise exception 'Pending recovery created another child';end if;
     c:=claim_mission_work();claim_job:=(c->'job'->>'id')::uuid;
    end if;
    if not reserve_mission_call(claim_job,(c->'job'->>'lease')::uuid,gen_random_uuid(),'fixture-review',10000) then raise exception 'Continued review cannot reserve';end if;
    if (select result->>'text' from mission_assignments where mission_id=continuation and job_key='compose')<>'Complete saved independently reviewed candidate specification' then raise exception 'Saved candidate changed';end if;
    -- Inject an independently approved worker result; project progression still
    -- stops at the exact explicit coding approval gate, never development.
    if not commit_mission_work(claim_job,(c->'job'->>'lease')::uuid,'{"verdict":"pass","detail":"Independent criteria and candidate checked"}',
       '[]','completed','completed','Complete saved independently reviewed candidate specification') then raise exception 'Review result not committed';end if;
    c:=claim_work_project();
    if not finish_work_project(p.id,(c->>'lease')::uuid,'spec',jsonb_build_object('baseline',repeat('a',40),'spec',jsonb_build_object('name','Fixture','summary','Saved candidate','requirements',jsonb_build_array('Original exact requirement'),'allowedPaths',jsonb_build_array('app/pilot/'),'milestones','[]'::jsonb,'finalContract',jsonb_build_object('path','/pilot','scenarios','[]'::jsonb)))) then raise exception 'Reviewed specification cannot progress';end if;
    if (select status from work_projects where id=p.id)<>'awaiting_approval' or (select approved_hash from work_projects where id=p.id) is not null then raise exception 'Coding approval bypassed';end if;
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
   if scenario='oversized_budget' then
     update work_projects set token_allowance=60000 where id=p.id;
     update agent_missions set reserved_tokens=60000 where id=m.id;
   end if;
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
 if has_function_privilege('anon','public.resume_pending_game_review(uuid,uuid,uuid)','execute')
    or has_function_privilege('authenticated','public.resume_pending_game_review(uuid,uuid,uuid)','execute')
    or has_function_privilege('anon','public.resume_incomplete_game_review(uuid,uuid,uuid)','execute')
    or has_function_privilege('authenticated','public.resume_incomplete_game_review(uuid,uuid,uuid)','execute')
    or has_function_privilege('anon','public.resume_oversized_game_specification(uuid,uuid,uuid)','execute')
    or has_function_privilege('authenticated','public.resume_oversized_game_specification(uuid,uuid,uuid)','execute')
 then raise exception 'Recovery RPCs exposed to browser callers';end if;
end $$;

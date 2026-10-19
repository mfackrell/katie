-- Explicit user Resume repairs each saved validation failure once within unchanged mission calls/tokens/deadlines.
-- Automatic validation attempts remain capped at three; user-requested repair never resets usage or approval.
create or replace function public.retry_game_specification(p_id uuid,p_actor uuid,p_chat uuid) returns boolean
language plpgsql security invoker set search_path=public as $$
declare p work_projects;m agent_missions;j mission_assignments;charged bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if not found or p.status<>'blocked' or p.phase<>'specification' or p.profile<>'game' or p.deadline<=now() or p.active_mission_id is null then return false;end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 if not found or m.status<>'blocked' or m.project_kind<>'specification' or m.repository_id is not null or m.project_evidence->>'projectProfile' is distinct from 'game' or m.deadline<=now() or m.calls>=m.max_calls or greatest(m.reserved_tokens,m.actual_tokens)>=m.token_allowance then return false;end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into charged from agent_missions where project_id=p.id;
 if charged>=p.token_allowance then return false;end if;
 select * into j from mission_assignments a where mission_id=m.id and role in ('compose','revise') and status='failed' and (
  (attempts=1 and result->>'detail'='Model output incomplete: incomplete' and (result->>'incompleteReason' is null or result->>'incompleteReason'='max_output_tokens')) or
  (attempts>=2 and attempts<m.max_calls and length(coalesce(result->>'rejectedSpecification','')) between 1 and 200000 and length(coalesce(result->>'specificationValidationFeedback',''))>0
   and not exists(select 1 from project_events e where e.project_id=p.id and e.event='game_specification_validation_retry' and e.data->>'jobId'=a.id::text and coalesce((e.data->>'attemptsUsed')::integer,a.attempts)=a.attempts)) or
  (attempts=2 and result->>'specificationValidationFeedback' like 'Specification exceeds the bounded approval/evidence package;%'
   and exists(select 1 from project_events e where e.project_id=p.id and e.event='game_specification_output_retry' and e.data->>'jobId'=a.id::text)
   and not exists(select 1 from project_events e where e.project_id=p.id and e.event='game_specification_validation_retry' and e.data->>'jobId'=a.id::text))
 ) order by created_at limit 1 for update;
 if not found then return false;end if;
 update mission_assignments set status='queued',lease=null,lease_until=null,available_at=now(),detail=case when j.attempts>=2 then 'Repairing the saved validation failure with its rejected draft and actionable feedback.' when j.result->>'incompleteReason' is null then 'Explicitly resumed legacy specification; original provider stop reason is unknown.' else 'Retrying the output-limited game specification with bounded compact JSON.' end,updated_at=now() where id=j.id;
 update agent_missions set status='running',detail='Retrying the incomplete specification; all prior usage remains charged.',updated_at=now() where id=m.id;
 update work_projects set status='running',lease=null,lease_until=null,detail=case when j.attempts>=2 then 'Repairing the saved specification once; all prior attempts, calls, charges and limits remain.' when j.result->>'incompleteReason' is null then 'Explicit Resume accepted for the saved legacy specification. Its original provider stop reason remains unknown; prior work, charges and limits remain.' else 'Completing the saved game specification; prior work, charges and limits remain.' end,updated_at=now() where id=p.id returning * into p;
 insert into project_events(project_id,event,data) values(p.id,case when j.attempts>=2 then 'game_specification_validation_retry' else 'game_specification_output_retry' end,jsonb_build_object('missionId',m.id,'jobId',j.id,'attemptsUsed',j.attempts,'chargedTokens',charged,'trigger','explicit_resume','classification',case when j.attempts>=2 then case when j.result->>'rejectedSpecification' is not null then 'saved_specification_validation' else 'shared_contract_size_validation' end when j.result->>'incompleteReason' is null then 'legacy_unknown_explicit_resume' else 'max_output_tokens' end,'sourceIncompleteReason',j.result->>'incompleteReason'));
 perform project_publish(p.id,p.detail);return true;
end $$;
revoke all on function public.retry_game_specification(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.retry_game_specification(uuid,uuid,uuid) to service_role;

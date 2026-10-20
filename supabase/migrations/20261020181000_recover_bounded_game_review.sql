create or replace function public.recover_bounded_game_review(p_id uuid)
returns boolean language plpgsql set search_path=public as $$
declare p work_projects; m agent_missions; j mission_assignments; charge bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id for update;
 if not found or p.status<>'blocked' or p.profile<>'game' or p.phase<>'specification'
   or p.approved_hash is not null or p.active_mission_id is null or p.deadline<=now() then return false; end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 if not found or m.status<>'blocked' or m.project_kind<>'specification'
   or m.deadline<=now() or m.calls>=m.max_calls or greatest(m.reserved_tokens,m.actual_tokens)>=m.token_allowance then return false;end if;
 select * into j from mission_assignments where mission_id=m.id and role='review'
   and status='failed' and attempts=1 and detail='Mission evidence exceeds bounded context. Narrow the objective or deliverable.'
   for update;
 if not found or not exists(select 1 from mission_assignments where mission_id=m.id and job_key='compose' and status='completed') then return false;end if;
 if exists(select 1 from project_events where project_id=p.id and event='bounded_game_review_recovered') then return false;end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into charge from agent_missions where project_id=p.id;
 if p.token_allowance-charge<10000 then return false;end if;
 update mission_assignments set status='queued',lease=null,lease_until=null,available_at=now(),
   detail='Retrying exact saved candidate with bounded independent review evidence.',
   result=coalesce(result,'{}'::jsonb)||jsonb_build_object('reviewPhase','comparison','boundedContextRetry',true),
   updated_at=now() where id=j.id;
 update agent_missions set status='running',detail='Rechecking saved specification against original requirements with bounded review context.',updated_at=now() where id=m.id;
 update work_projects set status='running',lease=null,lease_until=null,failures=0,
   detail='Independent review resumed on the same candidate. Original drafts, research and charges unchanged.',
   updated_at=now() where id=p.id;
 insert into project_events(project_id,event,data) values(p.id,'bounded_game_review_recovered',
   jsonb_build_object('missionId',m.id,'reviewJobId',j.id,'chargedTokens',charge));
 perform project_publish(p.id,'Independent review resumed with bounded evidence, unchanged candidate and original budget.');
 return true;
end $$;
revoke all on function public.recover_bounded_game_review(uuid) from public,anon,authenticated;

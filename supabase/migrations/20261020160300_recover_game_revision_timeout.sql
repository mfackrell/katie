-- Game specification timeout recovery, retains all saved work and usage.
CREATE OR REPLACE FUNCTION public.recover_game_revision_timeout(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare p work_projects; m agent_missions; rev mission_assignments; prior_review mission_assignments;
        charged bigint; run_count integer; findings text;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id for update;
 if not found or p.status<>'blocked' or p.phase<>'specification' or p.profile<>'game'
   or p.active_mission_id is null or p.deadline<=now()+interval '20 minutes'
   or p.approved_hash is not null then return false; end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 if not found or m.status<>'blocked' or m.project_kind<>'specification' then return false; end if;
 select * into rev from mission_assignments where mission_id=m.id and job_key='revision'
   and role='revise' and status='failed' and attempts>=2
   and lower(coalesce(detail,result->>'detail','')) ~ '(timed out|timeout)' for update;
 if not found then return false;end if;
 select * into prior_review from mission_assignments where mission_id=m.id
   and job_key='review' and role='review' and status='completed'
   and result->>'verdict'='changes_requested';
 if not found or not exists(select 1 from mission_assignments
     where mission_id=m.id and job_key='compose' and status='completed') then return false;end if;
 if exists(select 1 from public.project_events where project_id=p.id
     and event='game_revision_timeout_recovered') then return false;end if;
 select count(*) into run_count from project_runs where project_id=p.id;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into charged
   from agent_missions where project_id=p.id;
 if run_count>=p.max_missions or p.token_allowance-charged<40000 then return false;end if;
 findings:=left(coalesce(prior_review.result->>'findings',''),2200);
 update work_projects set status='running',phase='specification',
  active_mission_id=null,lease=null,lease_until=null,failures=0,
  detail='Recovering timed-out saved game specification revision. Reviewed research, prior draft, review findings, limits and usage remain preserved.',
  updated_at=now() where id=p.id;
 insert into project_events(project_id,event,data)
 values(p.id,'game_revision_timeout_recovered',
    jsonb_build_object('sourceMissionId',m.id,'revisionJobId',rev.id,
     'priorDraftJobId',(select id from mission_assignments where mission_id=m.id and job_key='compose'),
     'findings',findings,'chargedTokens',charged,
     'remainingTokens',p.token_allowance-charged,'retryScope','same_project_specification_only'));
 perform project_publish(p.id,'Timed-out game specification revision recovered. Research and spending history preserved; specification will be rechecked independently before scope approval.');
 return true;
end $function$
;
revoke all on function public.recover_game_revision_timeout(uuid) from public,anon,authenticated;

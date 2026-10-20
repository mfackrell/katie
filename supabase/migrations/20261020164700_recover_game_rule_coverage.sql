create or replace function public.recover_game_rule_coverage(p_id uuid)
returns boolean language plpgsql set search_path=public as $$
declare p work_projects; m agent_missions; rev mission_assignments; review mission_assignments; spent bigint; n integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id for update;
 if not found or p.status<>'blocked' or p.phase<>'specification' or p.profile<>'game'
    or p.active_mission_id is null or p.approved_hash is not null
    or p.deadline<=now()+interval '20 minutes' then return false;end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 if not found or m.status<>'blocked' or m.project_kind<>'specification' then return false;end if;
 select * into rev from mission_assignments where mission_id=m.id
   and job_key='revision' and role='revise' and status='failed' and attempts>=3
   and lower(coalesce(result->>'specificationValidationFeedback',detail,'')) like '%missing acceptance coverage%'
   and length(coalesce(result->>'rejectedSpecification',''))>0 for update;
 if not found then return false;end if;
 select * into review from mission_assignments where mission_id=m.id and role='review'
   and job_key='review' and status='completed' and result->>'verdict'='changes_requested';
 if not found or not exists(select 1 from mission_assignments
   where mission_id=m.id and job_key='compose' and status='completed') then return false;end if;
 if exists(select 1 from project_events where project_id=p.id and event='game_rule_coverage_recovered') then return false;end if;
 select count(*) into n from project_runs where project_id=p.id;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into spent
 from agent_missions where project_id=p.id;
 if n>=p.max_missions or p.token_allowance-spent<40000 then return false;end if;
 update work_projects set status='running',phase='specification',
 active_mission_id=null,lease=null,lease_until=null,failures=0,
 detail='Recovering specific uncovered game rules from the saved rejected draft; prior research and charges retained.',
 updated_at=now() where id=p.id;
 insert into project_events(project_id,event,data) values(p.id,'game_rule_coverage_recovered',
 jsonb_build_object('sourceMissionId',m.id,'revisionJobId',rev.id,
 'findings',left(coalesce(rev.result->>'specificationValidationFeedback',''),1100),
 'chargedTokens',spent,'scope','specification_only'));
 perform project_publish(p.id,'Targeted game acceptance coverage repair scheduled. Previous draft, research and token charges preserved; independent review and approval still required.');
 return true;
end $$;
revoke all on function public.recover_game_rule_coverage(uuid) from public,anon,authenticated;

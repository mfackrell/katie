-- Resume only the specification stage from independently approved research.
-- Guard all project-level permissions, historical charges and attempt limits.
create or replace function public.resume_oversized_game_specification(p_id uuid,p_actor uuid,p_chat uuid)
returns boolean language plpgsql set search_path to 'public' as $$
declare p public.work_projects; charged bigint; runs_used int;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if not found or p.status<>'blocked' or p.profile<>'game' or p.phase<>'specification'
   or p.active_mission_id is not null or p.spec is not null
   or p.approval_hash is not null or p.approved_hash is not null
   or p.deadline<=now()+interval '30 minutes'
   or p.detail not like '%Project milestone context exceeds its bounded input%'
 then return false;end if;
 if exists(select 1 from public.project_events where project_id=p.id and event='oversized_game_specification_resumed') then return false;end if;
 if not exists(select 1 from public.project_runs r join public.agent_missions m on m.id=r.mission_id
  where r.project_id=p.id and r.kind='research' and m.status='completed'
    and r.outcome is not null and coalesce((r.outcome->>'superseded')::boolean,false)=false)
 then return false;end if;
 select count(*) into runs_used from public.project_runs where project_id=p.id;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into charged from public.agent_missions where project_id=p.id;
 if runs_used>=p.max_missions or p.token_allowance-charged<30000 then return false;end if;
 update public.work_projects set status='running',lease=null,lease_until=null,failures=0,
  detail='Resuming specification from saved independently reviewed research with original instructions stored losslessly as mission evidence. Previous attempts and charges retained.',
  updated_at=now() where id=p.id;
 insert into public.project_events(project_id,event,data) values(p.id,'oversized_game_specification_resumed',
  jsonb_build_object('reviewedResearchRetained',true,'chargedTokens',charged,'remainingTokens',p.token_allowance-charged,
   'priorRuns',runs_used,'codingApproved',false));
 perform public.project_publish(p.id,'Oversized specification context repaired; resuming from original reviewed research with original budget.');
 return true;
end;$$;

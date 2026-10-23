-- Resume only after an independently recorded, scoped owner authorization.
-- Immutable earlier missions and charges are never reset or reclassified.
create or replace function public.resume_authorized_game_project(p_id uuid)
returns boolean language plpgsql security invoker set search_path=public as $fn$
declare p work_projects; charged bigint; runs_used integer; latest_approval project_events;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id for update;
 if not found or p.status<>'blocked' or p.profile<>'game' or p.phase<>'specification'
   or p.approved_hash is not null or p.budget_authorization_source<>'user_approved'
   or p.deadline<=now()+interval '30 minutes' then return false; end if;
 select * into latest_approval from project_events where project_id=p.id
   and event='resource_authorization' and (data->>'newAllowance')::bigint>(data->>'oldAllowance')::bigint
   order by created_at desc limit 1;
 if not found or latest_approval.data->>'approvalRef' is null then return false; end if;
 if exists(select 1 from project_events where project_id=p.id
   and event='developer_budget_recovery_started'
   and data->>'approvalRef'=latest_approval.data->>'approvalRef') then return false; end if;
 if p.active_mission_id is null or not exists(select 1 from agent_missions
   where id=p.active_mission_id and project_id=p.id and status='blocked') then return false; end if;
 if not exists(select 1 from mission_assignments a join agent_missions m on m.id=a.mission_id
   where m.project_id=p.id and m.project_kind='specification' and a.role='compose'
   and a.status='completed' and length(coalesce(a.result->>'text',''))>100)
 then return false;end if;
 select count(*) into runs_used from project_runs where project_id=p.id;
 select coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0)
   into charged from agent_missions where project_id=p.id;
 if runs_used>=p.max_missions or p.token_allowance-charged<25000 then return false; end if;
 update work_projects set status='running',active_mission_id=null,lease=null,lease_until=null,
   failures=0,detail='Developer Orchestrator resuming saved specification after explicit resource authorization. Prior work and charges preserved; independent review remains required.',
   updated_at=now() where id=p.id;
 insert into project_events(project_id,event,data) values(p.id,'developer_budget_recovery_started',
   jsonb_build_object('approvalRef',latest_approval.data->>'approvalRef','chargedTokens',charged,
    'originalMissionId',p.active_mission_id,'priorRuns',runs_used,'codingApproved',false));
 perform project_publish(p.id,'Developer Orchestrator resumed saved specification after owner-approved resources. Independent review remains mandatory.');
 return true;
end $fn$;
revoke all on function public.resume_authorized_game_project(uuid) from public,anon,authenticated;
grant execute on function public.resume_authorized_game_project(uuid) to service_role;

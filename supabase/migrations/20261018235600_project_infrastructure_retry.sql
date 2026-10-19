-- Operator-mediated retry of a blocked, independently reviewed development job.
-- Preserves the approved scope, prior immutable evidence, all charges, and
-- the original stopped mission. A retry starts a NEW bounded mission.
create function public.retry_project_infrastructure(
 p_id uuid,p_actor uuid,p_chat uuid,p_expected_mission uuid,p_expected_run bigint
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare p work_projects;m agent_missions;j mission_assignments;r project_runs;charged bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if not found or p.status<>'blocked' or p.phase<>'development' or
    p.active_mission_id is distinct from p_expected_mission or
    p.approved_hash is null or p.approved_hash is distinct from p.approval_hash or
    p.deadline<=now() or p.cycles>=p.max_cycles or p.spec is null then return null;end if;
 select * into m from agent_missions where id=p_expected_mission and project_id=p.id for update;
 if not found or m.status<>'blocked' or m.project_kind<>'development' then return null;end if;
 select * into r from project_runs where project_id=p.id and mission_id=m.id and kind='development' for update;
 if not found or r.outcome is not null or r.milestone_index<>p.milestone_index or
    r.binding->>'scopeHash' is distinct from p.approved_hash then return null;end if;
 if (select count(*) from project_runs where project_id=p.id)>=p.max_missions or
    (select count(*) from project_runs where project_id=p.id and kind='development' and milestone_index=p.milestone_index)>=2
 then return null;end if;
 select * into j from mission_assignments where mission_id=m.id and role='development' and status='failed'
   and (result->'external'->'receipt'->>'run_id')::text=p_expected_run::text
   and result->'external'->'receipt'->>'outcome'='BLOCKED'
   and result->'external'->'receipt'->'checks'->>'test'='false'
   and result->'external'->'receipt'->'checks'->>'review'='pass'
   and result->'external'->'receipt'->'checks'->>'repair'='failure'
 order by created_at limit 1 for update;
 if not found then return null;end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into charged
 from agent_missions where project_id=p.id;
 if charged+8000>p.token_allowance then return null;end if;
 update project_runs set outcome=jsonb_build_object(
   'infrastructure_retry',true,'original_run',p_expected_run,'original_mission',m.id,
   'reason','Failed verification and repair; operator verified infrastructure failure'
 ) where id=r.id and outcome is null;
 update work_projects set status='running',active_mission_id=null,lease=null,lease_until=null,
   detail='Retrying approved development after verification environment repair. All original costs and failed evidence remain saved.',
   updated_at=now() where id=p.id returning * into p;
 insert into project_events(project_id,event,data) values(p.id,'infrastructure_retry',
   jsonb_build_object('mission_id',m.id,'run',p_expected_run,'charged_tokens',charged,'milestone_index',p.milestone_index));
 perform project_publish(p.id,p.detail);
 return to_jsonb(p);
end $$;
revoke all on function public.retry_project_infrastructure(uuid,uuid,uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.retry_project_infrastructure(uuid,uuid,uuid,uuid,bigint) to service_role;

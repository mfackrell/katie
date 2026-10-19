-- Preserve mission fencing, review, permissions and cost controls while allowing three independent workers plus review and revision.
create or replace function public.commit_mission_work(p_id uuid,p_lease uuid,p_result jsonb,p_children jsonb default '[]',p_status text default 'completed',p_mission_status text default null,p_final text default null) returns boolean
language plpgsql security invoker set search_path=public as $$
declare j mission_assignments;m agent_missions;c jsonb; n integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_id;
 if not found then return false; end if;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into j from mission_assignments where id=p_id for update;
 if m.status not in ('running','awaiting_approval') or m.deadline<=now() or j.status<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then return false; end if;
 if p_status not in ('completed','waiting_external','awaiting_approval','failed','queued') or (p_mission_status is not null and p_mission_status not in ('completed','blocked','awaiting_approval')) then raise exception 'Invalid outcome'; end if;
 if jsonb_typeof(p_children)<>'array' or jsonb_array_length(p_children)>6 then raise exception 'Invalid children'; end if;
 n:=(select count(*) from mission_assignments where mission_id=m.id and role<>'plan');
 if n+jsonb_array_length(p_children)>8 then raise exception 'Assignment limit reached'; end if;
 for c in select value from jsonb_array_elements(p_children) loop
  if not exists(select 1 from jsonb_array_elements(m.team) a where a->>'id'=c->>'agent_id') then raise exception 'Agent outside saved team'; end if;
  insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload)
  values(m.id,c->>'key',c->>'role',(c->>'agent_id')::uuid,c->>'instruction',array(select jsonb_array_elements_text(coalesce(c->'dependencies','[]'))),coalesce(c->'payload','{}'));
 end loop;
 -- Every dependency must be in this mission. Planner validates acyclicity too.
 if exists(select 1 from mission_assignments a,unnest(a.dependencies) d where a.mission_id=m.id and (d=a.job_key or not exists(select 1 from mission_assignments b where b.mission_id=m.id and b.job_key=d))) then raise exception 'Invalid dependency'; end if;
 if p_status='awaiting_approval' then perform public.prepare_mission_development(j.id,p_lease);p_mission_status:='awaiting_approval'; end if;
 update mission_assignments set status=p_status,result=p_result,detail=p_result->>'detail',lease=null,lease_until=null,available_at=now()+interval '1 minute',updated_at=now() where id=j.id;
 if p_status='failed' then p_mission_status:='blocked'; end if;
 if p_mission_status='completed' and (j.role<>'review' or p_result->>'verdict' is distinct from 'pass' or p_status<>'completed' or coalesce(length(p_final),0)=0 or exists(select 1 from mission_assignments where mission_id=m.id and status<>'completed')) then raise exception 'Verified deliverable required'; end if;
 update agent_missions set status=coalesce(p_mission_status,status),result=coalesce(p_final,result),detail=coalesce(p_result->>'detail',detail),updated_at=now() where id=m.id;
 return true;
end $$;

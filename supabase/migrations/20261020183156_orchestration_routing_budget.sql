-- Routing uses the same fenced token ledger, with a separate bounded call
-- allowance so model selection does not consume the worker execution slots.
-- No increase to mission/project token budgets or existing worker-call limits.
alter table public.agent_missions add column if not exists routing_calls integer not null default 0 check(routing_calls>=0);
create or replace function public.reserve_mission_routing_call(p_id uuid,p_lease uuid,p_call uuid,p_model text,p_tokens integer) returns boolean
language plpgsql security invoker set search_path=public as $$
declare j mission_assignments;m agent_missions;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_id;
 if not found then return false; end if;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into j from mission_assignments where id=p_id for update;
 if m.project_id is not null and not exists(select 1 from work_projects p where p.id=m.project_id and p.status='running' and p.active_mission_id=m.id and p.deadline>now()) then return false;end if;
 if m.status not in ('running','awaiting_approval') or m.deadline<=now() or j.status<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then return false; end if;
 if p_tokens not between 1 and 120000 or exists(select 1 from mission_calls where id=p_call) then return false; end if;
 if m.routing_calls>=m.max_calls*3 or greatest(m.reserved_tokens,m.actual_tokens)+p_tokens>m.token_allowance then
  update agent_missions set status='blocked',detail='Routing-call or reserved token allowance exhausted. Inspect partial results.',updated_at=now() where id=m.id;
  return false;
 end if;
 if m.project_id is not null and (select coalesce(sum(greatest(reserved_tokens,actual_tokens)),0) from agent_missions where project_id=m.project_id)+p_tokens>(select token_allowance from work_projects where id=m.project_id) then update work_projects set status='blocked',detail='Total project model-token allowance exhausted; previous usage remains charged.' where id=m.project_id;perform project_publish(m.project_id,'The project model-token allowance is exhausted. Partial work and charges are preserved; this project is not complete.');return false;end if;
 insert into mission_calls(id,job_id,lease,model,reserved_tokens) values(p_call,j.id,p_lease,p_model,p_tokens);
 update agent_missions set routing_calls=routing_calls+1,reserved_tokens=reserved_tokens+p_tokens,updated_at=now() where id=m.id;
 update mission_assignments set heartbeat_at=now(),lease_until=now()+interval '6 minutes' where id=j.id;
 return true;
end $$;

revoke all on function public.reserve_mission_routing_call(uuid,uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.reserve_mission_routing_call(uuid,uuid,uuid,text,integer) to service_role;

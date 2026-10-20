create or replace function public.recover_mission_credit_failure(p_id uuid)
returns boolean language plpgsql set search_path=public as $$
declare p work_projects; m agent_missions; j mission_assignments; charged bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id for update;
 if not found or p.status<>'blocked' or p.active_mission_id is null or p.deadline<=now() or p.approved_hash is not null then return false;end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 if not found or m.status<>'blocked' or m.deadline<=now() or m.calls>=m.max_calls or greatest(m.reserved_tokens,m.actual_tokens)>=m.token_allowance then return false;end if;
 select * into j from mission_assignments where mission_id=m.id and status='failed'
   and role in ('review','compose','revise','work','plan')
   and (coalesce(detail,'') ilike '%no credits remaining%' or coalesce(detail,'') ilike '%insufficient_quota%')
   order by updated_at desc limit 1 for update;
 if not found then return false;end if;
 if exists(select 1 from project_events where project_id=p.id and event='mission_credit_fallback_recovered' and data->>'jobId'=j.id::text) then return false;end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into charged from agent_missions where project_id=p.id;
 if p.token_allowance-charged<8000 then return false;end if;
 update mission_assignments set status='queued',lease=null,lease_until=null,available_at=now(),
  result=coalesce(result,'{}'::jsonb)||jsonb_build_object('creditFailureRecovery',true),
  detail='Retrying saved assignment with cross-provider credit fallback; original evidence preserved.',updated_at=now() where id=j.id;
 update agent_missions set status='running',detail='Resuming existing assignment after provider credit failure.',updated_at=now() where id=m.id;
 update work_projects set status='running',lease=null,lease_until=null,failures=0,
 detail='Resuming exact saved assignment with configured model provider fallback.',updated_at=now() where id=p.id;
 insert into project_events(project_id,event,data) values(p.id,'mission_credit_fallback_recovered',
  jsonb_build_object('jobId',j.id,'missionId',m.id,'chargedTokens',charged));
 perform project_publish(p.id,'Model-credit failure recovery queued on the original work and original budget.');
 return true;
end $$;
revoke all on function public.recover_mission_credit_failure(uuid) from public,anon,authenticated;